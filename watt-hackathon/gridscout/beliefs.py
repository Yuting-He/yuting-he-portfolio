"""Exact finite latent-severity inference with one evidence item per line."""
from __future__ import annotations

from copy import deepcopy
import math
import numpy as np

from .models import BeliefState, Observation


def entropy(distribution) -> float:
    """Shannon entropy, in bits."""
    return float(-sum(p * math.log2(p) for p in distribution if p > 0))


def _accuracy(sensitivity: float, specificity: float) -> None:
    if not (0 <= sensitivity <= 1 and 0 <= specificity <= 1):
        raise ValueError("Sensitivity and specificity must lie in [0, 1]")


def _likelihood(conditional, positive: bool, sensitivity: float, specificity: float):
    p = np.asarray(conditional, dtype=float)
    report_positive = sensitivity * p + (1 - specificity) * (1 - p)
    return report_positive if positive else 1 - report_positive


def conditional_failure_given_evidence(beliefs: BeliefState, line_id: str,
                                       sensitivity: float, specificity: float) -> np.ndarray:
    """P(F_line=1 | zone severity, this line's evidence).

    Other lines' evidence influences the zone posterior, not this conditional.
    This separation prevents counting the inspected line's likelihood twice.
    """
    probability = np.asarray(beliefs.conditional_failure[line_id], dtype=float)
    observation = beliefs.observations.get(line_id)
    if observation is None:
        return probability.copy()
    likelihood = _likelihood(probability, observation.positive, sensitivity, specificity)
    numerator = probability * (sensitivity if observation.positive else 1 - sensitivity)
    return np.divide(numerator, likelihood, out=np.zeros(3), where=likelihood > 0)


def observation_probability(beliefs: BeliefState, line_id: str,
                             sensitivity: float, specificity: float) -> float:
    """Predictive probability of a positive report on a new inspection."""
    _accuracy(sensitivity, specificity)
    probability = beliefs.line_probabilities[line_id]
    return float(sensitivity * probability + (1 - specificity) * (1 - probability))


def update_beliefs(beliefs: BeliefState, observation: Observation,
                   sensitivity: float, specificity: float) -> BeliefState:
    """Return a fresh posterior, never mutating the real state during lookahead.

    All unique evidence likelihoods are multiplied into the ORIGINAL severity
    prior once. Re-observing an already-inspected line is idempotent; this MVP
    models only one inspection per line, not repeated independent measurements.
    The same sensor accuracy is assumed across the mission.
    """
    _accuracy(sensitivity, specificity)
    if observation.line_id not in beliefs.line_zones:
        raise KeyError(f"Unknown line: {observation.line_id}")
    result = deepcopy(beliefs)
    if observation.line_id in result.observations:
        return result
    result.observations[observation.line_id] = observation
    zone = result.line_zones[observation.line_id]
    prior = np.asarray(result.prior_severity[zone], dtype=float)
    with np.errstate(divide="ignore"):
        log_weight = np.log(prior)
        for line, evidence in sorted(result.observations.items()):
            if result.line_zones[line] == zone:
                log_weight += np.log(_likelihood(result.conditional_failure[line],
                                                evidence.positive, sensitivity, specificity))
    if not np.isfinite(log_weight).any():
        raise ValueError("Evidence has zero likelihood under the specified model")
    weight = np.exp(log_weight - np.max(log_weight))
    posterior = weight / weight.sum()
    result.zone_severity[zone] = tuple(float(value) for value in posterior)
    for line, line_zone in result.line_zones.items():
        if line_zone == zone:
            conditional = conditional_failure_given_evidence(result, line, sensitivity, specificity)
            result.line_probabilities[line] = float(np.dot(posterior, conditional))
    return result


def expected_information_gain(beliefs: BeliefState, line_id: str,
                               sensitivity: float, specificity: float) -> float:
    """Expected zone entropy reduction, averaged across both possible reports."""
    if line_id in beliefs.observations:
        return 0.0
    zone = beliefs.line_zones[line_id]
    p_positive = observation_probability(beliefs, line_id, sensitivity, specificity)
    expected_entropy = 0.0
    for positive, probability in ((True, p_positive), (False, 1 - p_positive)):
        if probability > 0:
            posterior = update_beliefs(beliefs, Observation(line_id, positive),
                                      sensitivity, specificity)
            expected_entropy += probability * entropy(posterior.zone_severity[zone])
    return max(0.0, entropy(beliefs.zone_severity[zone]) - expected_entropy)
