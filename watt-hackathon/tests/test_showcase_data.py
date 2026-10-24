"""The public story must preserve decision-time evidence and task causality."""
from copy import deepcopy
import json
import math
from pathlib import Path

import pytest

from gridscout.asset_inference import MODEL_VERSION
from gridscout.official_data import haversine_km
from gridscout.showcase_data import (
    DEFAULT_OUTPUT, build_showcase_data, load_showcase_data, main,
    source_fingerprint,
)
from gridscout.twin_engine import TwinSimulation


@pytest.fixture(scope="module")
def replay():
    return build_showcase_data()


def frame(replay, minute):
    return next(row for row in replay["frames"] if row["minute"] == minute)


def walk(value):
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from walk(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk(item)


def test_finite_small_deterministic_75_second_replay(replay):
    encoded = json.dumps(replay, allow_nan=False)
    assert len(encoded.encode("utf-8")) < 2_000_000
    assert build_showcase_data() == replay
    assert sum(chapter["duration_seconds"] for chapter in replay["chapters"]) == 75
    assert len(replay["chapters"]) == 6
    assert len(replay["geometry"]) == 64
    for chapter in replay["chapters"]:
        for minute in chapter["frame_minutes"]:
            assert frame(replay, minute)["asset_id"] == "LINE_058"
    assert replay["metadata"]["code_hash"] == source_fingerprint()
    assert replay["metadata"]["model_version"] == MODEL_VERSION


def test_received_evidence_never_comes_from_the_future(replay):
    forbidden = {"hidden_state", "fault_target", "asset_fault_target", "mechanical_strength",
                 "truth", "asset_truth", "sensor_truth", "measurement_drift"}
    for snapshot in replay["frames"]:
        minute = snapshot["minute"]
        for record in walk(snapshot):
            assert not forbidden.intersection(record)
            for key in ("received_at", "observed_at", "completed_at", "inspection_started_at"):
                if record.get(key) is not None:
                    assert record[key] <= minute, (minute, key, record[key])
        assert all(event["minute"] <= minute for event in snapshot["audit"])
        assert all(row["minute"] <= minute for row in snapshot["replans"])


def test_unobserved_target_stays_unknown_until_stationary_arrival(replay):
    for minute in (44, 46, *range(47, 56)):
        snapshot = frame(replay, minute)
        assert snapshot["map_states"]["LINE_058"] == {"status": "Unknown", "anomaly": None}
        assert snapshot["explanation"]["reading"] is None
        assert snapshot["explanation"]["assessment"]["anomaly"] is None
        assert not snapshot["explanation"]["visual"]["used"]
        assert not snapshot["explanation"]["inspection_history"]
        if snapshot["operation"]:
            assert snapshot["operation"]["result"] is None
            assert snapshot["operation"]["posterior_before"] is None
    # Sub-minute timestamps model acquisition delay; the first on-site window
    # is still the arrival window, not a measurement made while in flight.
    assert frame(replay, 56)["explanation"]["reading"]["window_id"] == "Drone 5:LINE_058:56"
    assert frame(replay, 56)["explanation"]["assessment"]["anomaly"] > .8


def test_dispatch_uses_received_lead_and_origin_coverage_not_later_bn(replay):
    assert frame(replay, 44)["operation"] is None
    request = frame(replay, 46)["inspection_requests"][0]
    assert request["received_at"] == 46
    assert request["priority"] == "high"
    dispatch = frame(replay, 47)
    operation = dispatch["operation"]
    assert operation["sensor_id"] == "Drone 5"
    assert operation["origin_asset"] == "LINE_009"
    assert operation["status"] == "flying"
    score = operation["decision_explanation"]["score_components"]
    assert score["current_bn_risk"] == score["value_of_information"] == 0
    candidates = {row["sensor_id"]: row for row in dispatch["candidates"]}
    assert candidates["Drone 1"]["flight_minutes"] == 3
    assert not candidates["Drone 1"]["eligible"]
    assert "Anomaly" in candidates["Drone 1"]["reason"]
    assert candidates["Drone 5"]["eligible"]
    assert candidates["Drone 5"]["coverage_penalty"] == 0
    assert not candidates["Drone 3"]["eligible"]
    assert not candidates["Drone 4"]["eligible"]
    assert "180-minute recharge" in candidates["Drone 3"]["reason"]


def test_route_distance_speed_clock_and_positions_are_consistent(replay):
    route = frame(replay, 47)["route"]
    origin, target = route["coordinates"]
    assert route["distance_km"] == pytest.approx(haversine_km(origin, target))
    assert route["distance_km"] == pytest.approx(21.318779)
    assert route["flight_speed_mps"] == 40
    assert route["flight_minutes"] == math.ceil(route["distance_km"] / (40 * .06)) == 9
    assert route["departure_at"] == 47 and route["arrival_at"] == 56
    for minute in range(47, 57):
        drone = next(row for row in frame(replay, minute)["fleet"] if row["sensor_id"] == "Drone 5")
        fraction = (minute - 47) / 9
        expected = [a + fraction * (b - a) for a, b in zip(origin, target)]
        assert drone["position"] == pytest.approx(expected)
        assert drone["status"] == ("flying" if minute < 56 else "charging")
    assert frame(replay, 46)["route"] is None


def test_inspection_order_and_unresolved_human_alert_survive_clear_result(replay):
    assert frame(replay, 56)["operation"]["status"] == "inspecting"
    assert frame(replay, 56)["operation"]["inspection_due_at"] == 60
    assert not frame(replay, 56)["human_alerts"]
    alert_before = frame(replay, 58)["human_alerts"][0]
    alert_after = frame(replay, 60)["human_alerts"][0]
    assert alert_before["id"] == alert_after["id"] == "alert-002"
    assert alert_before["created_at"] == 58
    assert alert_after["status"] == "open"
    assert alert_after["acknowledged_at"] is None
    assert frame(replay, 58)["operation"]["result"] is None
    assert frame(replay, 60)["operation"]["result"] == "clear"
    assert frame(replay, 60)["recommendations"][0]["action"] == "inspect_sensor"


def test_same_window_comparison_uses_real_frozen_calculation(replay):
    final = frame(replay, 60)
    explanation = final["explanation"]
    summaries = explanation["calculation"]["summaries"]
    comparison = explanation["inspection_history"][-1]
    assert summaries["prior"]["anomaly"] == pytest.approx(.049375)
    assert summaries["telemetry_only"]["anomaly"] == pytest.approx(.88447262615)
    assert summaries["with_visual"]["anomaly"] == pytest.approx(.55529922035)
    assert comparison["telemetry_observation_id"] == explanation["reading"]["observation_id"]
    assert comparison["before_anomaly"] == summaries["telemetry_only"]["anomaly"]
    assert comparison["after_anomaly"] == summaries["with_visual"]["anomaly"]
    assert comparison["delta_pp"] == pytest.approx(-32.91734058)
    assert len(explanation["calculation"]["states"]) == 8
    assert explanation["visual"]["evidence"]["received_at"] == 60


def test_frames_are_exact_historical_model_outputs_and_independent(replay):
    simulation = TwinSimulation("dynamic", seed=42, autonomous=True)
    for snapshot in replay["frames"]:
        simulation.advance_to(snapshot["minute"])
        assert snapshot["explanation"] == simulation.explain_asset("LINE_058")
        assert snapshot["recommendations"] == simulation.recommendations["LINE_058"]
    copied = deepcopy(replay)
    frame(copied, 60)["operation"]["stages"].append({"status": "changed"})
    assert frame(copied, 47)["operation"] == frame(replay, 47)["operation"]
    frame(copied, 60)["human_alerts"][0]["status"] = "resolved"
    assert frame(copied, 58)["human_alerts"][0]["status"] == "open"


def test_current_bundle_and_validation_are_bound_to_same_model():
    data = load_showcase_data()
    validation = data["validation"]
    assert validation["metadata"]["model_version"] == data["metadata"]["model_version"]
    assert validation["metadata"]["code_hash"] == data["metadata"]["code_hash"]
    assert validation["metadata"]["seeds"] == list(range(42, 48))
    assert validation["metadata"]["minute"] == 55
    assert validation["metadata"]["executed_optional_actions"] == 0
    counts = validation["overall"]["counts"]
    assert counts["stationed_samples"] == 180
    assert counts["observed"] == 174 and counts["missing"] == 6
    drift = validation["overall"]["sensor_drift_detection"]["confusion"]
    assert drift == {"true_positive": 1, "false_positive": 1,
                     "true_negative": 167, "false_negative": 5}
    assert "cases" not in validation  # no per-case hidden truth in the public bundle


def test_source_identity_survives_git_line_ending_conversion(monkeypatch):
    expected = source_fingerprint()
    original = Path.read_bytes
    monkeypatch.setattr(Path, "read_bytes", lambda path: original(path).replace(b"\r\n", b"\n").replace(b"\n", b"\r\n"))
    assert source_fingerprint() == expected


def test_current_loader_rejects_unbound_validation(tmp_path):
    data = json.loads(DEFAULT_OUTPUT.read_text(encoding="utf-8"))
    data["validation"]["metadata"]["code_hash"] = "old-evaluation"
    output = tmp_path / "mismatch.json"
    output.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError, match="Validation"):
        load_showcase_data(output)
    data["validation"] = None
    output.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError, match="Validation"):
        load_showcase_data(output)


def test_stale_bundle_rejected_and_cli_serializes_only_finite_json(tmp_path):
    output = tmp_path / "nested" / "showcase.json"
    data = main(["--skip-validation", "--output", str(output)])
    assert json.loads(output.read_text(encoding="utf-8")) == data
    data["metadata"]["code_hash"] = "stale"
    output.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError, match="different model/source version"):
        load_showcase_data(output)
    assert load_showcase_data(output, require_current=False)["metadata"]["code_hash"] == "stale"
