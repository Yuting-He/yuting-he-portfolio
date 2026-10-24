"""Independent analytic checks for the current-window BN and action losses."""
from copy import deepcopy
import itertools
import json
import math

import pytest

from gridscout.asset_inference import infer_asset
from gridscout.action_policy import DEFAULT_COSTS, recommend_actions


@pytest.fixture
def inputs():
    baseline = {key: {"mean": mean, "sd": sd, "low": mean-2*sd, "high": mean+2*sd}
                for key, mean, sd in [("temperature_c", 25, 2), ("vibration_rms", 1, .2),
                                      ("voltage_pu", 1, .02), ("tilt_deg", 0, .5)]}
    weather = {"wind_mps": 4, "gust_mps": 6, "load_pu": .5, "energized": True}
    reading = {key: values["mean"] for key, values in baseline.items()}
    reading.update(sensor_id="D1", asset_id="LINE_001", quality="valid", mode="perched")
    return reading, baseline, weather


def test_exact_joint_posterior_matches_independent_enumeration(inputs):
    reading, baseline, weather = inputs
    reading["temperature_c"] = 29
    # Only one channel isolates the fault-family mixture and provides an exact
    # independently calculated Bayes check without calling model internals.
    reading.update(vibration_rms=None, tilt_deg=None, voltage_pu=None)
    observed = infer_asset(reading, baseline, weather)
    normal = lambda z, mu, sd: math.exp(-.5*((z-mu)/sd)**2) / (sd*math.sqrt(2*math.pi))
    expected = {}
    for m, t, s in itertools.product((False, True), repeat=3):
        prior = (.025 if m else .975)*(.025 if t else .975)*(.045 if s else .955)
        healthy = normal(2, 5 if t else 0, 2 if t else 1)
        # Half of sensor-fault families affect temperature (.4 + .1), half do not.
        likelihood = .5*normal(2, 5 if t else 0, 7)+.5*healthy if s else healthy
        expected[m, t, s] = prior*likelihood
    total = sum(expected.values())
    for state in observed["joint_states"]:
        key = tuple(state[k] for k in ("mechanical", "thermal", "sensor_fault"))
        assert state["probability"] == pytest.approx(expected[key]/total)
    assert sum(s["probability"] for s in observed["joint_states"]) == pytest.approx(1)


def test_normal_wind_and_mechanical_anomaly_separate(inputs):
    reading, baseline, weather = inputs
    weather.update(wind_mps=16, gust_mps=22)
    # A large raw signal is normal if it agrees with this weather's baseline.
    baseline["vibration_rms"]["mean"] = reading["vibration_rms"] = 4
    normal = infer_asset(reading, baseline, weather)
    abnormal = infer_asset({**reading, "vibration_rms": 5.4, "tilt_deg": 3}, baseline, weather)
    assert normal["status"] == "Normal"
    assert normal["anomaly"] < .03
    assert abnormal["mechanical"] > .85
    assert abnormal["anomaly"] > normal["anomaly"]


def test_future_and_warning_do_not_confirm_current_damage(inputs):
    reading, baseline, weather = inputs
    original = infer_asset(reading, baseline, weather)
    future = infer_asset(reading, baseline, {**weather, "forecast": {"gust_mps": 100},
                                            "warnings": [{"severity": "extreme"}]*10})
    assert future == original


def test_missing_returns_priors_and_unknown_not_zero(inputs):
    _, baseline, weather = inputs
    result = infer_asset({"quality": "stale"}, baseline, weather)
    assert result["status"] == "Unknown"
    assert result["evidence"] == []
    assert result["mechanical"] == pytest.approx(.025)
    assert result["thermal"] == pytest.approx(.025)
    assert result["anomaly"] == pytest.approx(1-.975**2)
    assert recommend_actions(result)[0]["action"] == "inspect_sensor"


def test_flight_mechanical_evidence_excluded(inputs):
    reading, baseline, weather = inputs
    result = infer_asset({**reading, "mode": "in_flight", "vibration_rms": 500, "tilt_deg": 300}, baseline, weather)
    assert result["mechanical"] == pytest.approx(.025)
    assert {item["channel"] for item in result["evidence"]} == {"temperature_c", "voltage_pu"}
    assert "in-flight" in " ".join(result["missing"])
    assert not result["urgent"]


def test_correlation_changes_joint_not_single_channel_likelihood(inputs):
    reading, baseline, weather = inputs
    reading.update(vibration_rms=1.5, tilt_deg=1.25)
    joint = infer_asset(reading, {**baseline, "mechanical_correlation": .8}, weather)
    independent = infer_asset(reading, {**baseline, "mechanical_correlation": 0}, weather)
    assert joint["mechanical"] != pytest.approx(independent["mechanical"])
    reading["tilt_deg"] = None
    assert infer_asset(reading, {**baseline, "mechanical_correlation": .8}, weather)["mechanical"] == pytest.approx(
        infer_asset(reading, {**baseline, "mechanical_correlation": 0}, weather)["mechanical"])


def test_sensor_and_asset_faults_can_coexist_and_visual_is_uncertain(inputs):
    reading, baseline, weather = inputs
    reading.update(vibration_rms=2.4, tilt_deg=3.0, temperature_c=37, quality="suspect")
    result = infer_asset(reading, baseline, weather)
    assert sum(s["probability"] for s in result["joint_states"] if s["sensor_fault"] and (s["mechanical"] or s["thermal"])) > 0
    clear = infer_asset(reading, baseline, weather, visual="clear")
    supports = infer_asset(reading, baseline, weather, visual="supports")
    assert 0 < clear["anomaly"] < result["anomaly"] < supports["anomaly"] < 1


def test_operations_state_does_not_invent_asset_damage(inputs):
    reading, baseline, weather = inputs
    reading["voltage_pu"] = baseline["voltage_pu"]["mean"] = 0
    result = infer_asset(reading, baseline, {**weather, "energized": False})
    assert result["status"] == "Normal"
    assert any("de-energization" in text for text in result["alternatives"])


def test_window_recomputation_is_pure_and_json_finite(inputs):
    reading, baseline, weather = inputs
    snapshot = deepcopy(inputs)
    first = infer_asset(reading, baseline, weather)
    assert infer_asset(reading, baseline, weather) == first
    assert inputs == snapshot
    extreme = infer_asset({**reading, "temperature_c": 1e200}, baseline, weather)
    json.dumps({"inference": extreme, "actions": recommend_actions(extreme)}, allow_nan=False)


def _inference(p, sensor=.05):
    return {"status": "Investigate", "anomaly": p, "sensor_fault": sensor,
            "joint_states": [{"mechanical": a, "thermal": False, "sensor_fault": s,
                              "probability": (p if a else 1-p)*(sensor if s else 1-sensor)}
                             for a in (False, True) for s in (False, True)]}


def test_review_evsi_matches_independent_bayes_and_terminal_minimum():
    p = .2
    actions = recommend_actions(_inference(p, 0), minutes_to_review=5)
    remote = next(action for action in actions if action["action"] == "remote_review")
    c = DEFAULT_COSTS
    terminal = lambda a: min(a*c["missed_event"], c["field_check"]+(1-a)*c["false_positive"]+a*c["residual_event"])
    predicted = p*c["remote_sensitivity"]+(1-p)*(1-c["remote_specificity"])
    positive = p*c["remote_sensitivity"]/predicted
    negative = p*(1-c["remote_sensitivity"])/(1-predicted)
    downstream = .88*(predicted*terminal(positive)+(1-predicted)*terminal(negative))+.12*terminal(p)
    assert remote["evsi"] == pytest.approx(terminal(p)-downstream)
    assert remote["expected_loss"] == pytest.approx(c["remote_review"]+p*c["waiting_per_minute"]*5+downstream)
    assert actions[0]["action"] == "remote_review"
    assert sum(outcome["probability"] for outcome in remote["outcomes"]) == pytest.approx(1)
    assert {outcome["next_action"] for outcome in remote["outcomes"]} == {"monitor", "field_check"}


def test_decisions_respond_to_cost_and_delay():
    result = _inference(.2, 0)
    assert recommend_actions(result)[0]["action"] == "remote_review"
    assert recommend_actions(result, {"field_check": 1, "false_positive": 1})[0]["action"] == "field_check"
    assert recommend_actions(result, {"missed_event": .1})[0]["action"] == "monitor"
    fast = next(a for a in recommend_actions(result, minutes_to_review=1) if a["action"] == "remote_review")
    slow = next(a for a in recommend_actions(result, minutes_to_review=50) if a["action"] == "remote_review")
    assert slow["expected_loss"] > fast["expected_loss"]
    assert next(a for a in recommend_actions(_inference(0, 0)) if a["action"] == "remote_review")["evsi"] == pytest.approx(0)


def test_sensor_check_and_urgent_escalation_are_real_alternatives(inputs):
    assert recommend_actions(_inference(.001, .95))[0]["action"] == "inspect_sensor"
    reading, baseline, weather = inputs
    severe = infer_asset({**reading, "temperature_c": 49}, baseline, weather)
    assert severe["urgent"]
    assert recommend_actions(severe)[0]["action"] == "urgent_review"
    assert recommend_actions(severe)[0]["next_check_minutes"] == 0


def test_bad_cost_inputs_fallback_and_all_actions_are_finite():
    overrides = {"field_check": float("nan"), "false_positive": float("inf"), "missed_event": -2,
                 "remote_sensitivity": 5, "sensor_specificity": None, "unused": 100}
    actions = recommend_actions(_inference(.3), overrides, minutes_to_review=float("nan"))
    assert sum(a["recommended"] for a in actions) == 1
    assert [a["expected_loss"] for a in actions] == sorted(a["expected_loss"] for a in actions)
    json.dumps(actions, allow_nan=False)
