"""Documented synthetic logistic hazard model and isolated simulation truth."""
from __future__ import annotations

import hashlib
import json
import math
import numpy as np

from .models import BeliefState, GridState, HiddenEnvironment, ScenarioConfig
from .network import lines

SEVERITY_STATES = ("Low", "Medium", "High")
SEVERITY_PRIORS = {
    "Low": (.78, .18, .04),
    "Medium": (.18, .64, .18),
    "High": (.08, .27, .65),
}
HAZARD_COEFFICIENTS = {
    "Storm": (-4.5, 1.35),
    "Wildfire": (-4.75, 1.60),
    "Heatwave": (-4.9, 1.15),
}


def failure_probability(hazard: str, severity: int, vulnerability: float,
                        exposure: float) -> float:
    """sigmoid(intercept + severity_coefficient*s + 2*v + exposure).

    s is 0/1/2. These coefficients are illustrative assumptions, not calibrated
    engineering fragility curves. Lines are conditionally independent given
    their zone's severity; integrating severity creates correlated damage.
    """
    intercept, severity_coefficient = HAZARD_COEFFICIENTS[hazard]
    logit = intercept + severity_coefficient * severity + 2 * vulnerability + exposure
    return 1.0 / (1.0 + math.exp(-logit))


def create_beliefs(grid: GridState, config: ScenarioConfig) -> BeliefState:
    attributes = lines(grid)
    line_zones = {key: value["zone"] for key, value in attributes.items()}
    priors = {zone: SEVERITY_PRIORS[config.severity]
              for zone in sorted(set(line_zones.values()))}
    conditionals = {key: tuple(failure_probability(config.hazard, severity,
                                                 value["vulnerability"], value["exposure"])
                               for severity in range(3))
                    for key, value in attributes.items()}
    marginals = {key: float(np.dot(priors[line_zones[key]], values))
                 for key, values in conditionals.items()}
    return BeliefState(dict(priors), dict(priors), conditionals, line_zones, marginals)


def create_environment(grid: GridState, beliefs: BeliefState,
                       config: ScenarioConfig) -> HiddenEnvironment:
    """Sample once, before a policy runs, using separate explicit RNG streams.

    Every line receives one stored observation variate. Policies therefore see
    matched potential reports when they choose the same line, independent of
    their execution order and inspection timing.
    """
    sequences = np.random.SeedSequence(config.seed).spawn(3)
    severity_rng, failure_rng, observation_rng = [np.random.default_rng(s) for s in sequences]
    severities = {zone: int(severity_rng.choice(3, p=beliefs.prior_severity[zone]))
                  for zone in sorted(beliefs.prior_severity)}
    line_ids = sorted(lines(grid))
    failures = {line: bool(failure_rng.random() < beliefs.conditional_failure[line][
        severities[beliefs.line_zones[line]]]) for line in line_ids}
    uniforms = {line: float(observation_rng.random()) for line in line_ids}
    payload = json.dumps({"failures": failures, "severity": severities,
                          "uniforms": uniforms}, sort_keys=True, separators=(",", ":"))
    fingerprint = hashlib.sha256(payload.encode()).hexdigest()[:20]
    return HiddenEnvironment(failures, severities, uniforms, fingerprint)
