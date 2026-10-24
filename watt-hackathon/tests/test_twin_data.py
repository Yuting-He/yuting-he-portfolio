"""Behavioral checks for the synthetic data boundary, not hardware validation."""
from copy import deepcopy
import math

import numpy as np
import pytest

from gridscout.conditional_baseline import CHANNELS, fit_normal_baseline
from gridscout.official_data import choose_sites, load_official_dataset
from gridscout.synthetic_telemetry import SCENARIOS, generate_reading, hidden_scenario_state
from gridscout.weather_context import resolve_warnings, weather_at


def test_fitted_reference_is_stable_and_live_data_does_not_retrain_it():
    baseline = fit_normal_baseline(42)
    parameters = deepcopy(baseline.coefficients)
    expected = baseline.predict(weather_at(12))
    for minute in range(70):
        generate_reading("Drone 1", "LINE_001", minute, weather_at(minute))
    assert baseline.coefficients == parameters
    assert baseline.predict(weather_at(12)) == expected
    assert baseline.training_count >= 1000
    assert 0.45 < baseline.mechanical_correlation < 0.8
    assert baseline.version == fit_normal_baseline(42).version
    assert baseline.version != fit_normal_baseline(7).version


def test_reference_explains_wind_and_load_and_preserves_unknown_load():
    baseline = fit_normal_baseline()
    context = dict(ambient_c=20, wind_mps=3, gust_mps=5, solar_wm2=500, load_pu=0.5, energized=True)
    normal = baseline.predict(context)
    windy = baseline.predict({**context, "wind_mps": 13, "gust_mps": 20})
    loaded = baseline.predict({**context, "load_pu": 1.0})
    unknown = baseline.predict({**context, "load_pu": None})
    assert windy["vibration_rms"]["mean"] > normal["vibration_rms"]["mean"] + 1
    assert windy["tilt_deg"]["mean"] > normal["tilt_deg"]["mean"]
    assert loaded["temperature_c"]["mean"] > normal["temperature_c"]["mean"] + 15
    assert unknown["temperature_c"]["sd"] > 3 * normal["temperature_c"]["sd"]
    assert unknown["vibration_rms"] == normal["vibration_rms"]
    # Voltage can identify operation state but may not serve as a load proxy.
    assert loaded["voltage_pu"] == normal["voltage_pu"]
    off = baseline.predict({**context, "energized": False})
    assert off["voltage_pu"]["mean"] < 0.02
    assert off["temperature_c"]["mean"] < normal["temperature_c"]["mean"]
    assert baseline.predict(context, "flying")["tilt_deg"]["sd"] > 5 * normal["tilt_deg"]["sd"]


def test_independent_healthy_stream_usually_within_conditional_envelopes():
    baseline = fit_normal_baseline()
    within, total = {channel: 0 for channel in CHANNELS}, 0
    # Multiple devices and weather states; generators intentionally misspecified.
    for minute in range(0, 90, 2):
        context = weather_at(minute, "gusts")
        prediction = baseline.predict(context)
        for index in range(1, 6):
            reading = generate_reading(f"Drone {index}", f"LINE_{index:03}", minute, context, "gusts")
            total += 1
            for channel in CHANNELS:
                within[channel] += prediction[channel]["low"] <= reading[channel] <= prediction[channel]["high"]
    assert all(within[channel] / total > 0.84 for channel in CHANNELS), within


def test_repeatability_no_truth_leak_and_order_independence():
    context = weather_at(45)
    reading = generate_reading("Drone 1", "LINE_001", 45, context)
    generate_reading("Drone 3", "LINE_022", 60, weather_at(60))
    assert reading == generate_reading("Drone 1", "LINE_001", 45, context)
    assert reading != generate_reading("Drone 1", "LINE_001", 45, context, seed=7)
    assert set(CHANNELS) <= reading.keys()
    assert not {"truth", "failed", "fault", "scenario", "true_load", "load_pu", "hidden_state"} & reading.keys()
    assert reading["observed_at"] <= reading["received_at"] <= 45
    assert context["load_pu"] is None
    for channel in CHANNELS:
        assert math.isfinite(reading[channel])


def test_mechanical_injection_persists_after_warning_cancel_and_calm():
    baseline = fit_normal_baseline()
    early_context = weather_at(20, "mechanical")
    early_mech = generate_reading("Drone 1", "LINE_001", 20, early_context, "mechanical")
    early_normal = generate_reading("Drone 1", "LINE_001", 20, early_context, "gusts")
    assert [early_mech[key] for key in CHANNELS] == [early_normal[key] for key in CHANNELS]
    context = weather_at(60, "mechanical")
    prediction = baseline.predict(context)
    affected = generate_reading("Drone 1", "LINE_001", 60, context)
    healthy = generate_reading("Drone 2", "LINE_002", 60, context)
    assert not context["warnings"]
    assert context["wind_mps"] < 4
    assert affected["tilt_deg"] > prediction["tilt_deg"]["high"] + 1
    assert affected["vibration_rms"] > prediction["vibration_rms"]["high"] + 0.5
    assert healthy["tilt_deg"] < prediction["tilt_deg"]["high"]


def test_thermal_dropout_drift_and_flight_remain_distinguishable():
    baseline = fit_normal_baseline()
    context = weather_at(60, "thermal")
    thermal = generate_reading("Drone 1", "LINE_001", 60, context, "thermal")
    assert thermal["temperature_c"] > baseline.predict(context)["temperature_c"]["high"] + 5
    lost = generate_reading("Drone 5", "LINE_005", 31, weather_at(31, "dropout"), "dropout")
    assert lost["quality"] == "missing"
    assert all(lost[channel] is None for channel in CHANNELS)
    other = generate_reading("Drone 1", "LINE_001", 31, weather_at(31, "dropout"), "dropout")
    assert other["quality"] == "valid"
    drift = generate_reading("Drone 1", "LINE_001", 65, weather_at(65, "drift"), "drift")
    assert drift["quality"] == "suspect"
    flying = generate_reading("Drone 2", "LINE_001", 15, weather_at(15), mode="flying")
    assert flying["quality"] == "suspect"
    assert hidden_scenario_state("Drone 1", 60)["mechanical_anomaly"]
    assert not hidden_scenario_state("Drone 2", 60)["mechanical_anomaly"]


def test_residual_stream_has_temporal_correlation_without_repeated_ids():
    baseline = fit_normal_baseline()
    residuals, ids = [], []
    for minute in range(100):
        context = weather_at(minute, "normal")
        reading = generate_reading("Drone 2", "LINE_001", minute, context, "normal")
        residuals.append(reading["vibration_rms"] - baseline.predict(context)["vibration_rms"]["mean"])
        ids.append(reading["window_id"])
    assert np.corrcoef(residuals[:-1], residuals[1:])[0, 1] > 0.35
    assert len(set(ids)) == 100


def test_asset_defects_stay_on_asset_while_sensor_defects_follow_device():
    context = weather_at(60)
    away = generate_reading("Drone 1", "LINE_002", 60, {**context, "asset_fault_target": False})
    on_asset = generate_reading("Drone 2", "LINE_001", 60, {**context, "asset_fault_target": True})
    assert away["tilt_deg"] < 1.1
    assert on_asset["tilt_deg"] > 2.0
    assert "asset_fault_target" not in on_asset
    drift = generate_reading("Drone 1", "LINE_002", 65, {**context, "asset_fault_target": False}, "drift")
    assert drift["quality"] == "suspect"
    explicit = {**context, "anomaly_asset_id": "LINE_001"}
    assert generate_reading("Drone 1", "LINE_002", 60, explicit)["tilt_deg"] < 1.1
    assert generate_reading("Drone 2", "LINE_001", 60, explicit)["tilt_deg"] > 2
    assert hidden_scenario_state("Drone 2", 60, asset_id="LINE_001", anomaly_asset_id="LINE_001")["mechanical_anomaly"]


def test_synthetic_warning_footprint_covers_official_deployed_assets():
    dataset = load_official_dataset()
    weather = weather_at(20)
    for asset_id in choose_sites(dataset, 5):
        position = dataset.segments[asset_id]["position"]
        assert resolve_warnings(weather["messages"], 20, position), asset_id


def test_weather_warning_lifecycle_and_known_time():
    assert weather_at(4)["messages"] == []
    assert weather_at(6)["warnings"] == []  # Received but future-valid.
    before = weather_at(10)
    assert len(before["warnings"]) == 1  # EN and DE are one event.
    assert before["warnings"][0]["severity"] == "Moderate"
    assert weather_at(18)["warnings"][0]["severity"] == "Moderate"
    assert weather_at(19)["warnings"][0]["severity"] == "Severe"
    assert len(weather_at(43)["warnings"]) == 1
    assert weather_at(44)["warnings"] == []
    assert weather_at(60)["warnings"] == []
    assert weather_at(27)["wind_mps"] > weather_at(10)["wind_mps"] + 7
    assert weather_at(45)["wind_mps"] < 4
    assert weather_at(0)["forecast"]["gust_mps"] != weather_at(27)["gust_mps"]
    assert weather_at(0)["forecast"]["peak_from"] == 10
    assert weather_at(20)["forecast"]["peak_to"] == 45
    assert "peak_from" not in weather_at(44)["forecast"]
    assert "peak_from" not in weather_at(0, "normal")["forecast"]
    for minute in (0, 7, 19, 44, 89, 90, 240):
        context = weather_at(minute)
        assert context["forecast"]["received_at"] <= minute
        assert context["forecast"]["issued_at"] <= minute
        assert context["forecast"]["valid_from"] <= minute < context["forecast"]["valid_to"]
        assert all(record["received_at"] <= minute for record in context["messages"])
    assert weather_at(20, "normal")["warnings"] == []


def test_lifecycle_duplicates_future_expiry_references_and_spatial_filter():
    alert = dict(id="a", event_id="event", issued_at=0, received_at=1, valid_from=2, valid_to=50,
                 area=[11, 47, 14, 50], msg_type="Alert", severity="Moderate")
    translated = {**alert, "id": "a-de", "received_at": 3, "language": "de"}
    update = {**alert, "id": "b", "issued_at": 10, "received_at": 12, "valid_from": 10,
              "msg_type": "Update", "references": ["a"], "severity": "Severe"}
    cancel = {**update, "id": "c", "issued_at": 20, "received_at": 21, "msg_type": "Cancel", "references": "sender,b,time"}
    messages = [cancel, alert, translated, update, deepcopy(update)]
    assert resolve_warnings(messages, 1) == []
    assert len(resolve_warnings(messages, 5)) == 1
    assert resolve_warnings(messages, 11)[0]["severity"] == "Moderate"
    assert resolve_warnings(messages, 12)[0]["severity"] == "Severe"
    assert resolve_warnings(messages, 12, (12, 48))
    assert resolve_warnings(messages, 12, (2, 40)) == []
    assert resolve_warnings(messages, 21) == []
    assert resolve_warnings(messages, 60) == []
    future_issue = {**cancel, "issued_at": 100, "received_at": 20}
    assert resolve_warnings([alert, future_issue], 25)
    # A replacement becoming valid in the future doesn't retain an old area.
    future_valid = {**update, "valid_from": 30}
    assert resolve_warnings([alert, future_valid], 15) == []
    assert resolve_warnings([alert, future_valid], 30)


@pytest.mark.parametrize("scenario", SCENARIOS)
def test_each_scenario_produces_finite_windows(scenario):
    for minute in (0, 25, 45, 240):
        context = weather_at(minute, scenario)
        reading = generate_reading("Drone 1", "LINE_001", minute, context, scenario)
        assert all(math.isfinite(reading[channel]) for channel in CHANNELS)


def test_invalid_scenario_and_time_fail_explicitly():
    with pytest.raises(ValueError):
        weather_at(-1)
    with pytest.raises(ValueError):
        weather_at(5, "typo")
    with pytest.raises(ValueError):
        generate_reading("Drone 1", "LINE_001", float("nan"), {})
