"""Topology-based service consequences and correlated posterior uncertainty."""
from __future__ import annotations

import numpy as np

from .beliefs import conditional_failure_given_evidence
from .models import BeliefState, GridState, HiddenEnvironment, LineImpact, ScenarioConfig
from .network import (evaluate_supplied_load, important_network_edges,
                      potential_restoration_impact)


def _totals(grid: GridState) -> tuple[float, float, float]:
    return (max(1.0, sum(n.get("customers", 0) for _, n in grid.graph.nodes(data=True))),
            max(1.0, sum(n.get("demand_kw", 0) for _, n in grid.graph.nodes(data=True))),
            max(1.0, sum(n.get("critical", False) for _, n in grid.graph.nodes(data=True))))


def _weighted(customers, demand, critical, totals, config):
    customer_total, demand_total, critical_total = totals
    weight_total = config.customer_weight + config.demand_weight + config.critical_weight
    return (config.customer_weight * customers / customer_total
            + config.demand_weight * demand / demand_total
            + config.critical_weight * critical / critical_total) / weight_total


def line_impacts(grid: GridState, config: ScenarioConfig) -> dict[str, LineImpact]:
    """Single-edge outage consequences with every other edge intact.

    Weights are normalized to sum to one. This transparent structural impact is
    not additive over simultaneous faults and is not a restoration guarantee.
    Alternate energized paths correctly reduce or eliminate edge consequences.
    """
    totals = _totals(grid)
    return {row["line_id"]: LineImpact(row["line_id"], row["customers"], row["demand_kw"],
                                      row["critical_sites"], _weighted(row["customers"],
                                      row["demand_kw"], row["critical_sites"], totals, config))
            for row in important_network_edges(grid)}


def sample_posterior_failures(beliefs: BeliefState, samples: int = 256,
                              seed: int = 2026, sensitivity: float = .9,
                              specificity: float = .94) -> list[set[str]]:
    """Joint samples retain shared-zone dependence and existing line evidence."""
    if samples < 1:
        raise ValueError("samples must be positive")
    rng = np.random.default_rng(seed)
    severity_draws = {zone: rng.choice(3, size=samples, p=beliefs.zone_severity[zone])
                      for zone in sorted(beliefs.zone_severity)}
    failures = [set() for _ in range(samples)]
    for line in sorted(beliefs.line_zones):
        conditional = conditional_failure_given_evidence(beliefs, line, sensitivity, specificity)
        probabilities = conditional[severity_draws[beliefs.line_zones[line]]]
        failed = rng.random(samples) < probabilities
        for index in np.flatnonzero(failed):
            failures[int(index)].add(line)
    return failures


def expected_service(grid: GridState, beliefs: BeliefState, samples: int = 256,
                     seed: int = 2026, sensitivity: float = .9,
                     specificity: float = .94) -> dict[str, float]:
    """Monte Carlo mean service loss; sampling uncertainty remains."""
    results = [evaluate_supplied_load(grid, failed) for failed in
               sample_posterior_failures(beliefs, samples, seed, sensitivity, specificity)]
    return {key: float(np.mean([result[key] for result in results])) for key in results[0]}


def actual_service(grid: GridState, environment: HiddenEnvironment) -> dict[str, float]:
    """Simulation evaluator only; never used by an inspection policy."""
    return evaluate_supplied_load(grid, [line for line, failed in environment.failures.items() if failed])


def restoration_opportunities(grid: GridState, beliefs: BeliefState,
                              config: ScenarioConfig, samples: int = 128,
                              seed: int = 2026) -> list[dict]:
    """Hypothetical expected service gain from an instantaneous single-edge repair.

    No repair is executed, no crew or duration is simulated, and upstream or
    downstream faults may make repairing one line insufficient to restore load.
    """
    draws = sample_posterior_failures(beliefs, samples, seed, config.sensitivity, config.specificity)
    totals = _totals(grid)
    results = []
    for line in sorted(beliefs.line_zones):
        gains = [potential_restoration_impact(grid, failed, line)
                 for failed in draws if line in failed]
        # Nonfailed draws contribute zero; denominator must include all draws.
        customers = sum(g["customers"] for g in gains) / samples
        demand = sum(g["demand_kw"] for g in gains) / samples
        critical = sum(g["critical_sites"] for g in gains) / samples
        results.append({"line_id": line, "probability": beliefs.line_probabilities[line],
                        "expected_customers_reconnected": customers,
                        "expected_kw_reconnected": demand,
                        "expected_critical_reconnected": critical,
                        "weighted_opportunity": _weighted(customers, demand, critical, totals, config)})
    return sorted(results, key=lambda row: (-row["weighted_opportunity"], row["line_id"]))
