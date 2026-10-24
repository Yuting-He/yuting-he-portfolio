"""Public-information inspection heuristics; no hidden environment is accepted.

The advanced policy adds one-step value of evidence for the next inspection's
service-impact objective. It supports restoration planning but does not simulate
repair dispatch or promise restoration. This is a heuristic, not exact routing.
"""
from __future__ import annotations

import hashlib
import math

from .beliefs import expected_information_gain, observation_probability, update_beliefs
from .models import (BeliefState, InspectionAction, LineImpact, Observation,
                     Recommendation, ScenarioConfig)

POLICIES = ("Random", "Static Risk", "Adaptive Risk", "GridScout Risk-only", "GridScout + IG", "GridScout Advanced")
MODES = ("Risk-only", "Risk + Information Gain", "Restoration-aware")
DECISION_VALUE_IMPLEMENTED = True


def _random_priority(seed: int, epoch: int, action: InspectionAction) -> float:
    # A keyed draw avoids changing the real RNG when the operator previews a
    # recommendation, and makes repeated previews and benchmarks reproducible.
    payload = f"{seed}|{epoch}|{action.sensor_id}|{action.line_id}".encode("utf-8")
    return int.from_bytes(hashlib.sha256(payload).digest()[:8], "big") / 2**64


def next_action_durations(candidate: InspectionAction, actions: list[InspectionAction],
                           config: ScenarioConfig, remaining_endurance: float) -> dict[str, float]:
    """Same-sensor next actions after candidate, including home-return reserves.

The supplied action list already excludes inspected and pending lines. Neither
the candidate itself nor a line that no longer fits the mission can be chosen.
Other sensors' future observations are not forecast in this one-step model.
"""
    durations = {}
    for following in actions:
        if following.line_id == candidate.line_id:
            continue
        travel = math.dist(candidate.destination, following.destination) / config.speed_km_per_minute
        duration = travel + following.inspection_minutes
        if candidate.finish_time + duration + following.return_minutes > config.mission_minutes + 1e-9:
            continue
        if candidate.duration + duration + following.return_minutes > remaining_endurance + 1e-9:
            continue
        durations[following.line_id] = duration
    return durations


def expected_decision_value(beliefs: BeliefState, line_id: str,
                             next_durations: dict[str, float],
                             impacts: dict[str, LineImpact], config: ScenarioConfig) -> float:
    """E_Y[max_j U(j | Y)] - max_j U(j), over exactly the same next actions.

U(j) = posterior P(failure_j) * isolated-failure service impact_j / next
inspection duration_j. Positive and negative reports use their predictive
probabilities and exact copied Bayesian updates. This is value of information
for a NEXT INSPECTION repair-support proxy, not expected customers restored.
An observation has no decision value when it cannot change the best next action.
"""
    if not next_durations or line_id in beliefs.observations:
        return 0.0
    if line_id in next_durations:
        raise ValueError("The inspected candidate cannot also be its own next action")
    if any(duration <= 0 for duration in next_durations.values()):
        raise ValueError("Next inspection durations must be positive")

    def objective(state: BeliefState) -> float:
        return max(state.line_probabilities[key] * impacts[key].weighted / duration
                   for key, duration in next_durations.items())

    baseline = objective(beliefs)
    positive_probability = observation_probability(beliefs, line_id, config.sensitivity, config.specificity)
    expected_best = 0.0
    for positive, probability in ((True, positive_probability), (False, 1.0 - positive_probability)):
        if probability <= 0:
            continue
        temporary = update_beliefs(beliefs, Observation(line_id, positive),
                                  config.sensitivity, config.specificity)
        expected_best += probability * objective(temporary)
    # For fixed actions the exact Bayesian value is nonnegative by convexity.
    return max(0.0, expected_best - baseline)


def rank_candidates(beliefs: BeliefState, actions: list[InspectionAction],
                    impacts: dict[str, LineImpact], initial_probabilities: dict[str, float],
                    config: ScenarioConfig, policy: str = "GridScout Advanced",
                    mode: str = "Restoration-aware", epoch: int = 0,
                    remaining_endurance: float | None = None) -> list[Recommendation]:
    """Rank feasible public actions without mutating beliefs, actions, or RNGs.

Risk is posterior failure probability times the isolated line-failure service
impact. Normalize each benefit by its candidate maximum before combining.
Information gain is measured in the same entropy units as the belief module.
Static Risk retains its initial expected-impact ordering throughout the mission.
"""
    if policy not in POLICIES:
        raise ValueError(f"Unknown policy: {policy}")
    if mode not in MODES:
        raise ValueError(f"Unknown planning mode: {mode}")
    if not actions:
        return []
    risks = {a.line_id: beliefs.line_probabilities[a.line_id] * impacts[a.line_id].weighted for a in actions}
    ranking_risks = risks if policy != "Static Risk" else {
        a.line_id: initial_probabilities[a.line_id] * impacts[a.line_id].weighted for a in actions
    }
    information = {
        a.line_id: expected_information_gain(beliefs, a.line_id, config.sensitivity, config.specificity)
        for a in actions
    }
    use_decision = policy == "GridScout Advanced" and mode == "Restoration-aware"
    endurance = config.endurance_minutes if remaining_endurance is None else remaining_endurance
    decision_values = {
        action.line_id: expected_decision_value(
            beliefs, action.line_id, next_action_durations(action, actions, config, endurance), impacts, config
        ) if use_decision else 0.0
        for action in actions
    }
    maximum_risk = max(ranking_risks.values(), default=0.0)
    maximum_information = max(information.values(), default=0.0)
    maximum_decision = max(decision_values.values(), default=0.0)
    use_information = policy == "GridScout + IG" or (policy == "GridScout Advanced" and mode != "Risk-only")
    recommendations = []
    for action in actions:
        line_id = action.line_id
        normalized_risk = ranking_risks[line_id] / maximum_risk if maximum_risk > 0 else 0.0
        normalized_information = information[line_id] / maximum_information if maximum_information > 1e-12 else 0.0
        normalized_decision = decision_values[line_id] / maximum_decision if maximum_decision > 1e-12 else 0.0
        if policy == "Random":
            score = _random_priority(config.seed, epoch, action)
        elif policy in ("Static Risk", "Adaptive Risk"):
            score = normalized_risk
        else:
            score = (normalized_risk
                     + (config.information_weight * normalized_information if use_information else 0.0)
                     + (config.decision_weight * normalized_decision if use_decision else 0.0)) / max(action.duration, 1e-9)
        recommendations.append(Recommendation(
            action=action, probability=beliefs.line_probabilities[line_id], impact=impacts[line_id],
            expected_fault_impact=risks[line_id], information_gain=information[line_id],
            decision_value=decision_values[line_id], score=score, normalized_risk=normalized_risk,
            normalized_information=normalized_information, normalized_decision=normalized_decision,
        ))
    return sorted(recommendations, key=lambda item: (-item.score, item.action.line_id))
