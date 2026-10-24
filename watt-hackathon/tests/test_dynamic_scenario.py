"""Causal boundaries for the evolving world, separate from scheduler policy tests."""
from copy import deepcopy

import pytest

from gridscout.dynamic_scenario import (
    dynamic_asset_state, generate_mission_requests, resolve_mission_requests,
)
from gridscout.official_data import choose_sites, haversine_km, load_official_dataset
from gridscout.synthetic_inspection import generate_inspection
from gridscout.synthetic_telemetry import CHANNELS, SCENARIOS, generate_reading, hidden_scenario_state
from gridscout.weather_context import weather_at


def test_dynamic_feed_only_releases_received_messages_and_has_stable_ids():
    assert "dynamic" in SCENARIOS
    assert generate_mission_requests(19) == []
    assert len(generate_mission_requests(20)) == 1
    assert len(generate_mission_requests(28.9)) == 1
    assert len(generate_mission_requests(29)) == 2
    assert len(generate_mission_requests(32)) == 3
    assert len(generate_mission_requests(46)) == 4
    assert len(generate_mission_requests(50)) == 5
    future = generate_mission_requests(90)
    assert generate_mission_requests(46) == [event for event in future if event["received_at"] <= 46]
    assert len({event["event_id"] for event in future}) == len(future)
    assert all(event["issued_at"] <= event["received_at"] for event in future)
    assert all(event["source"].startswith("Synthetic") and event["synthetic"] for event in future)
    assert not {"truth", "fault", "damage", "hidden_state", "mechanical_strength"} & set().union(*(event.keys() for event in future))


def test_lifecycle_supersedes_location_then_cancels_without_erasing_raw_history():
    events = generate_mission_requests(90)
    before = resolve_mission_requests(events, 20)
    assert [event["asset_id"] for event in before] == ["LINE_028"]
    corrected = resolve_mission_requests(events, 29)
    assert [event["asset_id"] for event in corrected] == ["LINE_002"]
    assert corrected[0]["msg_type"] == "Update"
    assert resolve_mission_requests(events, 32) == []
    # Future versions and out-of-order/replayed prior messages cannot reactivate.
    assert resolve_mission_requests(list(reversed(events)) + events[:1], 32) == []
    assert len(events) == 5
    assert len(resolve_mission_requests(events, 50)) == 2
    assert resolve_mission_requests(events, 130) == []


def test_feed_mutation_does_not_modify_subsequent_calls_and_works_outside_dynamic():
    events = generate_mission_requests(50)
    events[-1]["reason"] = "mutated"
    events[1]["references"].append("mutated")
    fresh = generate_mission_requests(50)
    assert fresh[-1]["reason"] != "mutated"
    assert fresh[1]["references"] == ["SYN-LEAD-REVISION:1"]
    assert generate_mission_requests(100, "mechanical") == []
    assert generate_mission_requests(100, seed=7) == fresh


@pytest.mark.parametrize("minute", [-1, float("inf"), float("nan")])
def test_invalid_world_time_rejected(minute):
    with pytest.raises(ValueError):
        generate_mission_requests(minute)
    with pytest.raises(ValueError):
        dynamic_asset_state("LINE_026", minute)


def test_weather_matches_gust_context_and_does_not_use_received_reports_as_faults():
    for minute in (0, 20, 29, 46, 50, 59, 75):
        assert weather_at(minute, "dynamic") == weather_at(minute, "gusts")
    assert weather_at(27, "dynamic")["gust_mps"] > 18
    assert weather_at(46, "dynamic")["warnings"] == []
    assert weather_at(46, "dynamic")["forecast"]["gust_mps"] < 18
    # Fallible leads can concern healthy assets; an Alert is never fault truth.
    for asset in ("LINE_028", "LINE_002", "LINE_015"):
        assert not dynamic_asset_state(asset, 60)["mechanical_anomaly"]


def test_realtime_faults_are_asset_pinned_change_after_report_and_recover():
    context = weather_at(59, "dynamic")
    faulty1 = generate_reading("Drone 1", "LINE_058", 59, context, "dynamic")
    faulty5 = generate_reading("Drone 5", "LINE_058", 59, context, "dynamic")
    healthy5 = generate_reading("Drone 5", "LINE_015", 59, context, "dynamic")
    assert faulty5["vibration_rms"] - healthy5["vibration_rms"] == pytest.approx(1.4)
    assert faulty5["tilt_deg"] - healthy5["tilt_deg"] == pytest.approx(3.0)
    assert hidden_scenario_state("Drone 1", 59, "dynamic", "LINE_058")["mechanical_anomaly"]
    assert hidden_scenario_state("Drone 5", 59, "dynamic", "LINE_058")["mechanical_anomaly"]
    assert not hidden_scenario_state("Drone 5", 59, "dynamic", "LINE_015")["mechanical_anomaly"]
    assert not dynamic_asset_state("LINE_058", 46)["mechanical_anomaly"]
    assert dynamic_asset_state("LINE_058", 53)["mechanical_strength"] == 1
    assert dynamic_asset_state("LINE_058", 91)["mechanical_strength"] == .5
    assert dynamic_asset_state("LINE_058", 94)["mechanical_strength"] == 0
    assert dynamic_asset_state("LINE_026", 55)["mechanical_strength"] == 1
    assert dynamic_asset_state("LINE_026", 72)["mechanical_strength"] == 0
    # Context, identity, order and former routes cannot move an asset defect.
    assert faulty1 == generate_reading("Drone 1", "LINE_058", 59, deepcopy(context), "dynamic")
    assert not {"mechanical_strength", "scenario", "truth", "anomaly_asset_id"} & faulty1.keys()
    assert all(faulty1[channel] is not None for channel in CHANNELS)


def test_dynamic_camera_is_imperfect_and_reads_current_asset_not_drone_truth():
    healthy, affected = [], []
    for index in range(200):
        kwargs = dict(scenario="dynamic", seed=42, anomaly_asset_id="LINE_026")
        healthy.append(generate_inspection("Drone 1", "LINE_015", 59, f"camera-{index}", **kwargs))
        affected.append(generate_inspection("Drone 5", "LINE_058", 59, f"camera-{index}", **kwargs))
    healthy_supports = sum(view["result"] == "supports" for view in healthy)
    affected_supports = sum(view["result"] == "supports" for view in affected)
    assert 0 < healthy_supports < 35
    assert 110 < affected_supports < 190
    assert any(view["result"] == "inconclusive" for view in affected)
    assert any(view["result"] == "clear" for view in affected)
    for view in affected + healthy:
        assert not {"truth", "damaged", "mechanical_anomaly", "scenario", "mechanical_strength"} & view.keys()
        assert view["observed_at"] <= view["received_at"] == 59
    assert affected[0] == generate_inspection("Drone 5", "LINE_058", 59, "camera-0", scenario="dynamic", seed=42, anomaly_asset_id="LINE_026")


def test_public_followup_dependency_is_available_before_view_without_topology_claim():
    followup = generate_mission_requests(50)[-1]
    assert followup["priority"] == "routine"
    assert followup["related_asset_id"] == followup["hold_for_inspection_asset"] == "LINE_058"
    assert "electrical connectivity is unknown" in followup["reason"]
    assert "truth" not in followup
    # Same original five starting sites; new request reachable below confirmed
    # 60 m/s maximum using the high-priority 40 m/s demonstration cruise.
    data = load_official_dataset()
    initial = choose_sites(data, 5)
    assert initial[-1] == "LINE_009"
    distance = haversine_km(data.segments[initial[-1]]["position"], data.segments["LINE_058"]["position"])
    assert 8 < distance / (40 * 60 / 1000) < 10
    assert distance / (40 * 60 / 1000) < 30
