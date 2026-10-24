"""The public story must preserve decision-time evidence and task causality."""
from copy import deepcopy
import json
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


def frame(replay, minute, asset_id="LINE_058"):
    return next(row for row in replay["frames"] if row["minute"] == minute and row["asset_id"] == asset_id)


def walk(value):
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from walk(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk(item)


def test_finite_deterministic_multi_asset_replay(replay):
    encoded = json.dumps(replay, allow_nan=False)
    assert len(encoded.encode("utf-8")) < 3_000_000
    assert build_showcase_data() == replay
    assert sum(chapter["duration_seconds"] for chapter in replay["chapters"]) == replay["metadata"]["duration_seconds"] == 105
    assert len(replay["chapters"]) == replay["metadata"]["chapter_count"] == 9
    assert replay["metadata"]["asset_ids"] == ["LINE_058", "LINE_015"]
    assert len(replay["geometry"]) == 64
    for chapter in replay["chapters"]:
        for minute in chapter["frame_minutes"]:
            assert frame(replay, minute, chapter["asset_id"])["asset_id"] == chapter["asset_id"]
    assert len({row["snapshot_id"] for row in replay["frames"]}) == len(replay["frames"])
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


def test_nearby_imagery_never_creates_target_contact_telemetry(replay):
    for snapshot in (row for row in replay["frames"] if row["asset_id"] == "LINE_058"):
        assert snapshot["map_states"]["LINE_058"] == {"status": "Unknown", "anomaly": None}
        assert snapshot["explanation"]["reading"] is None
        assert snapshot["explanation"]["assessment"]["anomaly"] is None
        assert not snapshot["explanation"]["calculation"]["available"]
        assert not snapshot["explanation"]["visual"]["used"]
        if snapshot["minute"] < 51:
            assert snapshot["explanation"]["visual"]["evidence"] is None
            assert not snapshot["explanation"]["inspection_history"]
        if snapshot["operation"] and snapshot["minute"] < 51:
            assert snapshot["operation"]["result"] is None
            assert snapshot["operation"]["posterior_before"] is None


def test_assignment_reuses_nearby_drone_before_a_remote_flight(replay):
    assert frame(replay, 44)["operation"] is None
    request = frame(replay, 46)["inspection_requests"][0]
    assert request["received_at"] == 46
    assert request["priority"] == "high"
    dispatch = frame(replay, 47)
    operation = dispatch["operation"]
    assert operation["sensor_id"] == "Drone 4"
    assert operation["origin_asset"] == "LINE_025"
    assert operation["status"] == "inspecting"
    assert operation["observation_mode"] == "nearby_stationary"
    score = operation["decision_explanation"]["score_components"]
    assert score["current_bn_risk"] == score["value_of_information"] == 0
    candidates = {row["sensor_id"]: row for row in dispatch["candidates"]}
    assert candidates["Drone 1"]["flight_minutes"] == 3
    assert not candidates["Drone 1"]["eligible"]
    assert "Anomaly" in candidates["Drone 1"]["reason"]
    assert candidates["Drone 5"]["eligible"]
    assert candidates["Drone 5"]["coverage_penalty"] == 0
    assert not candidates["Drone 3"]["eligible"]
    assert candidates["Drone 4"]["eligible"]
    assert candidates["Drone 4"]["flight_minutes"] == 0
    assert candidates["Drone 4"]["score"] < candidates["Drone 5"]["score"]
    assert "180-minute recharge" in candidates["Drone 3"]["reason"]


def test_nearby_access_preserves_positions_charge_and_no_target_route(replay):
    geometry = {row["asset_id"]: row for row in replay["geometry"]}
    origin, target = (geometry[asset]["position"] for asset in ("LINE_025", "LINE_058"))
    access = frame(replay, 47)["operation"]["inspection_access"]
    assert access["distance_m"] == pytest.approx(haversine_km(origin, target) * 1000)
    assert 7 < access["distance_m"] < 8
    assert access["distance_m"] < access["radius_m"] == 25
    assert access["shared_endpoint"]
    for snapshot in replay["frames"]:
        if snapshot["asset_id"] == "LINE_058":
            assert snapshot["route"] is None
        drone = next(row for row in snapshot["fleet"] if row["sensor_id"] == "Drone 4")
        assert drone["asset_id"] == "LINE_025"
        assert drone["position"] == pytest.approx(origin)
        assert drone["status"] == "charging" and drone["charge_ready_at"] == 186
        assert drone["flight_count"] == 1
        assert not any(row.get("target_asset") == "LINE_058" for row in snapshot["fleet"])
    # The freed drone can still serve a distinct, distant follow-up.
    drone5 = next(row for row in frame(replay, 60)["fleet"] if row["sensor_id"] == "Drone 5")
    assert drone5["target_asset"] == "LINE_015"


def test_image_completion_keeps_a_human_coverage_review_open(replay):
    assert frame(replay, 47)["operation"]["inspection_due_at"] == 51
    assert frame(replay, 50)["operation"]["status"] == "inspecting"
    assert frame(replay, 50)["operation"]["result"] is None
    assert not frame(replay, 50)["human_alerts"]
    assert frame(replay, 51)["operation"]["status"] == "completed"
    assert frame(replay, 51)["operation"]["result"] == "clear"
    alert_before = frame(replay, 51)["human_alerts"][0]
    alert_after = frame(replay, 60)["human_alerts"][0]
    assert alert_before["id"] == alert_after["id"]
    assert alert_before["category"] == "coverage"
    assert alert_before["created_at"] == 51
    assert alert_after["status"] == "open"
    assert alert_after["acknowledged_at"] is None


def test_image_provenance_records_observer_and_target_without_a_fake_bn_delta(replay):
    final = frame(replay, 60)
    explanation = final["explanation"]
    evidence = explanation["visual"]["evidence"]
    comparison = explanation["inspection_history"][-1]
    assert evidence["sensor_id"] == "Drone 4"
    assert evidence["asset_id"] == "LINE_058"
    assert evidence["observer_asset_id"] == "LINE_025"
    assert evidence["observation_mode"] == "nearby_stationary"
    assert evidence["received_at"] == 51
    assert comparison["telemetry_observation_id"] is None
    assert comparison["before_anomaly"] is None
    assert comparison["after_anomaly"] is None
    assert comparison["delta_pp"] is None


def test_frames_are_exact_historical_model_outputs_and_independent(replay):
    simulation = TwinSimulation("dynamic", seed=42, autonomous=True)
    for snapshot in replay["frames"]:
        simulation.advance_to(snapshot["minute"])
        asset = snapshot["asset_id"]
        assert snapshot["explanation"] == simulation.explain_asset(asset)
        assert snapshot["recommendations"] == simulation.recommendations[asset]
        assert all(alert["asset_id"] == asset for alert in snapshot["human_alerts"])
        assert all(request["asset_id"] == asset for request in snapshot["inspection_requests"])
        assert all(event.get("asset_id") == asset or event.get("target_asset") == asset for event in snapshot["audit"])
        assert all(decision["asset_id"] == asset for plan in snapshot["replans"] for decision in plan["decisions"])
        if snapshot["operation"]:
            assert snapshot["operation"]["asset_id"] == asset
    copied = deepcopy(replay)
    frame(copied, 60)["operation"]["stages"].append({"status": "changed"})
    assert frame(copied, 47)["operation"] == frame(replay, 47)["operation"]
    frame(copied, 60)["human_alerts"][0]["status"] = "resolved"
    assert frame(copied, 51)["human_alerts"][0]["status"] == "open"


def test_same_minute_targets_are_distinct_frozen_records(replay):
    nearby = frame(replay, 51, "LINE_058")
    distant = frame(replay, 51, "LINE_015")
    assert nearby["snapshot_id"] != distant["snapshot_id"]
    assert nearby["operation"]["status"] == "completed"
    assert distant["operation"]["status"] == "queued"
    assert nearby["human_alerts"] and not distant["human_alerts"]
    assert nearby["explanation"]["visual"]["evidence"] is not None
    assert distant["explanation"]["visual"]["evidence"] is None
    chapters = replay["chapters"]
    assert [chapter["asset_id"] for chapter in chapters[:5]] == ["LINE_058"] * 5
    assert [chapter["asset_id"] for chapter in chapters[5:]] == ["LINE_015"] * 4
    assert chapters[-1]["frame_minutes"] == [82]  # The quoted BN comparison stays in its original window.
    assert all(left["end_minute"] <= right["start_minute"] for left, right in zip(chapters, chapters[1:]))


def test_distant_drone_flight_uses_real_recorded_positions_and_no_transit_diagnosis(replay):
    geometry = {row["asset_id"]: row for row in replay["geometry"]}
    departure = frame(replay, 52, "LINE_015")
    route = departure["route"]
    assert route["sensor_id"] == "Drone 5"
    assert route["origin_asset"] == "LINE_009" and route["target_asset"] == "LINE_015"
    assert route["minute"] == 52 and route["arrival_at"] == 78 and route["flight_minutes"] == 26
    assert route["coordinates"] == [geometry["LINE_009"]["position"], geometry["LINE_015"]["position"]]
    for minute in range(52, 78):
        snapshot = frame(replay, minute, "LINE_015")
        assert snapshot["operation"]["status"] == "flying"
        assert snapshot["explanation"]["reading"] is None
        assert snapshot["explanation"]["assessment"]["status"] == "Unknown"
        drone = next(row for row in snapshot["fleet"] if row["sensor_id"] == "Drone 5")
        fraction = (minute - 52) / 26
        expected = [a + fraction * (b - a) for a, b in zip(*route["coordinates"])]
        assert drone["position"] == pytest.approx(expected)
    arrival = frame(replay, 78, "LINE_015")
    drone = next(row for row in arrival["fleet"] if row["sensor_id"] == "Drone 5")
    assert drone["asset_id"] == "LINE_015" and drone["status"] == "charging"
    assert drone["charge_ready_at"] == 258
    assert arrival["operation"]["inspection_due_at"] == 82
    assert arrival["explanation"]["reading"]["asset_id"] == "LINE_015"


def test_arrival_enables_real_bn_and_received_image_updates_the_same_window(replay):
    for minute in (78, 79, 80, 81):
        snapshot = frame(replay, minute, "LINE_015")
        assert snapshot["operation"]["status"] == "inspecting"
        assert snapshot["operation"]["result"] is None
        assert snapshot["explanation"]["calculation"]["available"]
        assert not snapshot["explanation"]["visual"]["used"]
        assert snapshot["explanation"]["visual"]["evidence"] is None
    complete = frame(replay, 82, "LINE_015")
    operation, explanation = complete["operation"], complete["explanation"]
    assert operation["status"] == "completed" and operation["completed_at"] == 82
    assert operation["result"] == "clear"
    assert explanation["visual"]["used"]
    summaries = explanation["calculation"]["summaries"]
    assert summaries["prior"]["anomaly"] == pytest.approx(.049375)
    assert summaries["telemetry_only"]["anomaly"] == pytest.approx(.0009969270388812902)
    assert summaries["with_visual"]["anomaly"] == pytest.approx(.0005801628216714783)
    assert operation["posterior_before"] == summaries["telemetry_only"]["anomaly"]
    assert operation["posterior_after"] == summaries["with_visual"]["anomaly"]
    comparison = explanation["inspection_history"][-1]
    assert comparison["available"] and comparison["visual_used"]
    assert comparison["telemetry_observation_id"] == explanation["reading"]["observation_id"]
    assert comparison["before_anomaly"] == operation["posterior_before"]
    assert comparison["after_anomaly"] == operation["posterior_after"]
    assert complete["recommendations"][0]["action"] == "monitor"
    assert complete["human_alerts"] == []
    # Later windows are recomputed; the historical T+82 comparison stays frozen.
    later = frame(replay, 84, "LINE_015")["explanation"]
    assert later["reading"]["observation_id"] != explanation["reading"]["observation_id"]
    assert later["inspection_history"][-1] == comparison


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
