"""Exact, current-window Bayesian state inference for the synthetic twin.

All priors and fault likelihoods below are transparent demonstration assumptions,
not hardware calibration. Enumerated joint hypotheses allow asset damage and sensor /
installation faults to coexist. Vibration and tilt have one correlated likelihood;
there is no accumulation across calls and no access to simulator truth.
"""
from __future__ import annotations

from itertools import product
import math

from .bn_structure import model_structure
from .operating_state import operating_context
from .inspection_model import inspection_spec, inspection_likelihood

MODEL_VERSION = "window-bn-2.0-synthetic"
CALCULATION_VERSION = "window-bn-calculation-2.0"
CHANNELS = ("temperature_c", "vibration_rms", "voltage_pu", "tilt_deg")


def _number(value, default=None):
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return default
    return result if math.isfinite(result) else default


def _normal(z: float, mean=0.0, sd=1.0) -> float:
    return -math.log(sd) - 0.5 * math.log(2 * math.pi) - 0.5 * ((z - mean) / sd) ** 2


def _logsum(values):
    largest = max(values)
    if largest == -math.inf:
        return largest
    return largest + math.log(sum(math.exp(item - largest) for item in values))


def _log_probability(value):
    return math.log(value) if value > 0 else -math.inf


def _mechanical_likelihood(values, mechanical, sensor_fault, correlation):
    """A correlated bivariate Gaussian, marginalized when a channel is absent.

    Tilt displacement can occur in either direction. The sensor-fault component
    is broad in both channels and remains available in damaged states too.
    """
    sd = 6.0 if sensor_fault else (2.0 if mechanical else 1.0)
    rho = 0.25 if sensor_fault else correlation
    possibilities = []
    for direction in (-1, 1):
        means = {"vibration_rms": 5.0 if mechanical else 0.0,
                 "tilt_deg": direction * 5.0 if mechanical else 0.0}
        if len(values) == 2:
            a = (values["vibration_rms"] - means["vibration_rms"]) / sd
            b = (values["tilt_deg"] - means["tilt_deg"]) / sd
            log_density = (-math.log(2 * math.pi * sd * sd)
                           - 0.5 * math.log(1 - rho * rho)
                           - (a*a - 2*rho*a*b + b*b) / (2 * (1 - rho*rho)))
        else:
            log_density = sum(_normal(z, means[key], sd) for key, z in values.items())
        possibilities.append(log_density)
    return _logsum(possibilities) - math.log(2)


def infer_asset(reading: dict, baseline: dict, weather: dict,
                visual: str | dict | None = None) -> dict:
    """Exact manual BN, current window only; no simulator truth or DAG learning.

    E is clamped by known operations, otherwise both operating hypotheses are
    enumerated with their own healthy baselines. F is marginalized, not treated
    as three independent sensor-fault votes. Inspection uses a shared conditional
    observation model, also used by previews and decision-value calculations.
    """
    quality = reading.get("quality", "valid")
    mode = reading.get("mode", "perched")
    flying = mode in {"in_flight", "flying"}
    unusable = quality in {"missing", "stale", "invalid"}
    operation = operating_context(weather)
    components = baseline.get("operating_components", {})
    scale = 1.5 if quality == "suspect" and not flying else 1.0
    evidence, missing, residuals = [], [], {}
    residual_trace, baseline_trace, excluded_channels = {}, {}, {}
    for channel in CHANNELS:
        value = _number(reading.get(channel))
        spec = baseline.get(channel) or {}
        mean, sd = _number(spec.get("mean")), _number(spec.get("sd"))
        excluded = channel in {"vibration_rms", "tilt_deg"} and flying
        unknown_without_components = not operation["known"] and channel in {"temperature_c", "voltage_pu"} and not components
        if unusable or value is None or mean is None or sd is None or sd <= 0 or excluded or unknown_without_components:
            reason = ("in-flight mechanical measurement excluded" if excluded else
                      "unknown operating state has no conditional baseline" if unknown_without_components else
                      "unusable or stale observation" if unusable else "missing observation or baseline")
            missing.append(f"{channel}: {reason}")
            excluded_channels[channel] = reason
            continue
        raw_z = (value-mean)/sd
        z = max(-1000., min(1000., raw_z))
        residuals[channel] = z/scale
        residual_trace[channel] = {"observed": value, "raw_z": _number(raw_z), "clipped_z": z,
                                   "used_z": z/scale, "uncertainty_scale": scale, "clipped": raw_z != z}
        baseline_trace[channel] = {"mean": mean, "sd": sd,
                                   "low": _number(spec.get("low"), mean-1.96*sd),
                                   "high": _number(spec.get("high"), mean+1.96*sd)}
        evidence.append({"channel": channel, "observed": value, "expected": mean, "z": z,
                         "reason": {"temperature_c": "Conditional on weather, unknown/known load and operating state.",
                                    "vibration_rms": "Joint vibration/tilt likelihood, normal wind response removed.",
                                    "tilt_deg": "Relative angle against the installation reference.",
                                    "voltage_pu": "Voltage evidence conditioned on energized state and sensor health."}[channel]})

    wind = max(0., _number(weather.get("wind_mps"), 0.))
    gust = max(wind, _number(weather.get("gust_mps"), wind))
    pm = min(.10, .025+max(0., gust-12.)*.002)
    ps = .35 if quality == "suspect" and not flying else .045
    pe = operation["prior_energized"]
    priors = {"mechanical": pm, "thermal": pe*.025+(1-pe)*.005, "sensor_fault": ps,
              "energized": pe}
    rho = max(-.9, min(.9, _number(baseline.get("mechanical_correlation"), .62)))
    supplied_visual_result = visual.get("result") if isinstance(visual, dict) else visual
    view_spec = inspection_spec(visual)
    visual_used = view_spec["usable"] and supplied_visual_result in {"supports", "clear"}
    visual_result = supplied_visual_result if visual_used else None
    weighted, telemetry_weighted, calculation_states = [], [], []
    operating_values = [operation["energized"]] if operation["known"] else [False, True]
    branch_residuals = {}
    for energized in operating_values:
        conditional = baseline if operation["known"] else components.get("on" if energized else "off", baseline)
        used, jacobian = {}, 0.
        for channel in residuals:
            spec = conditional[channel]
            raw_z = (float(reading[channel])-spec["mean"])/spec["sd"]
            used[channel] = max(-1000., min(1000., raw_z))/scale
            # Across E branches, standardized Gaussian densities must be
            # converted to the same physical units before mixing them.
            if not operation["known"]:
                jacobian -= math.log(spec["sd"]*scale)
        branch_residuals["on" if energized else "off"] = used
        mechanical_values = {k: used[k] for k in ("vibration_rms", "tilt_deg") if k in used}
        for mechanical, thermal, sensor_fault in product((False, True), repeat=3):
            states = {"mechanical": mechanical, "thermal": thermal, "sensor_fault": sensor_fault,
                      "energized": energized}
            conditional_priors = {"mechanical": pm, "thermal": .025 if energized else .005, "sensor_fault": ps}
            log_prior = sum(math.log(p if states[k] else 1-p) for k, p in conditional_priors.items())
            log_prior += math.log(pe if energized else 1-pe)
            families = (("temperature", .4), ("mechanical", .4), ("voltage", .1), ("all", .1)) if sensor_fault else (("none", 1.),)
            family_logs = []
            for family, probability in families:
                likelihood = math.log(probability)+jacobian
                if mechanical_values:
                    likelihood += _mechanical_likelihood(mechanical_values, mechanical, family in {"mechanical", "all"}, rho)
                if "temperature_c" in used:
                    likelihood += _normal(used["temperature_c"], 5. if thermal else 0.,
                                          7. if family in {"temperature", "all"} else (2. if thermal else 1.))
                if "voltage_pu" in used:
                    likelihood += _normal(used["voltage_pu"], 0., 8. if family in {"voltage", "all"} else 1.)
                family_logs.append(likelihood)
            log_sensor_likelihood = _logsum(family_logs)
            log_weight = log_prior+log_sensor_likelihood
            telemetry_weighted.append((states, log_weight))
            visual_likelihood = inspection_likelihood(mechanical, thermal, visual_result, view_spec)
            weighted.append((states, log_weight+_log_probability(visual_likelihood)))
            calculation_states.append({**states, "prior_probability": math.exp(log_prior),
                                       "log_sensor_likelihood": log_sensor_likelihood,
                                       "visual_likelihood": visual_likelihood, "residuals": dict(used)})

    def normalize(items):
        normalizer = _logsum([weight for _, weight in items])
        rows = [{**state, "probability": math.exp(weight-normalizer)} for state, weight in items]
        total = sum(row["probability"] for row in rows)
        for row in rows:
            row["probability"] /= total
        return rows

    def summarize(rows):
        result = {key: sum(row["probability"] for row in rows if row[key]) for key in priors}
        result["anomaly"] = sum(row["probability"] for row in rows if row["mechanical"] or row["thermal"])
        return result

    incompatible_view = all(weight == -math.inf for _, weight in weighted)
    if incompatible_view:
        visual_used, visual_result = False, None
        weighted = telemetry_weighted
        for trace in calculation_states:
            trace["visual_likelihood"] = 1.
    joint_states, telemetry_states = normalize(weighted), normalize(telemetry_weighted)
    for trace, sensor, actual in zip(calculation_states, telemetry_states, joint_states):
        trace["posterior_without_visual"] = sensor["probability"]
        trace["posterior_probability"] = actual["probability"]
    result, telemetry_marginals = summarize(joint_states), summarize(telemetry_states)
    prior_marginals = {**priors, "anomaly": 1-(1-pm)*(1-priors["thermal"])}
    operation["posterior_energized"] = result["energized"]
    usable_asset = any(k in residuals for k in ("temperature_c", "vibration_rms", "tilt_deg"))
    if incompatible_view:
        visual_reason = "Inspection outcome has zero probability under its stated assumptions; request a corrected inspection record."
    elif visual_used:
        visual_reason = "One inspection likelihood conditioned on modality, quality and visibility."
    elif not view_spec["usable"]:
        visual_reason = "Inspection modality, visibility or quality is unusable; excluded from this window."
    elif supplied_visual_result == "inconclusive":
        visual_reason = "Inconclusive inspection assigns likelihood 1 to every state."
    elif supplied_visual_result is None:
        visual_reason = "Inspection evidence: absent. Probability uses current telemetry."
    else:
        visual_reason = "Unrecognized inspection result; excluded from this window."
    # An effective LR for this frozen telemetry mixture, NOT a universal test
    # sensitivity. RGB is uninformative about a thermal-only defect.
    def effective_likelihood(anomaly):
        group = [(row, weight) for row, weight in telemetry_weighted
                 if bool(row["mechanical"] or row["thermal"]) == anomaly]
        den = _logsum([weight for _, weight in group])
        return math.exp(_logsum([weight+_log_probability(inspection_likelihood(row["mechanical"], row["thermal"], visual_result, view_spec))
                                 for row, weight in group])-den) if visual_used else 1.
    la, ln = effective_likelihood(True), effective_likelihood(False)
    calculation = {
        "version": CALCULATION_VERSION, "available": usable_asset,
        "availability_reason": "Current usable asset observations" if usable_asset else
                               "Current asset condition: Unknown. Usable stationary evidence is required.",
        "structure": model_structure(), "operation": operation,
        "priors": prior_marginals,
        "evidence_state": {"quality": quality, "mode": mode, "observation_id": reading.get("observation_id"),
                           "eligible_channels": list(residuals), "residuals": residual_trace, "baseline": baseline_trace,
                           "excluded": excluded_channels, "operating_residuals": branch_residuals,
                           "residual_scope": "conditional on known operating state" if operation["known"] else
                                             "operating-state mixture reference; likelihood uses branch residuals"},
        "states": calculation_states,
        "summaries": {"prior": prior_marginals, "telemetry_only": telemetry_marginals, "with_visual": dict(result)},
        "visual": {"result": supplied_visual_result, "used": visual_used, "reason": visual_reason,
                   "quality": view_spec["quality"], "modality": view_spec["modality"], "visibility": view_spec["visibility"],
                   "spec": view_spec,
                   "observation_id": (visual.get("observation_id") or visual.get("inspection_id") or visual.get("id")) if isinstance(visual, dict) else None,
                   "likelihood_if_anomaly": la, "likelihood_if_normal": ln, "likelihood_ratio": la/ln if ln else None,
                   "likelihood_scope": "Effective likelihood averaged over this telemetry-only state mixture",
                   "before": telemetry_marginals["anomaly"], "after": result["anomaly"],
                   "delta_pp": 100*(result["anomaly"]-telemetry_marginals["anomaly"])},
        "likelihood_groups": [
            {"name": "correlated_mechanical", "channels": [k for k in ("vibration_rms", "tilt_deg") if k in residuals],
             "correlation": rho, "sensor_fault_correlation": .25,
             "method": "Joint vibration/tilt Gaussian with marginalization over missing channels."},
            {"name": "temperature", "channels": ["temperature_c"] if "temperature_c" in residuals else [],
             "method": "Thermal and operating-state conditional Gaussian, unknown load retains uncertainty."},
            {"name": "voltage", "channels": ["voltage_pu"] if "voltage_pu" in residuals else [],
             "method": "Voltage evidence conditioned on energized state and sensor health."},
            {"name": "sensor_fault_families", "channels": list(residuals),
             "weights": {"temperature": .4, "mechanical": .4, "voltage": .1, "all": .1},
             "method": "Shared F is marginalized before normalization."}],
        "assumptions": ["BN structure: manually specified.",
                        "Synthetic uncalibrated prior and fault likelihoods.",
                        "Current wind conditions the mechanical prior. Forecasts guide dispatch feasibility.",
                        "Eight fault combinations per operating state allow sensor and asset faults to coexist.",
                        "Evidence groups contribute conditional observation likelihoods.",
                        "Each calculation uses the current observation window and its eligible inspection."]}
    if not usable_asset:
        status = "Unknown"
    elif result["anomaly"] >= .65:
        status = "Anomaly"
    elif result["sensor_fault"] >= .25 or (quality == "suspect" and not flying):
        status = "Sensor issue"
    elif result["anomaly"] >= .12:
        status = "Investigate"
    elif len(residuals) < 3:
        status = "Limited evidence"
    else:
        status = "Normal"
    alternatives = ["Wind-driven motion is included in the baseline; unexplained residuals still require investigation.",
                    "Installation movement or sensor drift can coexist with an asset anomaly."]
    if weather.get("load_pu") is None:
        missing.append("load_pu: unknown; temperature baseline retains load uncertainty")
        alternatives.append("Load and solar exposure contribute to temperature uncertainty.")
    if not operation["known"]:
        alternatives.append("Unknown operation is represented by energized and de-energized hypotheses alongside sensor-fault hypotheses.")
    elif not operation["energized"]:
        alternatives.append("Known de-energization conditions the voltage baseline.")
    elif residuals.get("voltage_pu", 0) < -3:
        alternatives.append("Voltage conflicts with the operating record: verify switching records and sensor installation.")
    if visual_used:
        alternatives.append("RGB inspection evaluates visible mechanical evidence. Thermal inspection evaluates heat anomalies.")
    if flying:
        alternatives.append("Rotor motion contaminates vibration/tilt; mechanical observations are excluded in flight.")
    # For uncertain E, apply severe residual gates only when severe under every
    # credible operation branch; a low-baseline branch must not invent urgency.
    urgent = quality == "valid" and any(
        all(test(values) for values in branch_residuals.values()) for test in (
            lambda z: z.get("temperature_c", 0) >= 9,
            lambda z: z.get("vibration_rms", 0) >= 8 and abs(z.get("tilt_deg", 0)) >= 7))
    return {**result, "status": status, "evidence": evidence, "alternatives": alternatives, "missing": missing,
            "joint_states": joint_states, "priors": priors, "operation": operation,
            "model_version": MODEL_VERSION, "quality": quality, "urgent": urgent, "calculation": calculation,
            "observation_scope": "current window only; synthetic uncalibrated model",
            "urgent_basis": "synthetic residual limits; request human assessment" if urgent else None}
