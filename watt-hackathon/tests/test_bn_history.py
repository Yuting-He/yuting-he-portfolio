"""Evidence history must explain the model without silently accumulating it."""
from copy import deepcopy
import json

import pytest

from gridscout import twin_engine
from gridscout.asset_inference import infer_asset
from gridscout.twin_engine import TwinSimulation


def test_only_observed_assets_record_and_rerenders_never_accumulate_probability():
    sim = TwinSimulation("normal", 42)
    asset = sim.drones[0].asset_id
    assert len(sim.assessment_history) == 5
    unknown = next(key for key in sim.dataset.segments if key not in sim.latest)
    assert sim.temporal_history(unknown) == []
    before = deepcopy(sim.current(asset))
    for _ in range(3):
        sim._refresh_assessments()
        sim.explain_asset(asset)
    assert len(sim.assessment_history) == 5
    assert sim.current(asset) == before
    sim.step()
    assert len(sim.temporal_history(asset)) == 2
    assert len(sim.assessment_history) == 10


def test_inspection_adds_same_window_comparison_and_duplicate_is_idempotent():
    sim = TwinSimulation("mechanical", 42).advance_to(45)
    asset = sim.drones[0].asset_id
    before = sim.current(asset)["anomaly"]
    previous_rows = len(sim.temporal_history(asset))
    sim.verify(asset, "clear")
    history = sim.temporal_history(asset)
    assert len(history) == previous_rows + 1
    assert history[-1]["observation_id"] == history[-2]["observation_id"]
    assert history[-1]["minute"] == history[-2]["minute"]
    assert history[-1]["telemetry_only_anomaly"] == pytest.approx(before)
    assert history[-1]["with_visual_anomaly"] < before
    assert history[-1]["visual_used"] is True
    frozen = deepcopy(sim.inspection_history[0])
    assert frozen["before_anomaly"] == pytest.approx(before)
    assert frozen["after_anomaly"] == pytest.approx(sim.current(asset)["anomaly"])
    assert frozen["delta_pp"] < 0
    assert frozen["telemetry_observation_id"] == sim.latest[asset]["observation_id"]
    sim.verify(asset, "clear")
    assert len(sim.temporal_history(asset)) == len(history)
    assert len(sim.inspection_history) == 1
    assert sim.inspection_history[0] == frozen
    sim.advance_to(62)
    assert sim.inspection_history[0] == frozen


def test_expired_review_has_current_counterfactual_and_frozen_historical_comparison():
    sim = TwinSimulation("mechanical", 42).advance_to(45)
    asset = sim.drones[0].asset_id
    sim.verify(asset, "clear")
    historical = deepcopy(sim.inspection_history[0])
    sim.advance_to(61)
    explanation = sim.explain_asset(asset)
    assert explanation["visual"]["status"] == "stale"
    assert explanation["visual"]["used"] is False
    calculation = explanation["calculation"]
    assert calculation["summaries"]["telemetry_only"]["anomaly"] == pytest.approx(sim.current(asset)["anomaly"])
    assert sim.temporal_history(asset)[-1]["with_visual_anomaly"] is None
    assert explanation["inspection_history"][0] == historical
    assert explanation["reading"]["observed_at"] > historical["reading"]["observed_at"]
    assert "Historical same-window" in historical["comparison_scope"]


def test_inspection_comparison_is_recomputable_from_its_recorded_inputs():
    sim = TwinSimulation("mechanical", 42).advance_to(45)
    asset = sim.drones[0].asset_id
    sim.verify(asset, "supports")
    record = sim.inspection_history[0]
    before = infer_asset(record["reading"], record["baseline"], record["context"])
    after = infer_asset(record["reading"], record["baseline"], record["context"], record["visual"])
    assert record["before_anomaly"] == pytest.approx(before["anomaly"])
    assert record["after_anomaly"] == pytest.approx(after["anomaly"])
    assert record["calculation"]["states"] == after["calculation"]["states"]


def test_departed_asset_is_unknown_with_probability_gap_and_no_current_inputs():
    sim = TwinSimulation("normal", 42)
    asset = sim.drones[0].asset_id
    target = sim.available_targets("Drone 1")[0]
    sim.relocate("Drone 1", target)
    explanation = sim.explain_asset(asset)
    assert explanation["reading"] is None
    assert explanation["baseline"] is None
    assert explanation["context"] is None
    assert explanation["last_reading"] is not None
    assert explanation["freshness"]["fresh"] is False
    assert explanation["calculation"]["available"] is False
    row = sim.temporal_history(asset)[-1]
    assert row["status"] == "Unknown"
    assert all(row[key] is None for key in ("anomaly", "mechanical", "thermal", "sensor_fault", "prior_anomaly"))
    count = len(sim.temporal_history(asset))
    sim.step(4)
    # A stale/absent stream remains one explicit gap, not fake repeated lows.
    assert len(sim.temporal_history(asset)) == count


def test_missing_sensor_snapshot_is_unknown_instead_of_prior_or_zero():
    sim = TwinSimulation("dropout", 42).advance_to(30)
    asset = sim.drones[4].asset_id
    row = sim.temporal_history(asset)[-1]
    assert row["quality"] == "missing"
    assert row["status"] == "Unknown"
    assert row["anomaly"] is None
    assert row["telemetry_only_anomaly"] is None
    assert row["evidence_count"] == 0
    assert sim.explain_asset(asset)["calculation"]["available"] is False


def test_future_packets_and_future_visual_never_enter_explanation(monkeypatch):
    generator = twin_engine.generate_reading

    def delayed(*args, **kwargs):
        reading = generator(*args, **kwargs)
        if args[0] == "Drone 1":
            reading["received_at"] += 3
        return reading

    monkeypatch.setattr(twin_engine, "generate_reading", delayed)
    sim = TwinSimulation("normal", 42)
    asset = sim.drones[0].asset_id
    assert sim.temporal_history(asset) == []
    assert sim.explain_asset(asset)["last_reading"] is None
    sim.visual_evidence[asset] = {"observation_id": "future-view", "observed_at": 0,
                                  "received_at": 5, "result": "supports", "quality": "valid"}
    sim._refresh_assessments()
    explanation = sim.explain_asset(asset)
    assert explanation["visual"]["status"] == "not_received"
    assert explanation["visual"]["used"] is False
    assert explanation["visual"]["evidence"] is None
    assert explanation["visual"]["observation_id"] is None
    sim.advance_to(3)
    assert sim.temporal_history(asset)[-1]["anomaly"] is None
    assert all(row["received_at"] <= sim.minute for row in sim.assessment_history)
    assert all(row["visual_result"] is None for row in sim.temporal_history(asset))


def test_asset_isolation_and_deep_copies_prevent_ui_mutating_model_or_history():
    sim = TwinSimulation("mechanical", 42).advance_to(45)
    asset, other = sim.drones[0].asset_id, sim.drones[1].asset_id
    other_before = deepcopy(sim.current(other))
    sim.verify(asset, "clear")
    assert sim.current(other) == other_before
    assert sim.explain_asset(other)["inspection_history"] == []
    explanation = sim.explain_asset(asset)
    explanation["history"][-1]["anomaly"] = -100
    explanation["assessment"]["anomaly"] = -100
    explanation["inspection_history"][0]["after_anomaly"] = -100
    assert sim.current(asset)["anomaly"] >= 0
    assert sim.temporal_history(asset)[-1]["anomaly"] >= 0
    assert sim.inspection_history[0]["after_anomaly"] >= 0


def test_autonomous_camera_collection_preserves_comparison_and_export_is_json():
    sim = TwinSimulation("mechanical", 42).advance_to(45)
    asset = sim.drones[0].asset_id
    sim._collect_autonomous_inspection({"id": "history-test", "sensor_id": "Drone 1", "asset_id": asset})
    assert sim.inspection_history[0]["operation_id"] == "history-test"
    exported = sim.export()
    assert exported["inference_mode"]["temporal_recursion"] is False
    assert exported["assessment_history"]
    assert exported["inspection_history"]
    serialized = json.dumps(exported, allow_nan=False)
    assert "asset_fault_target" not in serialized
    assert "hidden_scenario_state" not in serialized
    assert "current_window" in serialized
