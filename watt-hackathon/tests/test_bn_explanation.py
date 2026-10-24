"""Audit the displayed BN arithmetic independently from model helper functions."""
from copy import deepcopy
import itertools
import json
import math

import pytest

from gridscout.asset_inference import infer_asset


@pytest.fixture
def inputs():
    baseline = {key: {"mean": mean, "sd": sd, "low": mean-1.96*sd, "high": mean+1.96*sd}
                for key, mean, sd in [("temperature_c", 25, 2), ("vibration_rms", 1, .2),
                                      ("voltage_pu", 1, .02), ("tilt_deg", 0, .5)]}
    baseline["mechanical_correlation"] = .71
    reading = {"temperature_c": 30, "vibration_rms": 1.7, "voltage_pu": 1.01,
               "tilt_deg": 1.5, "quality": "valid", "mode": "perched", "observation_id": "window-1"}
    weather = {"wind_mps": 4, "gust_mps": 18, "load_pu": None, "energized": True}
    return reading, baseline, weather


def _normal(z, mean, sd):
    return math.exp(-.5*((z-mean)/sd)**2) / (sd*math.sqrt(2*math.pi))


def _independent_likelihood(z, m, t, s, rho):
    families = [("temperature", .4), ("mechanical", .4), ("voltage", .1), ("all", .1)] if s else [("none", 1)]
    total = 0
    for family, probability in families:
        faulty_mechanical = family in {"mechanical", "all"}
        sd = 6 if faulty_mechanical else (2 if m else 1)
        r = .25 if faulty_mechanical else rho
        mechanical = 0
        for direction in [-1, 1]:
            a = (z["vibration_rms"]-(5 if m else 0))/sd
            b = (z["tilt_deg"]-(direction*5 if m else 0))/sd
            mechanical += .5 * math.exp(-(a*a-2*r*a*b+b*b)/(2*(1-r*r))) / (2*math.pi*sd*sd*math.sqrt(1-r*r))
        thermal = _normal(z["temperature_c"], 5 if t else 0,
                          7 if family in {"temperature", "all"} else (2 if t else 1))
        voltage = _normal(z["voltage_pu"], 0, 8 if family in {"voltage", "all"} else 1)
        total += probability*mechanical*thermal*voltage
    return total


def test_full_trace_recomputes_all_eight_states_and_union(inputs):
    reading, baseline, weather = inputs
    result = infer_asset(reading, baseline, weather, {"result": "supports", "observation_id": "camera-1"})
    calc = result["calculation"]
    assert calc["available"]
    assert calc["version"] == "window-bn-calculation-2.0"
    z = {key: (reading[key]-baseline[key]["mean"])/baseline[key]["sd"]
         for key in ("temperature_c", "vibration_rms", "voltage_pu", "tilt_deg")}
    prior_m, prior_t, prior_s = .037, .025, .045
    raw, raw_without = [], []
    for row, (m, t, s) in zip(calc["states"], itertools.product((False, True), repeat=3)):
        prior = (prior_m if m else 1-prior_m)*(prior_t if t else 1-prior_t)*(prior_s if s else 1-prior_s)
        likelihood = _independent_likelihood(z, m, t, s, .71)
        visual = .85 if m else .08
        assert row["prior_probability"] == pytest.approx(prior)
        assert math.exp(row["log_sensor_likelihood"]) == pytest.approx(likelihood)
        assert row["visual_likelihood"] == pytest.approx(visual)
        raw_without.append(prior*likelihood)
        raw.append(prior*likelihood*visual)
    for row, a, b in zip(calc["states"], raw_without, raw):
        assert row["posterior_without_visual"] == pytest.approx(a/sum(raw_without))
        assert row["posterior_probability"] == pytest.approx(b/sum(raw))
    for stage, key in [("telemetry_only", "posterior_without_visual"), ("with_visual", "posterior_probability")]:
        marginal = calc["summaries"][stage]
        assert marginal["anomaly"] == pytest.approx(sum(row[key] for row in calc["states"] if row["mechanical"] or row["thermal"]))
        for name in ("mechanical", "thermal", "sensor_fault"):
            assert marginal[name] == pytest.approx(sum(row[key] for row in calc["states"] if row[name]))
    assert calc["priors"]["anomaly"] == pytest.approx(1-(1-prior_m)*(1-prior_t))
    assert calc["summaries"]["with_visual"]["anomaly"] == result["anomaly"]
    assert calc["visual"]["observation_id"] == "camera-1"
    json.dumps(calc, allow_nan=False)


@pytest.mark.parametrize("visual,direction", [("supports", 1), ("clear", -1), ("inconclusive", 0), (None, 0)])
def test_inspection_delta_is_same_window_bayes_counterfactual(inputs, visual, direction):
    reading, baseline, weather = inputs
    no_visual = infer_asset(reading, baseline, weather)
    result = infer_asset(reading, baseline, weather, visual)
    calc = result["calculation"]
    check = calc["visual"]
    assert check["before"] == no_visual["anomaly"]
    assert check["after"] == result["anomaly"]
    assert check["delta_pp"] == pytest.approx(100*(check["after"]-check["before"]))
    assert check["used"] == (direction != 0)
    if direction:
        p = check["before"]
        expected = p*check["likelihood_if_anomaly"]/(p*check["likelihood_if_anomaly"]+(1-p)*check["likelihood_if_normal"])
        assert check["after"] == pytest.approx(expected)
        assert check["delta_pp"]*direction > 0
    else:
        assert check["before"] == check["after"]
        assert check["likelihood_ratio"] == 1


def test_suspect_trace_exposes_raw_and_applied_residuals(inputs):
    reading, baseline, weather = inputs
    result = infer_asset({**reading, "quality": "suspect"}, baseline, weather)
    trace = result["calculation"]["evidence_state"]
    assert trace["quality"] == "suspect"
    for channel, residual in trace["residuals"].items():
        assert residual["raw_z"] == pytest.approx((reading[channel]-baseline[channel]["mean"])/baseline[channel]["sd"])
        assert residual["used_z"] == pytest.approx(residual["raw_z"]/1.5)
        assert residual["uncertainty_scale"] == 1.5
        assert trace["baseline"][channel] == baseline[channel]
    assert result["calculation"]["priors"]["sensor_fault"] == .35


@pytest.mark.parametrize("quality", ["missing", "stale", "invalid"])
def test_unusable_channels_do_not_show_priors_as_health(inputs, quality):
    reading, baseline, weather = inputs
    result = infer_asset({**reading, "quality": quality}, baseline, weather)
    calc = result["calculation"]
    assert result["status"] == "Unknown"
    assert not calc["available"]
    assert calc["evidence_state"]["eligible_channels"] == []
    assert len(calc["evidence_state"]["excluded"]) == 4
    assert "Usable stationary evidence" in calc["availability_reason"]
    assert calc["summaries"]["telemetry_only"]["anomaly"] == pytest.approx(calc["priors"]["anomaly"])


def test_partial_missing_flight_and_voltage_only_are_explained(inputs):
    reading, baseline, weather = inputs
    partial = infer_asset({**reading, "temperature_c": None, "mode": "in_flight"}, baseline, weather)
    calc = partial["calculation"]
    assert not calc["available"]
    assert calc["evidence_state"]["eligible_channels"] == ["voltage_pu"]
    assert "in-flight" in calc["evidence_state"]["excluded"]["tilt_deg"]
    assert next(group for group in calc["likelihood_groups"] if group["name"] == "correlated_mechanical")["channels"] == []


def test_invalid_visual_and_repeated_calls_do_not_compound(inputs):
    reading, baseline, weather = inputs
    snapshot = deepcopy(inputs)
    original = infer_asset(reading, baseline, weather)
    stale = infer_asset(reading, baseline, weather, {"result": "supports", "quality": "stale", "inspection_id": "expired-1"})
    assert stale["anomaly"] == original["anomaly"]
    assert not stale["calculation"]["visual"]["used"]
    assert stale["calculation"]["visual"]["observation_id"] == "expired-1"
    assert "quality" in stale["calculation"]["visual"]["reason"]
    first = infer_asset(reading, baseline, weather, "supports")
    for _ in range(5):
        assert infer_asset(reading, baseline, weather, "supports") == first
    assert inputs == snapshot


def test_correlation_and_sensor_mixture_are_groups_not_additive_votes(inputs):
    reading, baseline, weather = inputs
    calc = infer_asset(reading, baseline, weather)["calculation"]
    joint = next(group for group in calc["likelihood_groups"] if group["name"] == "correlated_mechanical")
    assert joint["channels"] == ["vibration_rms", "tilt_deg"]
    assert joint["correlation"] == .71
    mixture = next(group for group in calc["likelihood_groups"] if group["name"] == "sensor_fault_families")
    assert sum(mixture["weights"].values()) == pytest.approx(1)
    assert any("conditional observation" in assumption for assumption in calc["assumptions"])
    single = infer_asset({**reading, "tilt_deg": None}, baseline, weather)["calculation"]
    single_zero = infer_asset({**reading, "tilt_deg": None}, {**baseline, "mechanical_correlation": 0}, weather)["calculation"]
    assert single["summaries"]["with_visual"] == single_zero["summaries"]["with_visual"]


def test_extreme_finite_data_trace_is_json_safe(inputs):
    reading, baseline, weather = inputs
    result = infer_asset({**reading, "temperature_c": 1e200}, baseline, weather)
    residual = result["calculation"]["evidence_state"]["residuals"]["temperature_c"]
    assert residual["clipped"]
    assert residual["clipped_z"] == 1000
    json.dumps(result, allow_nan=False)
