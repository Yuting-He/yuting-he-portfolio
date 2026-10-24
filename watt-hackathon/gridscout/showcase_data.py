"""Build the public, immutable 75-second showcase from received evidence.

Run from the project root: ``python -m gridscout.showcase_data``.  The replay
advances a fresh autonomous simulation from T+0; it never reconstructs an early
frame from a completed operation. Hidden injected state is not published.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
from dataclasses import asdict
import hashlib
import json
from pathlib import Path

from .action_policy import DEFAULT_COSTS
from .asset_inference import MODEL_VERSION
from .bn_structure import model_structure
from .inspection_model import MODEL_ID
from .twin_engine import TwinSimulation

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = PROJECT_ROOT / "artifacts" / "showcase_data.json"
ASSET_ID = "LINE_058"
FRAME_MINUTES = (44, 46, *range(47, 57), 58, 60)
# Presentation modules are deliberately excluded: editing a title must not
# invalidate algorithm evidence or create a generated-data hash cycle.
ALGORITHM_SOURCES = (
    "action_policy.py", "asset_inference.py", "autonomous_ops.py",
    "bn_structure.py", "conditional_baseline.py", "dynamic_scenario.py",
    "inspection_model.py", "official_data.py", "operating_state.py",
    "synthetic_inspection.py", "synthetic_telemetry.py", "twin_engine.py",
    "weather_context.py", "twin_evaluation.py",
)


def source_fingerprint() -> str:
    """Fingerprint the frozen model, scenario, policy and evaluation code."""
    digest = hashlib.sha256()
    for filename in ALGORITHM_SOURCES:
        digest.update(filename.encode("utf-8"))
        digest.update((PROJECT_ROOT / "gridscout" / filename).read_bytes().replace(b"\r\n", b"\n"))
    digest.update((PROJECT_ROOT / "data" / "official" / "manifest.json").read_bytes().replace(b"\r\n", b"\n"))
    return digest.hexdigest()


def chapters() -> list[dict]:
    """English judge-facing story; each chapter is anchored to a real frame."""
    rows = [
        ("context", "Conditions & coverage", 44, 8, [44],
         "The gust warning has ended. Five drones cover only part of the mapped network.",
         "An unobserved line is Unknown, not healthy. Limited drones must choose where to collect evidence.",
         "Watch received reports and retain coverage at sites with unresolved anomalies."),
        ("report", "A new observer report", 46, 10, [46],
         "An observer reports recurring movement near LINE_058, where there is no live measurement.",
         "This is an unverified high-priority lead. It creates a need for evidence, not a confirmed fault.",
         "Compare feasible drones for a stationary inspection at LINE_058."),
        ("selection", "Choose a feasible drone", 47, 12, [47],
         "Drone 5 is dispatched from LINE_009 to inspect LINE_058.",
         "Drone 1 is closer, but its origin remains anomalous. Drone 5 can leave while retaining the higher-priority coverage.",
         "Fly the simulated point-to-point leg, then measure only after arrival."),
        ("flight", "Follow the inspection route", 47, 15, list(range(47, 57)),
         "Drone 5 travels from LINE_009 toward LINE_058; the map follows the recorded simulated positions.",
         "Travel time, weather, recharge status and origin coverage constrain dispatch. In-flight motion is excluded from asset diagnosis.",
         "Arrive at T+56 and collect four minutes of stationary telemetry and RGB imagery."),
        ("inspection", "Collect & challenge evidence", 56, 18, [56, 58, 60],
         "Stationary telemetry is compared with the healthy baseline for the current weather while the RGB inspection runs.",
         "The model compares mechanical, thermal and sensor explanations. Persistent residuals can trigger human review before imagery returns.",
         "When a usable inspection arrives, update the same telemetry window and compare the change."),
        ("followup", "Update the decision", 60, 12, [60],
         "The RGB view is clear. The model lowers its asset-anomaly estimate, and recommends checking the sensor or installation.",
         "A clear RGB view is imperfect evidence and cannot rule out a thermal-only defect. Asset uncertainty remains.",
         "Keep the T+58 human field-review request open; continue monitoring and bounded follow-up."),
    ]
    return [{"id": key, "title": title, "minute": minute,
             "snapshot_minute": minute, "start_minute": minutes[0],
             "end_minute": minutes[-1], "duration_seconds": duration,
             "frame_minutes": minutes, "what": what, "summary": what,
             "why": why, "next": next_step}
            for key, title, minute, duration, minutes, what, why, next_step in rows]


def _public_operation(operation: dict | None) -> dict | None:
    if operation is None:
        return None
    return {key: deepcopy(value) for key, value in operation.items()
            if not key.startswith("_")}


def _capture_frame(simulation: TwinSimulation) -> dict:
    """Copy only public state available at this exact decision time."""
    sim = simulation
    operation = next((row for row in reversed(sim.operations)
                      if row["asset_id"] == ASSET_ID), None)
    operation = _public_operation(operation)
    route_event = next((row for row in reversed(sim.audit)
                        if row["type"] == "relocation"
                        and row.get("target_asset") == ASSET_ID), None)
    route = None
    if route_event is not None:
        route = deepcopy(route_event)
        route["coordinates"] = [
            list(sim.dataset.segments[route["origin_asset"]]["position"]),
            list(sim.dataset.segments[route["target_asset"]]["position"]),
        ]
        route["label"] = "Simulated flight leg; no obstacle or airspace planning"
    explanation = sim.explain_asset(ASSET_ID)
    # All these records have already been received. No pending packet queue,
    # injected fault labels or future operation states are exported.
    return deepcopy({
        "snapshot_id": f"dynamic-42:{ASSET_ID}:{sim.minute}",
        "minute": sim.minute, "simulation_time": sim.minute,
        "asset_id": ASSET_ID,
        "operation_id": operation["id"] if operation else None,
        "fleet": [{**asdict(drone), "position": list(sim.position(drone))}
                  for drone in sim.drones],
        "map_states": {asset: {"status": sim.current(asset)["status"],
                                "anomaly": sim.current(asset).get("anomaly")}
                       for asset in sim.dataset.segments},
        "operation": operation,
        "candidates": (operation or {}).get("decision_explanation", {}).get("candidates", []),
        "explanation": explanation,
        "recommendations": sim.recommendations[ASSET_ID],
        "human_alerts": [row for row in sim.human_alerts if row["asset_id"] == ASSET_ID],
        "weather": sim.weather,
        "weather_decision": sim.weather_decision,
        "audit": [row for row in sim.audit
                  if (row.get("asset_id") == ASSET_ID
                      or row.get("target_asset") == ASSET_ID)
                  and row["type"] != "telemetry_received"],
        "replans": [{**row, "decisions": [decision for decision in row["decisions"]
                                          if decision.get("asset_id") == ASSET_ID]}
                    for row in sim.replans
                    if any(decision.get("asset_id") == ASSET_ID
                           for decision in row["decisions"])],
        "inspection_requests": [row for row in sim.inspection_requests
                                if row["asset_id"] == ASSET_ID],
        "route": route,
        "narrative": _frame_narrative(sim, operation),
    })


def _frame_narrative(sim: TwinSimulation, operation: dict | None) -> dict:
    """State-aware text never announces an inspection before it is received."""
    minute = sim.minute
    if minute < 46:
        return {"status": "Unknown · not observed", "what": "The wind warning has ended; LINE_058 has no stationary measurements.",
                "next": "Wait for received evidence before selecting the next inspection."}
    if minute < 47:
        return {"status": "Unverified lead received", "what": "A high-priority observer report requests a stationary view at LINE_058.",
                "next": "Compare travel, origin coverage, weather and recharge constraints."}
    if minute < 56:
        return {"status": "Flying · target remains Unknown", "what": "Drone 5 is en route. No target telemetry is available yet.",
                "next": f"Planned arrival T+{operation['arrival_at']}; then four minutes of stationary inspection."}
    if minute < 58:
        return {"status": "Stationary inspection in progress", "what": "On-site telemetry deviates from the weather-conditioned healthy reference.",
                "next": "Collect the RGB view and check whether the residuals persist."}
    if minute < 60:
        return {"status": "Human field review requested", "what": "Persistent residuals make a field check the current lowest expected-loss action; alert-002 is open.",
                "next": "Continue the automatic inspection while an operator arranges field review."}
    return {"status": "Inspection received · uncertainty remains", "what": "The clear RGB view changes the same-window judgment; the current recommendation is to check the sensor or installation.",
            "next": "Keep alert-002 open for human field review and continue monitoring."}


def build_validation_summary() -> dict:
    """Recompute the current protocol and publish aggregate data only."""
    from .twin_evaluation import run_twin_evaluation

    report = run_twin_evaluation(seeds=6, minute=55, start_seed=42)
    report["metadata"].update({
        "code_hash": source_fingerprint(),
        "baseline_versions": sorted({case["baseline_version"] for case in report["cases"]}),
        "scope": "Six synthetic scenarios, matched seeds 42–47, five stationed slots per run at T+55. No dynamic mission or field-performance claim.",
        "calibration_status": "Not calibrated against field observations",
        "generated_by": "python -m gridscout.showcase_data",
    })
    return {key: deepcopy(report[key]) for key in ("metadata", "overall", "scenarios")}


def build_showcase_data(validation: dict | None = None) -> dict:
    """Build deterministic early-to-late frames from a single T+0 run."""
    sim = TwinSimulation("dynamic", seed=42, autonomous=True)
    frames = []
    for minute in FRAME_MINUTES:
        sim.advance_to(minute)
        frames.append(_capture_frame(sim))
    metadata = {
        "schema_version": 1, "case_id": "dynamic-42-line058",
        "title": "GridScout · From observer report to accountable inspection",
        "scenario": "dynamic", "seed": 42, "synthetic": True,
        "asset_id": ASSET_ID, "duration_seconds": 75,
        "model_version": MODEL_VERSION, "baseline_version": sim.baseline.version,
        "inspection_model": MODEL_ID, "code_hash": source_fingerprint(),
        "generated_by": "python -m gridscout.showcase_data",
        "model_structure": model_structure(),
        "calibration_status": "Synthetic demonstration assumptions; not field calibrated",
        "baseline_training_count": sim.baseline.training_count,
        "provenance": {
            "geometry": "Organizer-provided challenge geometry; mapped adjacency is not electrical topology",
            "baseline": "Frozen fit to 3,600 independent healthy synthetic records per seed",
            "inference": "Hand-specified current-window Bayesian network; exact enumeration",
            "inspection": MODEL_ID,
            "dispatch": "Greedy received-report/evidence priority with travel, recharge and origin-coverage constraints",
            "route": "Point-to-point simulated leg; no obstacle, terrain or airspace validation",
        },
        "assumptions": {"costs": dict(DEFAULT_COSTS), "charge_minutes": 180,
                        "stationary_inspection_minutes": 4, "max_flight_minutes": 30,
                        "flight_gust_limit_mps_exclusive": 18.0,
                        "inference_mode": "current_window; no recursive multiplication of adjacent windows"},
    }
    if validation is not None and (validation["metadata"]["model_version"] != MODEL_VERSION
                                   or validation["metadata"]["code_hash"] != metadata["code_hash"]):
        raise ValueError("Validation does not match the current model and source fingerprint")
    data = {
        "metadata": metadata, "chapters": chapters(),
        "geometry": [{"asset_id": asset, "coordinates": row["coordinates"],
                      "position": list(row["position"]),
                      "charging_site": asset in sim.charging_sites}
                     for asset, row in sim.dataset.segments.items()],
        "frames": frames, "validation": deepcopy(validation),
    }
    json.dumps(data, allow_nan=False)
    return data


def load_showcase_data(path: Path = DEFAULT_OUTPUT, *, require_current=True) -> dict:
    """Load bundled data, refusing stale model evidence by default."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if require_current and (data["metadata"]["model_version"] != MODEL_VERSION
                            or data["metadata"]["code_hash"] != source_fingerprint()):
        raise ValueError("This showcase belongs to a different model/source version. Rebuild the replay.")
    validation = data.get("validation")
    if require_current and (not validation
                            or validation["metadata"]["model_version"] != data["metadata"]["model_version"]
                            or validation["metadata"]["code_hash"] != data["metadata"]["code_hash"]):
        raise ValueError("Validation is missing or belongs to a different model/source version. Rebuild the replay.")
    return data


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--validation-output", type=Path, default=PROJECT_ROOT / "artifacts" / "validation_summary.json")
    parser.add_argument("--skip-validation", action="store_true", help="Development-only replay without an evaluation summary")
    args = parser.parse_args(argv)
    validation = None if args.skip_validation else build_validation_summary()
    data = build_showcase_data(validation)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    args.output.write_text(encoded, encoding="utf-8")
    if validation is not None:
        args.validation_output.parent.mkdir(parents=True, exist_ok=True)
        args.validation_output.write_text(json.dumps(validation, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    print(json.dumps({"output": str(args.output), "frames": len(data["frames"]),
                      "bytes": len(encoded.encode("utf-8")), "duration_seconds": 75,
                      "model_version": MODEL_VERSION, "code_hash": data["metadata"]["code_hash"]}))
    return data


if __name__ == "__main__":
    main()
