from copy import deepcopy
from dataclasses import replace
import itertools
import json
from pathlib import Path

import networkx as nx
import numpy as np
import pytest

from gridscout.beliefs import (conditional_failure_given_evidence, entropy,
                              expected_information_gain, observation_probability,
                              update_beliefs)
from gridscout.hazards import create_beliefs, create_environment
from gridscout.impact import line_impacts, sample_posterior_failures
from gridscout.models import GridState, InspectionAction, Observation, ScenarioConfig
from gridscout.network import (build_grid, evaluate_supplied_load, lines,
                               potential_restoration_impact)
from gridscout.observations import observe


@pytest.fixture
def scenario():
    grid, config = build_grid(), ScenarioConfig()
    return grid, config, create_beliefs(grid, config)


def test_graph_contains_no_hidden_truth(scenario):
    grid, _, beliefs = scenario
    assert len(grid.graph) == 22 and len(lines(grid)) == 21
    assert nx.is_tree(grid.graph)
    assert set(lines(grid)) == set(beliefs.line_probabilities)
    for _, _, attrs in grid.graph.edges(data=True):
        assert not ({"failed", "true_failure", "hidden_state", "observation_uniform"} & attrs.keys())


def test_bayesian_normalization_and_monotonic_evidence(scenario):
    _, config, beliefs = scenario
    for positive in (False, True):
        updated = update_beliefs(beliefs, Observation("L02", positive), config.sensitivity, config.specificity)
        assert all(sum(p) == pytest.approx(1) for p in updated.zone_severity.values())
        assert all(0 <= p <= 1 for p in updated.line_probabilities.values())
        assert (updated.line_probabilities["L02"] > beliefs.line_probabilities["L02"]) == positive
        # Neighbor shares the latent zone and inherits directional evidence.
        assert (updated.line_probabilities["L05"] > beliefs.line_probabilities["L05"]) == positive
        assert updated.line_probabilities["L04"] == beliefs.line_probabilities["L04"]


def test_exact_single_observation_matches_bayes(scenario):
    _, config, beliefs = scenario
    prior = beliefs.line_probabilities["L02"]
    expected = prior * config.sensitivity / observation_probability(beliefs, "L02", config.sensitivity, config.specificity)
    updated = update_beliefs(beliefs, Observation("L02", True), config.sensitivity, config.specificity)
    assert updated.line_probabilities["L02"] == pytest.approx(expected)


def test_evidence_is_not_double_counted_or_mutated(scenario):
    _, config, beliefs = scenario
    original = deepcopy(beliefs)
    once = update_beliefs(beliefs, Observation("L02", True), config.sensitivity, config.specificity)
    twice = update_beliefs(once, Observation("L02", True, observation_id="replayed"), config.sensitivity, config.specificity)
    assert twice == once
    assert beliefs == original
    assert twice is not once


def test_inspected_probability_reconditions_on_other_evidence(scenario):
    _, config, beliefs = scenario
    observations = [Observation("L02", True), Observation("L05", False)]
    results = []
    for ordering in itertools.permutations(observations):
        current = beliefs
        for obs in ordering:
            current = update_beliefs(current, obs, config.sensitivity, config.specificity)
        results.append(current)
    assert results[0].line_probabilities == pytest.approx(results[1].line_probabilities)
    # Enumerate F02, F05, severity to independently validate posterior F02.
    numerator = denominator = 0.0
    zone = beliefs.line_zones["L02"]
    for severity, zone_probability in enumerate(beliefs.prior_severity[zone]):
        for f2, f5 in itertools.product((False, True), repeat=2):
            p2, p5 = (beliefs.conditional_failure[line][severity] for line in ("L02", "L05"))
            mass = zone_probability * (p2 if f2 else 1 - p2) * (p5 if f5 else 1 - p5)
            mass *= config.sensitivity if f2 else 1 - config.specificity
            mass *= 1 - config.sensitivity if f5 else config.specificity
            denominator += mass
            numerator += mass * f2
    assert results[0].line_probabilities["L02"] == pytest.approx(numerator / denominator)


def test_information_gain_nonnegative_and_uninformative_sensor(scenario):
    _, config, beliefs = scenario
    info = expected_information_gain(beliefs, "L02", config.sensitivity, config.specificity)
    assert 0 < info < entropy(beliefs.zone_severity["West"])
    assert expected_information_gain(beliefs, "L02", .5, .5) == pytest.approx(0)
    updated = update_beliefs(beliefs, Observation("L02", True), config.sensitivity, config.specificity)
    assert expected_information_gain(updated, "L02", config.sensitivity, config.specificity) == 0


def test_uninformative_reports_leave_all_probabilities_unchanged(scenario):
    _, _, beliefs = scenario
    updated = beliefs
    for line, positive in (("L02", True), ("L05", False), ("L03", True)):
        updated = update_beliefs(updated, Observation(line, positive), .5, .5)
    assert updated.line_probabilities == pytest.approx(beliefs.line_probabilities)
    for zone in beliefs.zone_severity:
        assert updated.zone_severity[zone] == pytest.approx(beliefs.zone_severity[zone])


def test_perfect_reports_pin_line_truth_even_after_neighbor_evidence(scenario):
    _, _, beliefs = scenario
    updated = update_beliefs(beliefs, Observation("L02", True), 1, 1)
    updated = update_beliefs(updated, Observation("L05", False), 1, 1)
    assert updated.line_probabilities["L02"] == pytest.approx(1)
    assert updated.line_probabilities["L05"] == pytest.approx(0)
    draws = sample_posterior_failures(updated, samples=100, sensitivity=1, specificity=1)
    assert all("L02" in failures and "L05" not in failures for failures in draws)


def test_preset_matches_default_config():
    path = Path(__file__).resolve().parents[1] / "scenarios" / "severe_storm.json"
    assert ScenarioConfig(**json.loads(path.read_text(encoding="utf-8"))) == ScenarioConfig()


def test_connectivity_and_multiple_fault_restoration(scenario):
    grid, config, _ = scenario
    intact = evaluate_supplied_load(grid)
    assert intact["disconnected_customers"] == 0
    cut = evaluate_supplied_load(grid, ["L01"])
    assert cut["supplied_kw"] == 0
    assert cut["disconnected_customers"] == intact["supplied_customers"]
    assert cut["critical_disconnected"] == 4
    impacts = line_impacts(grid, config)
    assert impacts["L01"].weighted == pytest.approx(1)
    # Repair of a downstream feeder cannot bypass an upstream break.
    assert potential_restoration_impact(grid, {"L01", "L02"}, "L02")["customers"] == 0


def test_redundant_paths_and_multiple_sources(scenario):
    grid, config, _ = scenario
    grid.graph.add_edge("SRC", "SUB", **grid.graph.edges["SRC", "SUB"])
    # Create an alternate route using a new intermediate node (simple graph).
    grid.graph.add_node("ALT", customers=0, demand_kw=0, critical=False)
    grid.graph.add_edge("SRC", "ALT", line_id="BACKUP1")
    grid.graph.add_edge("ALT", "SUB", line_id="BACKUP2")
    assert evaluate_supplied_load(grid, ["L01"])["unserved_kw"] == 0
    assert line_impacts(grid, config)["L01"].weighted == 0
    grid.sources = ("SRC", "SUB")
    assert evaluate_supplied_load(grid, ["L01", "BACKUP2"])["unserved_kw"] == 0


def test_scenarios_and_potential_observations_reproducible(scenario):
    grid, config, beliefs = scenario
    first = create_environment(grid, beliefs, config)
    second = create_environment(grid, beliefs, config)
    assert first == second
    changed = create_environment(grid, beliefs, replace(config, seed=config.seed + 1))
    assert changed.fingerprint != first.fingerprint
    action = InspectionAction("S1", "L02", 0, 10, 5, 5, 5, (0, 0))
    reordered = replace(action, sensor_id="S2", start_time=20, finish_time=30)
    assert observe(first, action, config).positive == observe(first, reordered, config).positive
    posterior = update_beliefs(beliefs, Observation("L02", True), config.sensitivity, config.specificity)
    # Environment generation uses the fixed initial prior, never a policy's posterior.
    assert create_environment(grid, posterior, config) == first


def test_joint_sampling_retains_zone_correlation_and_posterior(scenario):
    _, config, beliefs = scenario
    draws = sample_posterior_failures(beliefs, samples=12000, seed=12)
    first = np.array(["L02" in state for state in draws], dtype=float)
    second = np.array(["L05" in state for state in draws], dtype=float)
    assert np.mean(first) == pytest.approx(beliefs.line_probabilities["L02"], abs=.02)
    assert np.mean(first * second) - np.mean(first) * np.mean(second) > .01
    updated = update_beliefs(beliefs, Observation("L02", True), config.sensitivity, config.specificity)
    draws = sample_posterior_failures(updated, samples=12000, seed=13)
    assert np.mean(["L02" in state for state in draws]) == pytest.approx(updated.line_probabilities["L02"], abs=.02)
