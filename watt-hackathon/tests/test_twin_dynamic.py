"""Received evidence changes actual dispatch, with hard flight/recharge guards."""
from copy import deepcopy

import pytest

from gridscout import twin_engine
from gridscout.autonomous_ops import MAX_EPISODE_CHECKS, TERMINAL
from gridscout.twin_engine import TwinSimulation


def quiet_sim():
    sim = TwinSimulation("normal", 42).advance_to(60)
    sim.set_autonomous(True)
    sim._operations._planned = True
    sim._operations._last_coverage_review = sim.minute
    return sim


def test_live_origin_evidence_reassigns_pending_task_and_explains_all_five():
    sim = quiet_sim()
    sim.receive_inspection_request("LINE_058", request_id="live", priority="high", reason="New received movement lead")
    sim._operations.tick()
    operation = sim.operations[0]
    first = operation["sensor_id"]
    origin = sim._drone(first).asset_id
    sim.assessments[origin].update(status="Anomaly", anomaly=.8)
    sim._operations.tick()
    assert operation["sensor_id"] != first
    rows = operation["decision_explanation"]["candidates"]
    assert {r["sensor_id"] for r in rows} == {d.sensor_id for d in sim.drones}
    blocked = next(r for r in rows if r["sensor_id"] == first)
    assert not blocked["eligible"] and "Retain origin" in blocked["reason"]
    assert all({"ready_at", "eta_at", "coverage_penalty", "flight_speed_mps", "observation_need"} <= r.keys() for r in rows)
    assert sim.replans[-1]["decisions"][0]["action"] == "reassigned"


def _next_task_after_view(result):
    sim = quiet_sim()
    for drone in sim.drones[:-1]:
        drone.needs_charge = True
        drone.charge_ready_at = 240
    completed = sim._operations._new_operation("report_check", "LINE_026", sim.drones[0], "Received independent camera view", "routine", 70)
    completed.update(status="completed", completed_at=60, result=result, finding=f"Received {result} view", human_required=False)
    sim.receive_inspection_request("LINE_028", request_id="ordinary", reason="Competing routine request")
    sim.receive_inspection_request("LINE_058", request_id="followup", reason="Geographic follow-up to received view", related_asset_id="LINE_026")
    sim._operations.tick()
    sim.step()
    flying = next(o for o in sim.operations if o["status"] == "flying")
    return sim, flying


def test_actual_inspection_outcome_changes_next_dispatched_task_counterfactually():
    positive, positive_task = _next_task_after_view("supports")
    negative, negative_task = _next_task_after_view("clear")
    assert positive_task["asset_id"] == "LINE_058"
    assert negative_task["asset_id"] == "LINE_028"
    assert positive_task["sensor_id"] == negative_task["sensor_id"] == "Drone 5"
    assert positive_task["decision_explanation"]["score_components"]["related_inspection"] == 15
    assert positive_task["flight_speed_mps"] <= 60
    assert positive.current("LINE_009")["anomaly"] is None


def test_received_revision_and_cancel_are_idempotent_and_visible():
    sim = TwinSimulation("dynamic", 42, autonomous=True).advance_to(32)
    revised = [o for o in sim.operations if o.get("request_id") == "SYN-LEAD-REVISION"]
    assert [(o["asset_id"], o["status"]) for o in revised] == [("LINE_028", "superseded"), ("LINE_002", "cancelled")]
    count = len(sim.operations)
    events = deepcopy(sim.inspection_requests)
    for event in events:
        sim.receive_inspection_request(**event)
    sim._operations.tick()
    assert len(sim.operations) == count
    assert any(d["action"] == "cancelled" for p in sim.replans for d in p["decisions"])
    # Late delivery of an older revision must not resurrect the Cancel tombstone.
    sim.receive_inspection_request("LINE_028", request_id="SYN-LEAD-REVISION", event_id="late-old", msg_type="Update", issued_at=25, received_at=32)
    sim._operations.tick()
    assert len(sim.operations) == count


def test_committed_flight_is_preserved_and_updated_target_gets_successor():
    sim = quiet_sim()
    sim.receive_inspection_request("LINE_058", request_id="moving", priority="high")
    sim._operations.tick()
    sim.step()
    first = sim.operations[0]
    assert first["status"] == "flying"
    drone = sim._drone(first["sensor_id"])
    target, arrival = drone.target_asset, drone.arrival_at
    sim.receive_inspection_request("LINE_028", request_id="moving", event_id="rev2", msg_type="Update", priority="high")
    sim._operations.tick()
    assert (drone.target_asset, drone.arrival_at) == (target, arrival)
    assert any(o["asset_id"] == "LINE_028" and o is not first for o in sim.operations)
    sim.advance_to(arrival)
    assert first["status"] == "cancelled"
    assert drone.charge_ready_at == arrival + 180


def test_dynamic_run_can_fly_again_only_after_full_recharge():
    sim = TwinSimulation("dynamic", 42, autonomous=True).advance_to(240)
    departures = [e for e in sim.audit if e["type"] == "relocation"]
    assert len(departures) > 2
    assert any(d.flight_count > 1 for d in sim.drones)
    arrivals = [e for e in sim.audit if e["type"] == "arrival"]
    for drone in sim.drones:
        legs = [e for e in departures if e["sensor_id"] == drone.sensor_id]
        for previous, current in zip(legs, legs[1:]):
            arrived = next(e for e in arrivals if e["sensor_id"] == drone.sensor_id and e["minute"] == previous["arrival_at"])
            assert current["minute"] >= arrived["charge_ready_at"]
        assert all(0 < leg["flight_speed_mps"] <= 60 and leg["flight_minutes"] <= 30 for leg in legs)


def test_charge_blocks_remote_launch_but_permits_local_inspection_and_deadline_handoff():
    sim = quiet_sim()
    for drone in sim.drones:
        drone.needs_charge = True
        drone.status = "charging"
        drone.charge_ready_at = 240
    sim.receive_inspection_request("LINE_058", request_id="blocked", deadline_at=62)
    sim.receive_inspection_request("LINE_026", request_id="local", priority="high")
    sim._operations.tick()
    sim.step(2)
    remote = next(o for o in sim.operations if o["asset_id"] == "LINE_058")
    local = next(o for o in sim.operations if o["asset_id"] == "LINE_026")
    assert remote["status"] == "deferred" and all(not r["eligible"] for r in remote["decision_explanation"]["candidates"])
    assert local["status"] == "inspecting"
    assert any(a["category"] == "blocked" and a["asset_id"] == "LINE_058" for a in sim.human_alerts)
    assert all(d.flight_count == 0 for d in sim.drones)


def test_incident_rearms_after_fresh_clear_windows_and_ambiguity_retries_are_bounded(monkeypatch):
    original = twin_engine.infer_asset
    camera = twin_engine.generate_inspection

    def changing(reading, baseline, weather, visual=None):
        result = original(reading, baseline, weather, visual)
        minute = reading["received_at"]
        if reading["sensor_id"] == "Drone 1" and (10 <= minute <= 20 or minute >= 31):
            result.update(status="Investigate", anomaly=.12, mechanical=.12, thermal=0, sensor_fault=0, urgent=False,
                          joint_states=[{"mechanical": False, "thermal": False, "sensor_fault": False, "probability": .88},
                                        {"mechanical": True, "thermal": False, "sensor_fault": False, "probability": .12}])
        return result

    def inconclusive(*args, **kwargs):
        return {**camera(*args, **kwargs), "result": "inconclusive"}

    monkeypatch.setattr(twin_engine, "infer_asset", changing)
    monkeypatch.setattr(twin_engine, "generate_inspection", inconclusive)
    sim = TwinSimulation("normal", 42, autonomous=True)
    sim._operations._planned = True
    sim._operations._last_coverage_review = 240
    sim.advance_to(85)
    checks = [o for o in sim.operations if o["kind"] == "anomaly_check"]
    incidents = {o["incident_id"] for o in checks}
    assert len(incidents) == 2
    assert all(sum(o["incident_id"] == incident for o in checks) <= MAX_EPISODE_CHECKS for incident in incidents)
    assert len(checks) == 3  # One first episode, two bounded views in second.
    assert all(o["result"] == "inconclusive" for o in checks)
    assert any(a["category"] == "asset" for a in sim.human_alerts)


def test_same_window_refresh_does_not_generate_plan_churn():
    sim = quiet_sim()
    sim.receive_inspection_request("LINE_058", request_id="one")
    sim._operations.tick()
    plans = len(sim.replans)
    for _ in range(5):
        sim._operations.tick()
    assert len(sim.replans) == plans


def test_inspection_completion_releases_dependency_in_the_same_paused_window():
    sim = TwinSimulation("dynamic", 42, autonomous=True).advance_to(51)
    inspected = next(o for o in sim.operations if o["asset_id"] == "LINE_058")
    followup = next(o for o in sim.operations if o.get("request_id") == "SYN-LEAD-FOLLOWUP")
    assert inspected["status"] == "completed" and inspected["completed_at"] == sim.minute
    explanation = followup["decision_explanation"]
    assert explanation["chosen_at"] == sim.minute
    assert all("requires the inspection result" not in row["reason"] for row in explanation["candidates"])
    assert explanation["score_components"]["related_inspection"] == (-8 if inspected["result"] == "clear" else 15 if inspected["result"] == "supports" else 0)
    assert sim.replans[-1]["minute"] == inspected["completed_at"]
    assert "inspection result" in sim.replans[-1]["trigger"]
    assert any(d["operation_id"] == inspected["id"] and d["action"] == "result reviewed"
               for d in sim.replans[-1]["decisions"])


def test_requests_are_causal_and_export_includes_decision_history():
    sim = quiet_sim()
    with pytest.raises(ValueError, match="issued <= received"):
        sim.receive_inspection_request("LINE_058", received_at=61)
    sim.receive_inspection_request("LINE_058", request_id="export")
    sim._operations.tick()
    output = sim.export()
    assert output["inspection_requests"][0]["received_at"] <= output["minute"]
    assert len(output["operations"][0]["decision_explanation"]["candidates"]) == 5
    assert output["replans"] and output["assumptions"]["max_speed_mps"] == 60
    assert not any(o["status"] in TERMINAL and o["status"] not in {"completed", "cancelled", "superseded"} for o in output["operations"])
