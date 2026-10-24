"""Exercise-clock, evidence freshness, and full recharge integration checks."""
from dataclasses import asdict
import json

import pytest

from gridscout import twin_engine
from gridscout.official_data import haversine_km
from gridscout.twin_engine import TwinSimulation


def test_initial_twin_has_five_live_feature_windows_and_frozen_healthy_fit():
    state = TwinSimulation("normal", 42)
    assert state.minute == 0
    assert len(state.drones) == 5
    assert len({drone.asset_id for drone in state.drones}) == 5
    assert len(state.history) == 5
    assert "LINE_024" not in state.charging_sites
    before = asdict(state.baseline)
    for record in state.history:
        assert record["synthetic"] is True
        assert all(isinstance(record[channel], float) for channel in twin_engine.CHANNELS)
        assert all(channel in record["baseline"] for channel in twin_engine.CHANNELS)
        assert record["weather_context"].get("load_pu") is None
        assert "asset_fault_target" not in record
    state.advance_to(15)
    assert asdict(state.baseline) == before
    assert len(state.history) == 5 * 16
    assert len({record["observation_id"] for record in state.history}) == len(state.history)
    assert state.current("LINE_024")["status"] == "Unknown"


def test_mechanical_evidence_and_visual_review_change_decision_without_truth_lookup():
    state = TwinSimulation("mechanical", 42).advance_to(45)
    asset = state.drones[0].asset_id
    initial = state.current(asset)["anomaly"]
    assert state.current(asset)["status"] == "Anomaly"
    state.verify(asset, "clear")
    after = state.current(asset)["anomaly"]
    assert after < initial
    # Repeating the same review recomputes one window; it never multiplies the
    # same likelihood into a previous posterior a second time.
    state.verify(asset, "clear")
    assert state.current(asset)["anomaly"] == after
    state.step()
    assert state.visual_evidence[asset]["result"] == "clear"
    assert state.visual_evidence[asset]["observed_at"] == 45
    assert any(event["type"] == "decision_update" for event in state.audit)
    with pytest.raises(ValueError, match="stationary"):
        state.verify("LINE_024", "supports")


def test_delayed_packets_cannot_be_used_early_or_restore_stale_green(monkeypatch):
    generator = twin_engine.generate_reading

    def delayed(*args, **kwargs):
        reading = generator(*args, **kwargs)
        if args[0] == "Drone 1":
            reading["received_at"] += 3
        return reading

    monkeypatch.setattr(twin_engine, "generate_reading", delayed)
    state = TwinSimulation("normal", 42)
    asset = state.drones[0].asset_id
    assert state.current(asset)["status"] == "Unknown"
    assert not any(record["sensor_id"] == "Drone 1" for record in state.history)
    state.advance_to(3)
    assert any(record["sensor_id"] == "Drone 1" for record in state.history)
    assert state.current(asset)["status"] == "Unknown"
    assert all(record["received_at"] <= state.minute for record in state.history)
    assert all(message["received_at"] <= state.minute and message["issued_at"] <= state.minute
               for message in state.weather["messages"])
    assert all(record["received_at"] <= state.minute for record in state.export()["readings"])


def test_missing_stream_becomes_unknown_not_zero_or_last_normal():
    state = TwinSimulation("dropout", 42).advance_to(29)
    asset = state.drones[4].asset_id
    assert state.current(asset)["status"] != "Unknown"
    state.step()
    assert state.latest[asset]["quality"] == "missing"
    assert state.current(asset)["status"] == "Unknown"
    assert all(state.latest[asset][key] is None for key in twin_engine.CHANNELS)
    assert state.recommendations[asset][0]["action"] != "monitor"


def test_relocation_stops_origin_observations_then_requires_full_recharge():
    state = TwinSimulation("normal", 42)
    drone = state.drones[0]
    origin = drone.asset_id
    state.verify(origin, "inconclusive")
    target = state.available_targets(drone.sensor_id)[0]
    plan = state.relocate(drone.sensor_id, target)
    assert drone.status == "flying" and drone.needs_charge
    assert state.current(origin)["status"] == "Unknown"
    assert origin not in state.visual_evidence
    assert state.position(drone) == state.dataset.segments[origin]["position"]
    if plan["flight_minutes"] > 1:
        state.step()
        assert state.position(drone) not in (state.dataset.segments[origin]["position"],
                                             state.dataset.segments[target]["position"])
        assert len([r for r in state.history if r["sensor_id"] == drone.sensor_id]) == 1
    state.advance_to(plan["arrival_at"])
    assert drone.asset_id == target and drone.status == "charging"
    assert drone.charge_ready_at == plan["arrival_at"] + 180
    assert state.latest[target]["mode"] == "charging"
    assert state.available_targets(drone.sensor_id) == []
    with pytest.raises(ValueError, match="180-minute"):
        state.relocate(drone.sensor_id, origin)
    state.advance_to(drone.charge_ready_at - 1)
    assert drone.needs_charge and drone.status == "charging"
    state.step()
    assert not drone.needs_charge and drone.status == "perched"
    assert origin in state.available_targets(drone.sensor_id)
    assert state.latest[target]["observed_at"] > plan["arrival_at"]


def test_relocation_constraints_do_not_assume_unknown_power_from_voltage():
    state = TwinSimulation("normal", 42)
    drone = state.drones[0]
    with pytest.raises(ValueError, match="de-energized"):
        state.relocate(drone.sensor_id, "LINE_024")
    unknown = next(asset for asset in state.dataset.segments
                   if asset not in state.charging_sites and asset != "LINE_024")
    with pytest.raises(ValueError, match="Charging power is unknown"):
        state.relocate(drone.sensor_id, unknown)
    with pytest.raises(ValueError, match="occupied"):
        state.relocate(drone.sensor_id, state.drones[1].asset_id)
    occupied = {item.asset_id for item in state.drones}
    farthest = max((asset for asset in state.dataset.segments if asset not in occupied), key=lambda asset: haversine_km(
        state.dataset.segments[drone.asset_id]["position"], state.dataset.segments[asset]["position"]))
    state.charging_sites.add(farthest)
    with pytest.raises(ValueError, match="30-minute"):
        state.relocate(drone.sensor_id, farthest, speed_mps=5)
    # All rejected requests leave the drone ready at its original site.
    assert drone.status == "perched" and not drone.needs_charge


def test_weather_and_horizon_block_unavailable_flights():
    state = TwinSimulation("mechanical", 42)
    target = state.available_targets("Drone 1")[0]
    state.advance_to(27)
    assert state.weather["gust_mps"] >= 18
    assert state.available_targets("Drone 1") == []
    with pytest.raises(ValueError, match="gust"):
        state.relocate("Drone 1", target)
    state.advance_to(239)
    with pytest.raises(ValueError, match="mission time"):
        state.relocate("Drone 1", target)
    state.step(1000)
    assert state.minute == 240
    assert all(record["received_at"] <= 240 for record in state.history)
    with pytest.raises(ValueError, match="ended"):
        state.relocate("Drone 1", target)
    with pytest.raises(ValueError):
        state.advance_to(239)


def test_fault_stays_at_asset_after_sensor_redeployment_and_export_has_no_injection_selector():
    state = TwinSimulation("mechanical", 42)
    original_asset = state.drones[0].asset_id
    target = state.available_targets("Drone 1")[0]
    state.relocate("Drone 1", target)
    state.advance_to(45)
    assert state.current(original_asset)["status"] == "Unknown"
    assert state.current(target)["mechanical"] < .12
    export = state.export()
    serialized = json.dumps(export, allow_nan=False)
    assert "asset_fault_target" not in serialized
    assert "hidden_scenario_state" not in serialized
    assert export["synthetic"] is True
    assert export["baseline"]["training_count"] == 3600
    assert export["baseline"]["frozen_during_replay"] is True
    assert len(export["drones"]) == 5
    assert export["assumptions"]["charge_minutes"] == 180


def test_received_future_forecast_changes_deployment_but_not_current_damage_posterior():
    state = TwinSimulation("normal", 42)
    drone = state.drones[0]
    candidates = [(asset, state._flight_plan(drone, asset)["flight_minutes"])
                  for asset in state.available_targets(drone.sensor_id)]
    far = next(asset for asset, duration in candidates if duration > 10)
    near = next(asset for asset, duration in candidates if duration < 10)
    before = state.current(drone.asset_id)["anomaly"]
    state.weather["forecast"] = {"issued_at": 0, "received_at": 0,
                                 "valid_from": 0, "valid_to": 60,
                                 "gust_mps": 23, "peak_from": 10, "peak_to": 45}
    assert state.weather["gust_mps"] < 18  # current weather still permits flight
    assert state.weather_decision["status"] == "preposition"
    assert state._flight_plan(drone, near)["arrival_at"] < 10
    with pytest.raises(ValueError, match="forecast"):
        state._flight_plan(drone, far)
    state._refresh_assessments()
    assert state.current(drone.asset_id)["anomaly"] == before
    # A publication that has not arrived cannot influence today's plan.
    state.weather["forecast"]["received_at"] = 20
    assert state._flight_plan(drone, far)["flight_minutes"] > 10
    assert state.weather_decision["status"] == "routine"
    state.weather["forecast"]["received_at"] = 0
    state.weather["forecast"]["peak_from"] = 0
    assert state.weather_decision["status"] == "defer"
    assert state.available_targets(drone.sensor_id) == []


def test_visual_review_expires_and_no_longer_changes_current_inference():
    from gridscout.asset_inference import infer_asset

    state = TwinSimulation("mechanical", 42).advance_to(45)
    asset = state.drones[0].asset_id
    state.verify(asset, "clear")
    assert state.current(asset)["visual_status"] == "fresh"

    state.advance_to(60)
    assert state.current(asset)["visual_status"] == "fresh"
    state.step()
    actual = state.current(asset)
    assert actual["visual_status"] == "stale"
    assert any("expired" in item for item in actual["missing"])
    reading = state.latest[asset]
    conditioned = {**reading["baseline"], "mechanical_correlation": state.baseline.mechanical_correlation}
    without_visual = infer_asset(reading, conditioned, reading["weather_context"])
    assert actual["anomaly"] == pytest.approx(without_visual["anomaly"])
    assert len([event for event in state.audit if event["type"] == "visual_review_expired"]) == 1
    state.verify(asset, "clear")
    assert state.current(asset)["visual_status"] == "fresh"

def test_user_maximum_speed_and_low_quality_transit_do_not_create_line_observations():
    slow=TwinSimulation("normal",42)
    drone=slow.drones[0]
    target=slow.available_targets(drone.sensor_id)[-1]
    normal=slow._flight_plan(drone,target,speed_mps=20)
    fast=slow._flight_plan(drone,target,speed_mps=60)
    assert fast["flight_minutes"]<=normal["flight_minutes"]
    assert fast["flight_speed_mps"]==60
    with pytest.raises(ValueError,match="60"):
        slow._flight_plan(drone,target,speed_mps=61)
    before=len(slow.history)
    plan=slow.relocate(drone.sensor_id,target,speed_mps=60)
    assert slow.current(drone.origin_asset)["status"]=="Unknown"
    if plan["flight_minutes"]>1:
        slow.step()
        assert not any(r["sensor_id"]==drone.sensor_id for r in slow.history[before:])
    slow.advance_to(plan["arrival_at"])
    assert drone.charge_ready_at==plan["arrival_at"]+180
    assert slow.latest[target]["mode"]=="charging"
