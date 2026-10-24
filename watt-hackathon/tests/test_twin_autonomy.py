"""Closed-loop scheduling, independent inspections and bounded human handoff."""
from copy import deepcopy
import inspect
import json

import pytest

from gridscout import autonomous_ops, twin_engine
from gridscout.synthetic_inspection import generate_inspection
from gridscout.twin_engine import TwinSimulation


def test_legacy_mode_has_no_automatic_commands_or_new_outcomes():
    sim = TwinSimulation("mechanical", 42).advance_to(55)
    assert not sim.autonomous and not sim.operations and not sim.human_alerts
    assert all(d.flight_count == 0 for d in sim.drones)
    assert not sim.visual_evidence


def test_report_based_queue_flight_inspect_complete_and_preserved_sentinels():
    sim = TwinSimulation("mechanical", 42, autonomous=True)
    assert sim.operations == []
    sentinel = {d.sensor_id: d.asset_id for d in sim.drones[:2]}
    sim.step()
    assert len(sim.operations) == 4
    assert all(o["status"] == "queued" for o in sim.operations)
    sim.step()
    flying = [o for o in sim.operations if o["status"] == "flying"]
    assert len(flying) == 2
    for operation in flying:
        assert operation["asset_id"] in sim.charging_sites
        assert operation["flight_minutes"] <= 30
        assert operation["arrival_at"] <= 10  # Received forecast's risky window.
        assert sim.current(operation["origin_asset"])["status"] == "Unknown"
        assert sim.current(operation["origin_asset"])["anomaly"] is None
        assert "report" in operation["selection_reason"].lower()
    sim.advance_to(15)
    assert all(o["status"] == "completed" for o in sim.operations)
    for operation in flying:
        assert [item["status"] for item in operation["stages"]] == ["queued", "flying", "inspecting", "completed"]
        assert operation["inspection_due_at"] - operation["inspection_started_at"] == 4
        drone = sim._drone(operation["sensor_id"])
        assert drone.status == "charging" and drone.charge_ready_at == operation["arrival_at"] + 180
        assert sim.available_targets(drone.sensor_id) == []
    assert {d.sensor_id: d.asset_id for d in sim.drones[:2]} == sentinel
    assert sim.current("LINE_024")["status"] == "Unknown"


def test_autonomous_anomaly_loop_collects_independent_view_and_one_human_incident():
    sim = TwinSimulation("mechanical", 42, autonomous=True).advance_to(55)
    checks = [o for o in sim.operations if o["kind"] == "anomaly_check"]
    assert len(checks) == 1
    check = checks[0]
    assert check["sensor_id"] == "Drone 1" and check["asset_id"] == "LINE_026"
    assert check["status"] == "completed" and check["result"] == "supports"
    assert check["posterior_after"] > check["posterior_before"]
    assert len(sim.human_alerts) == 1
    alert = sim.human_alerts[0]
    assert alert["asset_id"] == check["asset_id"] and alert["operation_id"] == check["id"]
    assert alert["created_at"] < check["completed_at"]  # BN's field action is not delayed.
    assert "field inspection" in alert["action"].lower()
    sim.advance_to(100)
    assert len([o for o in sim.operations if o["kind"] == "anomaly_check"]) == 1
    assert len(sim.human_alerts) == 1
    # Periodic coverage can now use remaining ready drones after the initial two
    # legs; the confirmed local incident itself does not launch duplicate checks.
    assert sum(d.flight_count for d in sim.drones) > 2
    assert sim._drone("Drone 1").flight_count == 0


@pytest.mark.parametrize("scenario", ["normal", "gusts"])
def test_normal_wind_and_isolated_false_camera_flag_do_not_dispatch_humans(scenario):
    sim = TwinSimulation(scenario, 42, autonomous=True).advance_to(55)
    assert not sim.human_alerts
    assert all(o["kind"] == "report_check" for o in sim.operations)
    # The deterministic demo includes imperfect positive views on healthy lines;
    # current telemetry plus the low prior keep these below a field-action level.
    assert any(o["result"] == "supports" for o in sim.operations)
    assert all("Continue monitoring" in o["outcome"] for o in sim.operations if o["status"] == "completed")
    assert all(o["result"] is None for o in sim.operations if o["status"] != "completed")


def test_noisy_inspection_is_not_a_label_and_controller_cannot_read_simulator_truth():
    kwargs = dict(sensor_id="Drone 1", asset_id="A", minute=55,
                  operation_id="test-view", scenario="mechanical", anomaly_asset_id="A")
    outcomes = [generate_inspection(**kwargs, seed=seed) for seed in range(50)]
    assert {o["result"] for o in outcomes} == {"clear", "supports", "inconclusive"}
    assert outcomes[0] == generate_inspection(**kwargs, seed=0)
    assert all("mechanical_anomaly" not in o and "hidden" not in o for o in outcomes)
    controller = inspect.getsource(autonomous_ops)
    assert "hidden_scenario_state" not in controller
    assert "self.sim.scenario" not in controller and "self.sim._scenario_asset" not in controller


def test_duplicate_refresh_cannot_multiply_evidence_or_persistence():
    sim = TwinSimulation("mechanical", 42, autonomous=True).advance_to(34)
    before = deepcopy(sim.current("LINE_026"))
    operations, alerts = len(sim.operations), len(sim.human_alerts)
    count = sim._operations._signals["LINE_026"]["count"]
    for _ in range(3):
        sim._refresh_assessments()
        sim._operations.tick()
    assert sim.current("LINE_026")["anomaly"] == before["anomaly"]
    assert sim._operations._signals["LINE_026"]["count"] == count
    assert len(sim.operations) == operations and len(sim.human_alerts) == alerts
    assert len([event for event in sim.audit if event["type"] == "autonomous_inspection_received"
                and event["operation_id"] == "op-005"]) == 1


def test_forecast_defer_visible_then_dispatch_after_forecast_clears():
    sim = TwinSimulation("mechanical", 42).advance_to(20)
    sim.set_autonomous(True).step()
    assert sim.operations
    sim.step()
    deferred = [o for o in sim.operations if o["status"] == "deferred"]
    assert deferred and all("forecast" in o["reason"].lower() or "gust" in o["reason"].lower() for o in deferred)
    assert all(d.flight_count == 0 for d in sim.drones)
    sim.advance_to(60)
    assert all(o["status"] == "completed" for o in deferred)
    assert all(any(stage["status"] == "deferred" for stage in o["stages"]) for o in deferred)
    assert all(o["started_at"] >= 44 for o in deferred)  # Received numerical revision at44 clears risk.
    for operation in deferred:
        weather = next(w for w in sim.weather_history if w["observed_at"] == operation["started_at"])
        assert weather["gust_mps"] < 18 and weather["forecast"]["gust_mps"] < 18
        assert weather["forecast"]["received_at"] <= operation["started_at"]


def test_lost_stream_has_bounded_explicit_handoff_and_never_turns_green():
    sim = TwinSimulation("dropout", 42, autonomous=True).advance_to(34)
    assert not [a for a in sim.human_alerts if a["category"] == "telemetry"]
    sim.step()
    alerts = [a for a in sim.human_alerts if a["category"] == "telemetry"]
    assert len(alerts) == 1 and alerts[0]["created_at"] == 35
    assert sim.current("LINE_009")["status"] == "Unknown"
    sim.advance_to(55)
    assert len([a for a in sim.human_alerts if a["category"] == "telemetry"]) == 1
    sim.acknowledge_alert(alerts[0]["id"])
    sim.step()
    assert alerts[0]["status"] == "acknowledged"
    assert "human review" in alerts[0]["resolution"]


def test_immediate_urgency_bypasses_inspection_and_acknowledged_escalation_reopens():
    sim = TwinSimulation("normal", 42, autonomous=True).advance_to(2)
    asset = sim.drones[0].asset_id
    alert = sim._operations._alert(asset, "asset", "high", "Existing review", "Evidence", "Review")
    sim.acknowledge_alert(alert["id"])
    sim.assessments[asset].update(urgent=True, urgent_basis="Synthetic severe observation")
    sim._operations.tick()
    assert len(sim.human_alerts) == 1
    assert alert["status"] == "open" and alert["severity"] == "critical"
    assert "do not wait" in alert["action"].lower()
    assert len(alert["acknowledgment_history"]) == 1
    sim.acknowledge_alert(alert["id"])
    sim._operations.tick()
    assert alert["status"] == "acknowledged"  # Stable severity does not re-notify.


def test_persistent_ambiguity_has_bounded_handoff_after_inconclusive_view(monkeypatch):
    original = twin_engine.infer_asset
    camera = twin_engine.generate_inspection

    def ambiguous(reading, baseline, weather, visual=None):
        result = original(reading, baseline, weather, visual)
        if reading["sensor_id"] == "Drone 1":
            result.update(status="Investigate", anomaly=.12, mechanical=.12, thermal=0,
                          sensor_fault=0, urgent=False, joint_states=[
                              {"mechanical": False, "thermal": False, "sensor_fault": False, "probability": .88},
                              {"mechanical": True, "thermal": False, "sensor_fault": False, "probability": .12}])
        return result

    def inconclusive(*args, **kwargs):
        return {**camera(*args, **kwargs), "result": "inconclusive"}

    monkeypatch.setattr(twin_engine, "infer_asset", ambiguous)
    monkeypatch.setattr(twin_engine, "generate_inspection", inconclusive)
    sim = TwinSimulation("normal", 42, autonomous=True).advance_to(10)
    assert not [a for a in sim.human_alerts if a["category"] == "asset"]
    sim.step()
    alerts = [a for a in sim.human_alerts if a["category"] == "asset"]
    assert len(alerts) == 1 and alerts[0]["created_at"] == 11
    assert "ambiguity" in alerts[0]["title"].lower()
    assert sim.visual_evidence["LINE_026"]["result"] == "inconclusive"
    assert sim.current("LINE_026")["status"] == "Investigate"


def test_disabling_auto_stops_new_dispatch_but_finishes_existing_flights():
    sim = TwinSimulation("normal", 42, autonomous=True).advance_to(2)
    sim.set_autonomous(False).advance_to(15)
    assert all(o["status"] == "completed" for o in sim.operations)
    assert sum(d.flight_count for d in sim.drones) == 2
    paused = TwinSimulation("normal", 42, autonomous=True).advance_to(1)
    paused.set_autonomous(False).advance_to(10)
    assert all(o["status"] == "queued" for o in paused.operations)
    assert all(d.flight_count == 0 for d in paused.drones)


def test_blocked_deadline_and_mission_horizon_have_explicit_handover():
    sim = TwinSimulation("normal", 42, autonomous=True).advance_to(1)
    # Invalidate a queued destination without overriding any flight guard.
    queued = next(o for o in sim.operations if o["asset_id"] != o["origin_asset"])
    # This check requires target telemetry; a later nearby camera-only view
    # cannot complete the blocked coverage-restoration requirement.
    queued["requires_target_telemetry"] = True
    sim.charging_sites.remove(queued["asset_id"])
    sim.advance_to(66)
    assert queued["status"] == "deferred"
    assert any(a["category"] == "blocked" and a["asset_id"] == queued["asset_id"] for a in sim.human_alerts)
    sim.advance_to(240)
    assert "Mission ended" in queued["reason"]
    assert sim.minute == 240


def test_export_records_actions_alerts_and_has_no_fault_selector_or_repair():
    sim = TwinSimulation("mechanical", 42, autonomous=True).advance_to(55)
    output = sim.export()
    serialized = json.dumps(output, allow_nan=False)
    assert output["autonomous"] and output["operations_summary"]["completed"] == 5
    assert len(output["human_alerts"]) == 1
    assert "asset_fault_target" not in serialized and "hidden_scenario_state" not in serialized
    assert "anomaly_asset_id" not in serialized
    assert all(o["kind"] in {"report_check", "anomaly_check"} for o in output["operations"])
    assert all(o["updated_at"] <= 55 for o in output["operations"])
    assert all(e["received_at"] <= 55 for e in output["visual_evidence"].values())
    assert "imagery" in output["assumptions"]["inspection"]
