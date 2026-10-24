"""Adjacent stationary imagery preserves recharge, contact scope and provenance."""
from copy import deepcopy

import pytest

from gridscout.twin_engine import NEARBY_IMAGERY_RADIUS_M, TwinSimulation


@pytest.fixture(scope="module")
def quiet_state():
    return TwinSimulation("normal", 42).advance_to(60)


@pytest.fixture
def nearby_sim(quiet_state):
    sim = deepcopy(quiet_state)
    for drone in sim.drones:
        drone.status = "charging"
        drone.needs_charge = True
        drone.charge_ready_at = 240
    drone = sim._drone("Drone 4")
    drone.asset_id = "LINE_025"
    drone.charge_started_at = 6
    drone.charge_ready_at = 186
    drone.flight_count = 1
    sim._refresh_assessments()
    sim.set_autonomous(True)
    sim._operations._planned = True
    sim._operations._last_coverage_review = 240
    return sim


def request_imagery(sim):
    sim.receive_inspection_request("LINE_058", request_id="nearby", priority="high", observation_need="imagery")
    sim._operations.tick()
    return next(o for o in sim.operations if o.get("request_id") == "nearby")


def test_dynamic_report_reuses_charging_observer_and_preserves_remote_drone():
    sim = TwinSimulation("dynamic", 42, autonomous=True).advance_to(46)
    operation = next(o for o in sim.operations if o.get("request_id") == "SYN-LEAD-WEST")
    assert operation["sensor_id"] == "Drone 4"
    assert operation["observation_need"] == "imagery" and not operation["requires_target_telemetry"]
    chosen = next(r for r in operation["decision_explanation"]["candidates"] if r["sensor_id"] == "Drone 4")
    assert chosen["eligible"] and chosen["flight_minutes"] == 0 and chosen["coverage_penalty"] == 0
    assert chosen["flight_ready_at"] == 186 and chosen["ready_at"] == 46
    assert chosen["observation_mode"] == "nearby_stationary"
    sim.advance_to(47)
    assert operation["status"] == "inspecting" and operation["inspection_due_at"] == 51
    sim.advance_to(51)
    assert operation["status"] == "completed" and operation["completed_at"] == 51
    assert operation["posterior_before"] is operation["posterior_after"] is None
    assert operation["human_required"] and "no BN update" in operation["reason"]
    drone = sim._drone("Drone 4")
    assert (drone.asset_id, drone.status, drone.charge_ready_at, drone.flight_count) == ("LINE_025", "charging", 186, 1)
    assert sim._drone("Drone 5").flight_count == 0
    assert not any(e["type"] == "relocation" and e["target_asset"] == "LINE_058" for e in sim.audit)
    assert not any(r["asset_id"] == "LINE_058" for r in sim.history)
    explanation = sim.explain_asset("LINE_058")
    assert explanation["assessment"]["status"] == "Unknown"
    assert explanation["reading"] is None and not explanation["calculation"]["available"]
    assert not explanation["visual"]["used"]
    evidence = explanation["visual"]["evidence"]
    assert evidence["asset_id"] == "LINE_058" and evidence["observer_asset_id"] == "LINE_025"
    assert evidence["inspection_access"]["distance_m"] == pytest.approx(7.342322)
    assert evidence["inspection_access"]["shared_endpoint"]
    assert not evidence["inspection_access"]["target_telemetry_available"]
    assert "unknown" in evidence["inspection_access"]["electrical_connectivity"]
    history = explanation["inspection_history"][-1]
    assert not history["available"] and not history["visual_used"]
    assert history["before_anomaly"] is history["after_anomaly"] is None
    assert "Independent imagery only" in history["comparison_scope"]
    assert any(a["asset_id"] == "LINE_058" and a["category"] == "coverage" for a in sim.human_alerts)
    # The released drone remains useful for the next, genuinely remote lead.
    sim.advance_to(53)
    followup = next(o for o in sim.operations if o.get("request_id") == "SYN-LEAD-FOLLOWUP")
    assert followup["sensor_id"] == "Drone 5" and followup["status"] == "flying"
    assert followup["asset_id"] == "LINE_015" and followup["flight_minutes"] > 0


@pytest.mark.parametrize("change", ["too_far", "no_shared_endpoint", "flying"])
def test_nearby_access_requires_all_geometric_and_stationary_guards(nearby_sim, change):
    sim = nearby_sim
    drone = sim._drone("Drone 4")
    assert sim.stationary_inspection_access(drone, "LINE_058")["eligible"]
    target = sim.dataset.segments["LINE_058"]
    if change == "too_far":
        target["position"] = (target["position"][0] + .001, target["position"][1])
    elif change == "no_shared_endpoint":
        target["coordinates"] = [[lon + .000001, lat] for lon, lat in target["coordinates"]]
    else:
        drone.status = "flying"
    access = sim.stationary_inspection_access(drone, "LINE_058")
    assert not access["eligible"] and access["radius_m"] == NEARBY_IMAGERY_RADIUS_M
    if change == "too_far":
        assert access["shared_endpoint"] and access["distance_m"] > access["radius_m"]
    elif change == "no_shared_endpoint":
        assert not access["shared_endpoint"] and access["distance_m"] < access["radius_m"]


def test_nearby_imagery_does_not_bypass_recharge_for_telemetry_or_flight(nearby_sim):
    sim = nearby_sim
    sim._observe_window()
    assert sim.current("LINE_025")["status"] == "Normal"
    sim.receive_inspection_request("LINE_058", request_id="needs-contact", priority="high")
    sim._operations.tick()
    operation = sim.operations[0]
    candidate = next(r for r in operation["decision_explanation"]["candidates"] if r["sensor_id"] == "Drone 4")
    assert operation["requires_target_telemetry"]
    assert "telemetry" in operation["observation_need"]
    assert not candidate["eligible"] and candidate["flight_minutes"] > 0
    assert "180-minute recharge" in candidate["reason"]
    # Even a stale/provisional assignment cannot start the camera in place.
    operation.update(sensor_id="Drone 4", assignment_eligible=True)
    sim._operations._start_inspection(operation, sim._drone("Drone 4"))
    assert operation["status"] == "deferred" and operation["inspection_started_at"] is None
    assert "target-specific stationary telemetry" in operation["reason"]
    with pytest.raises(ValueError, match="180-minute recharge"):
        sim.relocate("Drone 4", "LINE_058")
    assert sim._drone("Drone 4").charge_ready_at == 186


def test_camera_remains_exclusive_while_nearby_inspection_runs(nearby_sim):
    sim = nearby_sim
    operation = request_imagery(sim)
    sim.step()
    assert operation["status"] == "inspecting"
    assert sim._drone("Drone 4").status == "charging"
    sim.receive_inspection_request("LINE_025", request_id="competing", priority="critical", observation_need="imagery")
    sim._operations.tick()
    competing = next(o for o in sim.operations if o.get("request_id") == "competing")
    candidate = next(r for r in competing["decision_explanation"]["candidates"] if r["sensor_id"] == "Drone 4")
    assert not candidate["eligible"] and "Committed to" in candidate["reason"]
    assert competing["status"] == "deferred"
    with pytest.raises(ValueError, match="four complete minutes"):
        sim._collect_autonomous_inspection(operation)
    sim.advance_to(65)
    assert operation["status"] == "completed"
    assert competing["status"] != "inspecting"
    sim.step()
    assert competing["status"] == "inspecting"
    assert sim._drone("Drone 4").charge_ready_at == 186


@pytest.mark.parametrize("change", ["move", "geometry", "busy"])
def test_stationary_qualification_is_rechecked_during_collection(nearby_sim, change):
    sim = nearby_sim
    operation = request_imagery(sim)
    sim.step()
    assert operation["status"] == "inspecting"
    if change == "move":
        sim._drone("Drone 4").asset_id = "LINE_064"
    elif change == "geometry":
        row = sim.dataset.segments["LINE_058"]
        row["coordinates"] = [[lon + .000001, lat] for lon, lat in row["coordinates"]]
    else:
        other = sim._operations._new_operation("report_check", "LINE_025", sim._drone("Drone 4"), "Concurrent camera use", "routine", 100)
        other.update(status="inspecting", inspection_started_at=sim.minute, inspection_due_at=100)
    sim._operations._progress_operations(False)
    assert operation["status"] == "deferred"
    assert operation["inspection_started_at"] is operation["inspection_due_at"] is None
    assert operation["inspection_attempts"][-1]["aborted_at"] == sim.minute
    assert "LINE_058" not in sim.visual_evidence
    assert operation["result"] is None


def test_collection_boundary_rejects_lost_qualification_at_completion(nearby_sim):
    sim = nearby_sim
    operation = request_imagery(sim)
    sim.step()
    sim.minute = operation["inspection_due_at"]
    sim._drone("Drone 4").status = "flying"
    with pytest.raises(ValueError, match="qualified stationary"):
        sim._collect_autonomous_inspection(operation)
    assert "LINE_058" not in sim.visual_evidence


def test_coverage_restoration_never_substitutes_camera_for_target_contact(nearby_sim):
    sim = nearby_sim
    # Explicit imagery can be fulfilled from nearby; the same geometry is not
    # enough for the distinct periodic telemetry-coverage objective.
    probe = {"asset_id": "LINE_058", "priority": "routine", "requires_target_telemetry": True}
    candidate = next(r for r in sim._operations._candidates(probe) if r["sensor_id"] == "Drone 4")
    assert not candidate["eligible"] and candidate["observation_mode"] == "flight"


def test_request_update_to_contact_telemetry_interrupts_nearby_camera(nearby_sim):
    sim = nearby_sim
    operation = request_imagery(sim)
    sim.step()
    assert operation["status"] == "inspecting" and not operation["requires_target_telemetry"]
    sim.receive_inspection_request("LINE_058", request_id="nearby", event_id="needs-contact-v2",
                                   msg_type="Update", priority="high", observation_need="imagery and target telemetry")
    sim._operations.tick()
    assert operation["requires_target_telemetry"]
    assert operation["status"] == "deferred"
    assert operation["inspection_started_at"] is None and operation["result"] is None
    assert "target-specific stationary telemetry" in operation["reason"]
    sim.step()
    assert not operation["assignment_eligible"]
    sim.advance_to(66)
    assert operation["status"] == "deferred" and "LINE_058" not in sim.visual_evidence


@pytest.mark.parametrize("existing_request", [False, True])
def test_new_imagery_request_never_downgrades_other_contact_requirement(nearby_sim, existing_request):
    sim = nearby_sim
    if existing_request:
        sim.receive_inspection_request("LINE_058", request_id="contact", observation_need="target telemetry")
        sim._operations.tick()
        contact = sim.operations[0]
    else:
        contact = sim._operations._new_operation("report_check", "LINE_058", None, "Restore target coverage", "routine", 100)
    imagery = request_imagery(sim)
    assert imagery is not contact and not imagery["requires_target_telemetry"]
    assert contact["requires_target_telemetry"]
    assert contact["request_id"] == ("contact" if existing_request else None)
    sim.advance_to(65)
    assert imagery["status"] == "completed"
    assert contact["status"] == "deferred" and contact["completed_at"] is None
    assert sim.current("LINE_058")["status"] == "Unknown"


@pytest.mark.parametrize("need", ["vibration", "temperature", "imagery and vibration", "", "unknown sensor need"])
def test_unspecified_or_contact_channel_needs_cannot_be_satisfied_by_camera(nearby_sim, need):
    sim = nearby_sim
    sim.receive_inspection_request("LINE_058", request_id="contact-scope", observation_need=need)
    sim._operations.tick()
    operation = sim.operations[0]
    assert operation["requires_target_telemetry"]
    candidate = next(r for r in operation["decision_explanation"]["candidates"] if r["sensor_id"] == "Drone 4")
    assert not candidate["eligible"] and candidate["observation_mode"] == "flight"
