"""One-step Bayesian decision network in synthetic relative loss units.

Evidence actions enumerate possible results and select the lowest-loss
downstream terminal decision. Forecasts inform feasibility and scheduling.
"""
from __future__ import annotations

import math

from .inspection_model import inspection_positive_probability, inspection_spec

DEFAULT_COSTS = {
    "field_check": 16.0, "false_positive": 24.0, "missed_event": 180.0,
    "residual_event": 4.0, "remote_review": 3.0, "inspect_sensor": 2.0,
    "waiting_per_minute": 0.4, "unresolved_sensor": 12.0,
    "unknown_coverage": 10.0, "remote_sensitivity": 0.85,
    "remote_specificity": 0.92, "sensor_sensitivity": 0.90,
    "sensor_specificity": 0.90, "sensor_resolution": 0.90,
    "urgent_review": 1.0, "critical_missed_event": 1200.0,
}
ACTION_LABELS = {"monitor": "Continue monitoring", "remote_review": "Remote visual / operations review",
                 "field_check": "Request field inspection", "inspect_sensor": "Check sensor / installation",
                 "urgent_review": "Immediate human escalation"}


def _finite(value, default):
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return default
    return result if math.isfinite(result) else default


def _costs(overrides):
    values = dict(DEFAULT_COSTS)
    for key, value in (overrides or {}).items():
        if key not in values:
            continue
        values[key] = min(1e9, max(0.0, _finite(value, values[key])))
    for key in ("remote_sensitivity", "remote_specificity", "sensor_sensitivity", "sensor_specificity", "sensor_resolution"):
        values[key] = min(1.0, values[key])
    return values


def _states(inference):
    states = []
    for state in inference.get("joint_states", []):
        probability = max(0.0, _finite(state.get("probability"), 0.0))
        states.append({"mechanical": bool(state.get("mechanical")), "thermal": bool(state.get("thermal")),
                       "anomaly": bool(state.get("mechanical") or state.get("thermal")),
                       "sensor_fault": bool(state.get("sensor_fault")), "probability": probability})
    if not states or sum(state["probability"] for state in states) <= 0:
        p = min(1.0, max(0.0, _finite(inference.get("anomaly"), 0.05)))
        q = min(1.0, max(0.0, _finite(inference.get("sensor_fault"), 0.05)))
        if "mechanical" in inference and "thermal" in inference:
            mechanical = min(1.0, max(0.0, _finite(inference["mechanical"], 0.0)))
            thermal = min(1.0, max(0.0, _finite(inference["thermal"], 0.0)))
            asset_states = [(m, t, (mechanical if m else 1-mechanical)*(thermal if t else 1-thermal))
                            for m in (False, True) for t in (False, True)]
        else:
            # Aggregate-only legacy callers do not identify the defect family.
            # Use an explicit equal exclusive mixture, never assume RGB detects
            # every anomalous state. Normal inference supplies full joint states.
            asset_states = [(False, False, 1-p), (True, False, p/2), (False, True, p/2)]
        states = [{"mechanical": m, "thermal": t, "anomaly": m or t, "sensor_fault": s,
                   "probability": probability * (q if s else 1-q)}
                  for m, t, probability in asset_states for s in (False, True)]
    total = sum(state["probability"] for state in states)
    return [{**state, "probability": state["probability"] / total} for state in states]


def _marginals(states):
    return tuple(sum(state["probability"] for state in states if state[key]) for key in ("anomaly", "sensor_fault"))


def recommend_actions(inference: dict, costs: dict | None = None,
                      minutes_to_review: float = 5.0, inspection: dict | None = None) -> list[dict]:
    """Return ascending expected-loss alternatives, first item recommended.

    The shared terminal horizon uses synthetic unresolved-event loss; review
    delay adds transient loss during evidence collection. Field inspection
    represents a diagnostic visit with residual uncertainty.
    Remote review uses the shared modality/quality/visibility observation model,
    including an inconclusive outcome. Legacy remote_sensitivity and
    remote_specificity cost overrides change only mechanical sensitivity and
    healthy false positives; thermal sensitivity and modality limits remain.
    """
    c = _costs(costs)
    minutes = min(240.0, max(0.0, _finite(minutes_to_review, 5.0)))
    states = _states(inference)
    p, sensor = _marginals(states)
    unknown = inference.get("status") == "Unknown"
    urgent = bool(inference.get("urgent"))
    miss = c["critical_missed_event"] if urgent else c["missed_event"]

    def terminal(posterior, sensor_resolution=0.0, coverage_resolved=False):
        a, s = _marginals(posterior)
        unresolved = s * c["unresolved_sensor"] * (1-sensor_resolution)
        coverage = c["unknown_coverage"] if unknown and not coverage_resolved else 0.0
        return {"monitor": a*miss + unresolved + coverage,
                "field_check": c["field_check"] + (1-a)*c["false_positive"] + a*c["residual_event"] + unresolved}

    terminals = terminal(states)
    baseline_best = min(terminals.values())
    delay = p * c["waiting_per_minute"] * minutes * (4.0 if urgent else 1.0)
    choices = [
        {"action": "monitor", "cost": 0.0, "expected_loss": terminals["monitor"],
         "reason": "Review current evidence on schedule; expected loss includes unresolved events, sensor issues and coverage gaps.",
         "next_check_minutes": min(minutes, 1.0) if urgent else minutes,
         "cost_breakdown": {"event": p*miss, "sensor": sensor*c["unresolved_sensor"],
                            "unknown_coverage": c["unknown_coverage"] if unknown else 0.0}},
        {"action": "field_check", "cost": c["field_check"], "expected_loss": terminals["field_check"],
         "reason": "Request an on-site diagnostic inspection; expected loss includes dispatch, unnecessary visits and residual asset uncertainty.",
         "next_check_minutes": 0.0,
         "cost_breakdown": {"action": c["field_check"], "false_positive": (1-p)*c["false_positive"],
                            "residual_event": p*c["residual_event"], "sensor": sensor*c["unresolved_sensor"]}},
    ]

    def evidence_action(action, result_likelihoods, resolution=0.0, coverage=False):
        outcomes, downstream, pure_information = [], 0.0, 0.0
        for result, likelihood_for in result_likelihoods:
            weighted = []
            for state in states:
                likelihood = likelihood_for(state)
                weighted.append({**state, "probability": state["probability"] * likelihood})
            predictive = sum(state["probability"] for state in weighted)
            if predictive <= 0:
                continue
            posterior = [{**state, "probability": state["probability"] / predictive} for state in weighted]
            loss = terminal(posterior, sensor_resolution=resolution, coverage_resolved=coverage)
            next_action = min(loss, key=loss.get)
            outcome_a, outcome_s = _marginals(posterior)
            downstream += predictive * loss[next_action]
            pure_information += predictive * min(terminal(posterior).values())
            outcomes.append({"result": result, "probability": predictive,
                             "anomaly": outcome_a, "sensor_fault": outcome_s,
                             "mechanical": sum(s["probability"] for s in posterior if s["mechanical"]),
                             "thermal": sum(s["probability"] for s in posterior if s["thermal"]),
                             "next_action": next_action, "downstream_loss": loss[next_action]})
        # Gross value includes diagnosis-driven sensor/coverage resolution when
        # selected; its component is reported separately from pure information.
        evsi = max(0.0, baseline_best-pure_information)
        expected = c[action] + delay + downstream
        return {"action": action, "cost": c[action], "expected_loss": expected,
                "next_check_minutes": minutes, "outcomes": outcomes, "evsi": evsi,
                "net_value": baseline_best-expected,
                "reason": ("Collect an inspection with the selected modality, quality and visibility; compare supports, clear and inconclusive outcomes."
                           if action == "remote_review" else
                           "Check calibration, mounting and data delivery; combine sensor diagnosis with the asset-state estimate."),
                "cost_breakdown": {"action": c[action], "delay": delay, "downstream": downstream,
                                   "gross_information_value": evsi,
                                   "resolution_value": max(0.0, pure_information-downstream)}}

    planned_inspection = dict(inspection or {})
    if costs and "remote_sensitivity" in costs:
        planned_inspection["mechanical_sensitivity"] = c["remote_sensitivity"]
    if costs and "remote_specificity" in costs:
        planned_inspection["false_positive_probability"] = 1-c["remote_specificity"]
    spec = inspection_spec(planned_inspection)
    review_coverage = spec["coverage"]

    def supports(state):
        return review_coverage * inspection_positive_probability(state["mechanical"], state["thermal"], spec)

    def clear(state):
        return review_coverage * (1-inspection_positive_probability(state["mechanical"], state["thermal"], spec))

    remote = evidence_action("remote_review", [("supports", supports), ("clear", clear),
                                               ("inconclusive", lambda _: 1-review_coverage)])
    remote["inspection_spec"] = spec
    remote["legacy_override_semantics"] = "remote_sensitivity changes mechanical sensitivity; remote_specificity changes healthy FP; modality limits and thermal sensitivity remain"
    choices.append(remote)

    def sensor_positive(state):
        return c["sensor_sensitivity"] if state["sensor_fault"] else 1-c["sensor_specificity"]

    choices.append(evidence_action("inspect_sensor", [("positive", sensor_positive),
                                                     ("negative", lambda state: 1-sensor_positive(state))],
                                   c["sensor_resolution"], coverage=unknown))
    if urgent:
        choices.append({"action": "urgent_review", "cost": c["urgent_review"],
                        "expected_loss": c["urgent_review"] + p*c["residual_event"] + (1-p)*c["false_positive"]*0.10,
                        "reason": "Severe current residuals trigger immediate human assessment.",
                        "next_check_minutes": 0.0,
                        "cost_breakdown": {"action": c["urgent_review"], "residual_event": p*c["residual_event"],
                                           "unnecessary_human_review": (1-p)*c["false_positive"]*0.10}})
    choices.sort(key=lambda item: (item["expected_loss"], item["cost"], item["action"]))
    for index, choice in enumerate(choices):
        choice.update(label=ACTION_LABELS[choice["action"]], recommended=index == 0,
                      loss_units="synthetic relative loss units", assumptions="synthetic, uncalibrated one-step decision model")
    return choices
