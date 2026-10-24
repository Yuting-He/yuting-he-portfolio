"""Operational and benchmark integration tests independent of Streamlit."""
from copy import deepcopy
from dataclasses import asdict, replace
import inspect

import pytest

from gridscout.decisions import (POLICIES, expected_decision_value,
                                next_action_durations, rank_candidates)
from gridscout.evaluation import run_benchmark, summarize_results
from gridscout.models import BeliefState, InspectionAction, LineImpact, ScenarioConfig
from gridscout.network import lines
from gridscout.scheduler import assign, feasible_actions, inspection_action
from gridscout.simulation import auto_run, create_simulation, recommend, step


@pytest.mark.parametrize("policy", POLICIES)
def test_complete_mission_respects_limits_and_return_reserves(policy):
    config = ScenarioConfig(mission_minutes=45, endurance_minutes=40, seed=7)
    sim = auto_run(create_simulation(config), policy)
    assert sim.mission.finished
    assert 0 <= sim.mission.time <= config.mission_minutes + 1e-8
    assert len(sim.mission.completed) > 0
    inspected = [observation.line_id for observation in sim.mission.completed]
    assert len(inspected) == len(set(inspected))
    assert not sim.mission.pending
    assert len(sim.beliefs.observations) == len(inspected)
    for sensor in sim.mission.sensors:
        assert sensor.position == sim.grid.base_position
        assert sensor.status == "returned"
        assert sensor.remaining_endurance >= 0
        assert sensor.available_at <= config.mission_minutes + 1e-8
    for event in sim.mission.history:
        if event["type"] == "assignment":
            action = event["action"]
            assert action.finish_time + action.return_minutes <= config.mission_minutes + 1e-8


def test_simultaneous_assignment_is_unique_and_event_driven():
    sim = create_simulation(ScenarioConfig(sensor_count=4, mission_minutes=60))
    observations = step(sim)
    assignments = [event for event in sim.mission.history if event["type"] == "assignment"]
    assert len(assignments) == 4
    assert len({event["line_id"] for event in assignments}) == 4
    assert observations
    assert sim.mission.time == min(event["finish_time"] for event in assignments)
    assert len(sim.mission.pending) + len(observations) == 4


def test_recommendation_is_pure_including_random_policy():
    sim = create_simulation()
    before_beliefs = deepcopy(asdict(sim.beliefs))
    before_mission = deepcopy(asdict(sim.mission))
    before_rng = deepcopy(sim.rng.bit_generator.state)
    for policy in POLICIES:
        assert recommend(sim, policy) == recommend(sim, policy)
    assert asdict(sim.beliefs) == before_beliefs
    assert asdict(sim.mission) == before_mission
    assert sim.rng.bit_generator.state == before_rng


def test_hidden_environment_is_inaccessible_to_policy():
    sim = create_simulation()
    other = deepcopy(sim)
    other.environment.failures = {line_id: not failed for line_id, failed in sim.environment.failures.items()}
    other.environment.observation_uniforms = {line_id: 0.99 for line_id in sim.environment.failures}
    for policy in POLICIES:
        assert recommend(sim, policy) == recommend(other, policy)
    assert "environment" not in inspect.signature(rank_candidates).parameters
    assert "sim" not in inspect.signature(rank_candidates).parameters


def test_feasibility_rejects_mission_and_endurance_overrun():
    sim = create_simulation()
    sensor = sim.mission.sensors[0]
    line_id = next(iter(lines(sim.grid)))
    sensor.remaining_endurance = 0.01
    assert inspection_action(sim.grid, sensor, line_id, 0, sim.config) is None
    sensor.remaining_endurance = 100
    assert inspection_action(sim.grid, sensor, line_id, sim.config.mission_minutes - 0.01, sim.config) is None


def test_no_feasible_work_finishes_safely():
    sim = auto_run(create_simulation(ScenarioConfig(mission_minutes=0.1, endurance_minutes=0.1)))
    assert sim.mission.finished
    assert not sim.mission.completed
    assert sim.mission.time == 0


def test_exhausted_remote_sensor_returns_before_other_sensor_finishes():
    sim = create_simulation(ScenarioConfig(mission_minutes=10, endurance_minutes=30))
    remote, working = sim.mission.sensors
    remote.position = (4.8, 0.0)
    remote.remaining_endurance = 8.0  # Exactly enough to reach base now.
    line_id = "L01"
    destination = tuple(lines(sim.grid)[line_id]["midpoint"])
    # The second sensor finishes close to base after the first must depart.
    pending = InspectionAction(working.sensor_id, line_id, 0.0, 9.0,
                               0.8333333333, 8.1666666667, 0.8333333333, destination)
    assign(sim.mission, pending)
    auto_run(sim)
    assert remote.available_at == pytest.approx(8.0)
    assert sim.mission.time <= 10.0
    assert all(sensor.status == "returned" for sensor in sim.mission.sensors)


def test_returning_sensor_stays_at_last_stop_until_arrival_event():
    sim = create_simulation(ScenarioConfig(mission_minutes=10, endurance_minutes=30))
    remote, working = sim.mission.sensors
    last_stop = (4.8, 0.0)
    remote.position = last_stop
    remote.remaining_endurance = 8.0
    destination = tuple(lines(sim.grid)["L01"]["midpoint"])
    pending = InspectionAction(working.sensor_id, "L01", 0.0, 5.0,
                               0.8333333333, 4.1666666667, 0.8333333333, destination)
    assign(sim.mission, pending)
    assert step(sim)
    assert sim.mission.time == 5.0
    assert remote.available_at == pytest.approx(8.0)
    assert remote.status == "returning"
    assert remote.position == last_stop
    assert not any(event["type"] == "return_complete" and event["sensor_id"] == remote.sensor_id
                   for event in sim.mission.history)
    auto_run(sim)
    assert remote.status == "returned"
    assert remote.position == sim.grid.base_position
    arrival = next(event for event in sim.mission.history
                   if event["type"] == "return_complete" and event["sensor_id"] == remote.sensor_id)
    assert arrival["time"] == pytest.approx(8.0)
    assert sim.mission.finished


def test_bayesian_baselines_use_identical_objectives_before_any_evidence():
    sim = create_simulation()
    static_order = [item.action.line_id for item in recommend(sim, "Static Risk")]
    adaptive_order = [item.action.line_id for item in recommend(sim, "Adaptive Risk")]
    assert static_order == adaptive_order


def test_pending_and_inspected_lines_are_excluded():
    sim = create_simulation()
    step(sim)
    excluded = set(sim.beliefs.observations) | {action.line_id for action in sim.mission.pending.values()}
    idle = next(sensor for sensor in sim.mission.sensors if sensor.status == "idle")
    actions = feasible_actions(sim.grid, idle, sim.mission, set(sim.beliefs.observations), sim.config)
    assert not {action.line_id for action in actions} & excluded


def test_evidence_contains_copied_before_and_after_snapshots():
    sim = create_simulation()
    step(sim)
    first = deepcopy(sim.mission.evidence[0])
    auto_run(sim)
    assert sim.mission.evidence[0] == first
    assert set(first["prior_probabilities"]) == set(sim.beliefs.line_probabilities)
    assert sum(first["posterior_zone"]) == pytest.approx(1.0)


def test_repeated_scenarios_and_missions_are_reproducible():
    first = auto_run(create_simulation(ScenarioConfig(seed=123)))
    second = auto_run(create_simulation(ScenarioConfig(seed=123)))
    assert first.environment == second.environment
    assert first.mission == second.mission
    assert first.beliefs == second.beliefs


def _without_runtime(result):
    fields = asdict(result)
    fields.pop("runtime_seconds")
    return fields


def test_benchmarks_have_matched_worlds_and_are_order_independent():
    config = ScenarioConfig(mission_minutes=25)
    forward = run_benchmark(config, [13, 14], POLICIES)
    backward = run_benchmark(config, [14, 13], reversed(POLICIES))
    indexed = {(result.seed, result.policy): _without_runtime(result) for result in forward}
    assert indexed == {(result.seed, result.policy): _without_runtime(result) for result in backward}
    for seed in (13, 14):
        assert len({result.environment_fingerprint for result in forward if result.seed == seed}) == 1
    assert all(result.runtime_seconds > 0 for result in forward)


def test_no_detection_is_censored_and_reported_as_rate():
    results = run_benchmark(ScenarioConfig(mission_minutes=0.1), [1, 2], ["Adaptive Risk"])
    assert all(result.first_critical_detection_minutes is None for result in results)
    summary = summarize_results(results)
    time_row = summary[summary.metric == "first_critical_detection_minutes"].iloc[0]
    rate_row = summary[summary.metric == "critical_detection_rate"].iloc[0]
    assert time_row.observed_n == 0
    assert rate_row["mean"] == 0.0
    assert "censored" in time_row.interpretation


def test_false_negative_reports_are_not_counted_as_detected_faults():
    # Recompute from the hidden environment after an actual complete mission.
    config = ScenarioConfig(sensitivity=0.5, specificity=0.5, seed=101, mission_minutes=60)
    sim = auto_run(create_simulation(config), "Adaptive Risk")
    expected = {obs.line_id for obs in sim.mission.completed if obs.positive and sim.environment.failures[obs.line_id]}
    result = run_benchmark(config, [config.seed], ["Adaptive Risk"])[0]
    assert result.true_faults_detected == len(expected)
    assert result.weighted_faults_detected == pytest.approx(sum(sim.impacts[key].weighted for key in expected))


def _decision_value_example():
    """Two competing next actions: correlated A and independent B."""
    beliefs = BeliefState(
        prior_severity={"A": (.5, 0.0, .5), "B": (.5, 0.0, .5)},
        zone_severity={"A": (.5, 0.0, .5), "B": (.5, 0.0, .5)},
        conditional_failure={"candidate": (.1, .5, .9), "next_a": (.1, .5, .9), "next_b": (.5, .5, .5)},
        line_zones={"candidate": "A", "next_a": "A", "next_b": "B"},
        line_probabilities={"candidate": .5, "next_a": .5, "next_b": .5},
    )
    impacts = {key: LineImpact(key, 1.0, 1.0, 0.0, 1.0) for key in beliefs.line_probabilities}
    return beliefs, impacts


def test_one_step_value_matches_analytic_expected_best_decision_gain():
    beliefs, impacts = _decision_value_example()
    original = deepcopy(asdict(beliefs))
    value = expected_decision_value(beliefs, "candidate", {"next_a": 1.0, "next_b": 1.0},
                                    impacts, ScenarioConfig(sensitivity=1.0, specificity=1.0))
    # P(report+) = .5. A's posterior failure is .82 after + and .18 after -.
    # Thus choose A after +, B after -: .5*.82 + .5*.5 - max(.5,.5) = .16.
    assert value == pytest.approx(.16)
    assert asdict(beliefs) == original


def test_information_that_cannot_change_next_choice_has_zero_decision_value():
    beliefs, impacts = _decision_value_example()
    config = ScenarioConfig(sensitivity=1.0, specificity=1.0)
    assert expected_decision_value(beliefs, "candidate", {"next_a": 1.0}, impacts, config) == pytest.approx(0)
    assert expected_decision_value(beliefs, "candidate", {}, impacts, config) == 0


def test_uninformative_sensor_has_zero_information_and_decision_value():
    config = ScenarioConfig(sensitivity=.5, specificity=.5)
    beliefs, impacts = _decision_value_example()
    assert expected_decision_value(beliefs, "candidate", {"next_a": 1.0, "next_b": 1.0}, impacts, config) == pytest.approx(0)
    recommendations = recommend(create_simulation(config))
    assert all(item.information_gain == pytest.approx(0) for item in recommendations)
    assert all(item.decision_value == pytest.approx(0) for item in recommendations)


def test_lookahead_recomputes_future_travel_and_reserves_both_limits():
    config = ScenarioConfig(mission_minutes=9.0, endurance_minutes=9.0, speed_km_per_minute=1.0)
    candidate = InspectionAction("S", "a", 0.0, 4.0, 0.0, 4.0, 0.0, (0.0, 0.0))
    nearby = InspectionAction("S", "b", 0.0, 4.0, 1.0, 3.0, 1.0, (1.0, 0.0))
    far = InspectionAction("S", "c", 0.0, 6.0, 3.0, 3.0, 3.0, (3.0, 0.0))
    actions = [candidate, nearby, far]
    assert next_action_durations(candidate, actions, config, 9.0) == {"b": 4.0}
    assert next_action_durations(candidate, actions, config, 8.99) == {}
    assert next_action_durations(candidate, actions, replace(config, mission_minutes=8.99), 9.0) == {}
    assert next_action_durations(candidate, [candidate], config, 9.0) == {}


def test_lookahead_rejects_reinspecting_candidate_as_its_own_next_action():
    beliefs, impacts = _decision_value_example()
    with pytest.raises(ValueError, match="own next action"):
        expected_decision_value(beliefs, "candidate", {"candidate": 1}, impacts, ScenarioConfig())


def test_advanced_modes_match_explicit_ablation_policies():
    sim = create_simulation()
    for mode, policy in (("Risk-only", "GridScout Risk-only"), ("Risk + Information Gain", "GridScout + IG")):
        advanced = recommend(sim, "GridScout Advanced", mode)
        baseline = recommend(sim, policy)
        assert [item.action.line_id for item in advanced] == [item.action.line_id for item in baseline]
        assert [item.score for item in advanced] == pytest.approx([item.score for item in baseline])
    full = recommend(sim, "GridScout Advanced", "Restoration-aware")
    assert all(item.decision_value >= 0 for item in full)
    assert any(item.decision_value > 1e-12 for item in full)
