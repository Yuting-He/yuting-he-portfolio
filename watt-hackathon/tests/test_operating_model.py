"""State ambiguity, record provenance and charging are different model inputs."""
from copy import deepcopy
import json

import pytest

from gridscout.asset_inference import infer_asset
from gridscout.conditional_baseline import fit_normal_baseline
from gridscout.twin_engine import TwinSimulation


def test_unknown_baseline_retains_both_physical_branches_and_normalizes():
    baseline = fit_normal_baseline()
    context = dict(ambient_c=20, wind_mps=3, gust_mps=5, solar_wm2=400,
                   energized=None, energized_prior=.7, load_pu=None)
    reference = baseline.predict(context)
    on, off = reference["operating_components"].values()
    assert off["temperature_c"]["sd"] < on["temperature_c"]["sd"]
    reading = {k: off[k]["mean"] for k in ("temperature_c", "vibration_rms", "tilt_deg", "voltage_pu")}
    unknown = infer_asset(reading, reference, context)
    assert len(unknown["joint_states"]) == 16
    assert sum(row["probability"] for row in unknown["joint_states"]) == pytest.approx(1)
    assert unknown["energized"] < .01
    assert unknown["sensor_fault"] < .1
    known_on = infer_asset(reading, on, {**context, "energized": True})
    assert known_on["sensor_fault"] > unknown["sensor_fault"]
    assert unknown["operation"]["prior_energized"] == .7
    assert unknown["anomaly"] < .1
    json.dumps(unknown, allow_nan=False)


def test_missing_operating_record_uses_ambiguity_and_requires_branch_baselines():
    result = infer_asset({"voltage_pu": 0.}, {"voltage_pu": {"mean": 1., "sd": .02}}, {})
    assert result["operation"]["status"] == "unknown"
    assert result["energized"] == pytest.approx(.9)
    assert result["status"] == "Unknown"
    assert "conditional baseline" in result["calculation"]["evidence_state"]["excluded"]["voltage_pu"]


def test_operating_update_preserves_telemetry_and_inspection_history():
    sim = TwinSimulation("normal", 42)
    asset = sim.drones[0].asset_id
    sim.verify(asset, "clear", modality="thermal", visibility="poor")
    old_reading = deepcopy(sim.latest[asset])
    old_history = deepcopy(sim.inspection_history)
    sites = set(sim.charging_sites)
    sim.set_operating_state(asset, None, prior_energized=.6)
    result = sim.current(asset)
    assert result["operation"]["status"] == "unknown"
    assert len(result["joint_states"]) == 16
    assert sim.latest[asset] == old_reading
    assert sim.inspection_history == old_history
    assert sim.charging_sites == sites
    assert sim.explain_asset(asset)["context"]["energized"] is None
    assert sim.assessment_history[-1]["asset_id"] == asset
    assert any(row["type"] == "operating_record_update" for row in sim.export()["audit"])
    before = deepcopy(sim.current(asset))
    sim._refresh_assessments()
    assert sim.current(asset) == before
    sim.verify(asset, "supports", modality="combined")
    record = sim.inspection_history[-1]
    replay = infer_asset(record["reading"], record["baseline"], record["context"], record["visual"])
    assert replay["anomaly"] == record["after_anomaly"]
    assert record["context"]["energized"] is None
    assert record["reading"] == old_reading


def test_voltage_posterior_never_grants_charging_and_interrupted_charge_restarts():
    sim = TwinSimulation("normal", 42)
    drone = sim.drones[0]
    target = sim.available_targets(drone.sensor_id)[0]
    sim.set_operating_state(target, None)
    with pytest.raises(ValueError, match="explicit energized"):
        sim.relocate(drone.sensor_id, target)
    sim.set_operating_state(target, True)
    plan = sim.relocate(drone.sensor_id, target)
    sim.advance_to(plan["arrival_at"]+2)
    sim.set_operating_state(target, None)
    assert drone.charge_ready_at is None and drone.needs_charge
    sim.step(2)
    assert sim.current(target)["energized"] > .9
    assert drone.charge_ready_at is None
    sim.set_operating_state(target, True)
    ready = sim.minute+180
    assert drone.charge_ready_at == ready
    sim.set_operating_state(target, True)
    assert drone.charge_ready_at == ready
    with pytest.raises(ValueError, match="officially"):
        sim.set_operating_state("LINE_024", None)


def test_zero_inspection_likelihood_is_supported_and_json_safe():
    context = {"energized": True}
    baseline = fit_normal_baseline().predict(context)
    reading = {k: baseline[k]["mean"] for k in ("temperature_c", "vibration_rms", "tilt_deg", "voltage_pu")}
    result = infer_asset(reading, baseline, context,
                         {"result": "clear", "mechanical_sensitivity": 1., "false_positive_probability": 0.})
    assert result["mechanical"] == 0
    assert sum(row["probability"] for row in result["joint_states"]) == pytest.approx(1)
    json.dumps(result, allow_nan=False)
    impossible = infer_asset(reading, baseline, context,
                             {"result": "clear", "mechanical_sensitivity": 1., "false_positive_probability": 1.})
    original = infer_asset(reading, baseline, context)
    assert impossible["anomaly"] == original["anomaly"]
    assert not impossible["calculation"]["visual"]["used"]
    json.dumps(impossible, allow_nan=False)
