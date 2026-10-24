"""Concise node explanations from a frozen BN calculation and its input snapshot."""
from __future__ import annotations

import math

from .bn_structure import model_structure
from .inspection_model import inspection_positive_probability, inspection_spec


DEFINITIONS = {
    "W": "Weather and load conditions used by the healthy baseline and mechanical prior.",
    "Q": "Sensor quality, observation mode and normal-baseline calibration.",
    "O": "Received operating record and the declared energized-state prior.",
    "E": "Whether the line is energized in this observation window.",
    "M": "Mechanical abnormality of the monitored line or structure.",
    "T": "Abnormal heating of the monitored asset.",
    "S": "A sensor or installation fault affecting the measurements.",
    "F": "The measurement channel family affected by a sensor or installation fault.",
    "ZM": "Vibration and tilt measurements evaluated by one joint likelihood.",
    "ZT": "Temperature measured at the monitored asset.",
    "ZV": "Measured voltage proxy relative to the nominal energized level.",
    "I": "Inspection modality, quality and visibility used by the inspection model.",
    "R": "Inspection outcome: supports, clear or inconclusive.",
}

CHANNELS = {
    "vibration_rms": ("Vibration", "RMS"),
    "tilt_deg": ("Tilt", "°"),
    "temperature_c": ("Temperature", "°C"),
    "voltage_pu": ("Voltage proxy", "pu"),
}
LATENTS = {"M": "mechanical", "T": "thermal", "S": "sensor_fault", "E": "energized"}


def _number(value):
    try:
        value = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return value if math.isfinite(value) else None


def _percent(value):
    return "Unavailable" if value is None else f"{value:.1%}"


def _measure(value, unit=""):
    number = _number(value)
    return "Unavailable" if number is None else f"{number:.3f}{' ' + unit if unit else ''}"


def _prior(calculation, name):
    priors = calculation.get("priors") or calculation.get("summaries", {}).get("prior", {})
    return _number(priors.get(name))


def _latent_details(details, calculation, node_id):
    name = LATENTS[node_id]
    operation = calculation.get("operation", {})
    evidence = calculation.get("evidence_state", {})
    visual = calculation.get("visual", {})
    posterior = _number(calculation.get("summaries", {}).get("with_visual", {}).get(name))
    prior = _prior(calculation, name)
    details["probability_label"] = f"P({node_id} = true | current evidence)"
    if node_id == "E":
        details["probability_label"] = "P(E = energized | current evidence)"
        if operation.get("known") and type(operation.get("energized")) is bool:
            posterior = float(operation["energized"])
            details["probability_label"] = "P(E = energized | operating record)"
            details["basis"] = ["The operating record fixes the energized state.",
                                f"Record source: {operation.get('source') or 'Unspecified'}."]
        elif evidence.get("eligible_channels") or visual.get("used"):
            details["basis"] = [f"Declared energized prior: {_percent(prior)}.",
                                "Energized and de-energized branches use their own temperature and voltage baselines.",
                                "The posterior sums the probabilities of all energized joint states."]
        else:
            posterior = prior
            details["probability_label"] = "Declared P(E = energized)"
            details["basis"] = ["The unknown operating record uses the declared energized-state prior."]
    else:
        if not calculation.get("available"):
            posterior = None
        prior_line = f"Context prior P({node_id}): {_percent(prior)}."
        methods = {
            "M": "Current gust sets the prior; vibration, tilt and inspection contribute evidence.",
            "T": "Energized state sets the prior; temperature and inspection contribute evidence.",
            "S": "Sensor quality sets the prior; channel residuals contribute evidence through fault family F.",
        }
        details["basis"] = [prior_line, methods[node_id],
                            f"P({node_id}) sums the posterior probabilities of joint states with {node_id} = true."]
        if posterior is None:
            details["probability_label"] = "Current assessment"
    details["probability"] = posterior
    details["value"] = _percent(posterior) if posterior is not None else "Unassessed"


def _observation_details(details, calculation, node_id, reading):
    channels = {"ZM": ("vibration_rms", "tilt_deg"), "ZT": ("temperature_c",),
                "ZV": ("voltage_pu",)}[node_id]
    state = calculation.get("evidence_state", {})
    eligible = state.get("eligible_channels", [])
    recorded = state.get("residuals", {})
    baselines = state.get("baseline", {})
    excluded = state.get("excluded", {})
    details["probability_label"] = "Continuous observation"
    methods = {
        "ZM": "A correlated Gaussian evaluates vibration and tilt for each M/F state.",
        "ZT": "A Gaussian evaluates temperature for each T/F/E state.",
        "ZV": "A Gaussian evaluates the voltage proxy for each F/E state.",
    }
    details["basis"] = [methods[node_id], "z = (observed − baseline mean) / baseline standard deviation."]
    details["channel_values"] = []
    values = []
    for channel in channels:
        label, unit = CHANNELS[channel]
        residual = recorded.get(channel, {})
        observed = _number(residual.get("observed", reading.get(channel)))
        baseline = baselines.get(channel, {})
        used = channel in eligible
        details["channel_values"].append({"channel": channel, "label": label, "unit": unit,
            "observed": observed, "used": used, "baseline_mean": _number(baseline.get("mean")),
            "baseline_sd": _number(baseline.get("sd")), "used_z": _number(residual.get("used_z"))})
        values.append(f"{label}: {_measure(observed, unit)}")
        if used and baseline:
            details["basis"].append(f"{label} baseline: mean {_measure(baseline.get('mean'), unit)}, "
                                     f"SD {_measure(baseline.get('sd'), unit)}.")
        elif channel in excluded:
            details["basis"].append(f"{label} evidence: {excluded[channel]}.")
    operation = calculation.get("operation", {})
    branches = state.get("operating_residuals", {})
    if not operation.get("known") and branches:
        for branch, residuals in branches.items():
            pieces = [f"{CHANNELS[channel][0]} z = {value:+.2f}"
                      for channel in channels if (value := _number(residuals.get(channel))) is not None]
            if pieces:
                details["basis"].append(f"{'Energized' if branch == 'on' else 'De-energized'} branch: "
                                         + "; ".join(pieces) + ".")
    else:
        pieces = [f"{row['label']} z = {row['used_z']:+.2f}"
                  for row in details["channel_values"] if row["used"] and row["used_z"] is not None]
        if pieces:
            details["basis"].append("Applied residuals: " + "; ".join(pieces) + ".")
    if node_id == "ZM":
        group = next((group for group in calculation.get("likelihood_groups", [])
                      if group.get("name") == "correlated_mechanical"), {})
        correlation = _number(group.get("correlation"))
        if correlation is not None:
            details["basis"].append(f"Normal mechanical correlation: {correlation:.2f}.")
    details["value"] = " · ".join(values)


def _inspection_details(details, calculation):
    visual = calculation.get("visual", {})
    spec = inspection_spec(visual.get("spec") or visual)
    details["probability_label"] = "P(supports | sensor evidence, inspection settings)"
    details["value"] = visual.get("result") or "Unobserved"
    details["basis"] = [f"Inspection: {spec['modality']} · {spec['quality']} · {spec['visibility']}.",
                        "The prediction averages P(supports | M,T,I) over the sensor-only joint states."]
    rows = calculation.get("states", [])
    weights = [(row, _number(row.get("posterior_without_visual"))) for row in rows]
    weights = [(row, weight) for row, weight in weights if weight is not None and weight >= 0]
    total = sum(weight for _, weight in weights)
    if spec["usable"] and total:
        # Recorded likelihoods preserve the original assumptions of a used view.
        recorded = visual.get("used") and visual.get("result") in {"supports", "clear"}
        predictions = []
        for row, weight in weights:
            likelihood = _number(row.get("visual_likelihood")) if recorded else None
            positive = (likelihood if visual["result"] == "supports" else 1-likelihood) if likelihood is not None else inspection_positive_probability(
                row.get("mechanical", False), row.get("thermal", False), spec)
            predictions.append(weight * positive)
        details["probability"] = sum(predictions) / total
    elif not spec["usable"]:
        details["basis"].append("Inspection evidence: unusable view.")
    if visual.get("result"):
        details["basis"].append("Recorded result: " + str(visual["result"]) + ".")
    details["basis"].append("Inspection likelihood: applied." if visual.get("used") else "Inspection likelihood: neutral.")


def node_details(calculation, node_id, reading=None, context=None):
    """Return serializable node details from the supplied observation snapshot.

    Probability is a number in [0,1] or None. Its label states the probability
    scope; value holds a human-readable state or measurement. Parent/child IDs
    follow the graph metadata recorded with this calculation.
    """
    if node_id not in DEFINITIONS:
        raise ValueError(f"Unknown BN node: {node_id}")
    calculation, reading, context = calculation or {}, reading or {}, context or {}
    structure = calculation.get("structure") or model_structure()
    node = next((node for node in structure.get("nodes", []) if node.get("id") == node_id), {})
    edges = structure.get("edges", [])
    details = {"id": node_id, "title": node.get("label", node_id), "definition": DEFINITIONS[node_id],
               "probability": None, "probability_label": "Recorded condition", "value": "Unavailable",
               "basis": [], "parents": [source for source, target in edges if target == node_id],
               "children": [target for source, target in edges if source == node_id]}
    if node_id in LATENTS:
        _latent_details(details, calculation, node_id)
    elif node_id in {"ZM", "ZT", "ZV"}:
        _observation_details(details, calculation, node_id, reading)
    elif node_id == "R":
        _inspection_details(details, calculation)
    elif node_id == "W":
        fields = [("ambient_c", "Ambient", "°C"), ("wind_mps", "Wind", "m/s"),
                  ("gust_mps", "Gust", "m/s"), ("solar_wm2", "Solar", "W/m²")]
        details["value"] = " · ".join(f"{label} {_measure(context.get(key), unit)}" for key, label, unit in fields)
        load = _number(context.get("load_pu"))
        details["basis"] = [f"Load: {_measure(load, 'pu') if load is not None else 'unknown'}.",
                            "Weather and load condition the healthy temperature and mechanical baselines.",
                            f"Current mechanical prior: {_percent(_prior(calculation, 'mechanical'))}."]
    elif node_id == "Q":
        state = calculation.get("evidence_state", {})
        quality = state.get("quality", reading.get("quality", "Unspecified"))
        mode = state.get("mode", reading.get("mode", "Unspecified"))
        details["value"] = f"Quality: {quality} · Mode: {mode}"
        details["basis"] = [f"Baseline: {reading.get('baseline_version') or 'Unspecified'}.",
                            f"Sensor-fault prior: {_percent(_prior(calculation, 'sensor_fault'))}.",
                            "Quality sets observation uncertainty; mode determines eligible mechanical channels."]
    elif node_id == "O":
        operation = calculation.get("operation", {})
        details["value"] = operation.get("status", "unknown")
        details["basis"] = [f"Source: {operation.get('source') or 'Unspecified'}.",
                            f"Operating prior P(E = energized): {_percent(_number(operation.get('prior_energized')))}.",
                            "A known record fixes E; an unknown record uses the declared prior."]
    elif node_id == "I":
        visual = calculation.get("visual", {})
        spec = inspection_spec(visual.get("spec") or visual)
        details["value"] = f"{spec['modality']} · {spec['quality']} · {spec['visibility']}"
        details["basis"] = ["RGB detects visible mechanical evidence; thermal imaging detects heat evidence.",
                            "Quality and visibility scale the inspection's discrimination.",
                            f"View status: {'usable' if spec['usable'] else 'unusable'}."]
    elif node_id == "F":
        group = next((group for group in calculation.get("likelihood_groups", [])
                      if group.get("name") == "sensor_fault_families"), {})
        weights = {name: value for name, weight in group.get("weights", {}).items()
                   if (value := _number(weight)) is not None}
        details["distribution"] = weights
        details["probability_label"] = "Conditional prior P(F | S = true)"
        details["value"] = "Marginalized"
        details["basis"] = ["P(F = none | S = false) = 100%."]
        if weights:
            details["basis"].append("P(F | S = true): " + ", ".join(
                f"{name} {weight:.0%}" for name, weight in weights.items()) + ".")
        details["basis"].append("Each joint-state likelihood sums over the possible fault families.")
    return details
