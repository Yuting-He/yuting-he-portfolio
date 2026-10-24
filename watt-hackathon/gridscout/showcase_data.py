"""Build the public, immutable multi-asset showcase from received evidence.

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
from .twin_engine import NEARBY_IMAGERY_RADIUS_M, TwinSimulation

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = PROJECT_ROOT / "artifacts" / "showcase_data.json"
ASSET_ID = "LINE_058"
ASSET_IDS = (ASSET_ID, "LINE_015")
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
        ("context", "Conditions & coverage", "Conditions", "Limited coverage.\nA changing environment.", "coverage", "LINE_058", None, 44, 8, [44],
         "The gust warning has ended. Five drones cover only part of the mapped network.",
         "An unobserved line is Unknown, not healthy. Limited drones must choose where to collect evidence.",
         "Watch received reports and retain coverage at sites with unresolved anomalies."),
        ("report", "A new observer report", "Received report", "A report is a reason\nto investigate.", "report", "LINE_058", None, 46, 8, [46],
         "An observer reports recurring movement near LINE_058, where there is no live measurement.",
         "This is an unverified high-priority lead. It creates a need for evidence, not a confirmed fault.",
         "Check whether a nearby stationary drone can obtain the requested view."),
        ("selection", "Reuse nearby coverage", "Reuse a nearby drone", "A nearby view.\nNo extra flight.", "selection", "LINE_058", "Drone 4", 47, 10, [47],
         "Drone 4 starts a nearby RGB inspection from LINE_025, about 7.3 metres from LINE_058.",
         "The lines share a mapped endpoint and are within the assumed 25-metre viewing radius. Drone 4 can take images while charging; Drone 5 stays available.",
         "Collect the target's image without moving Drone 4 or transferring LINE_025 telemetry."),
        ("inspection", "Inspect without another flight", "Nearby inspection", "Collect the image.\nKeep charging.", "inspection", "LINE_058", "Drone 4", 47, 10, list(range(47, 51)),
         "Drone 4 takes a four-minute stationary RGB view of the adjacent line while its recharge continues.",
         "Nearby imagery is an explicit simulation capability. It provides no contact measurements of the target and assumes a usable view.",
         "Receive the image at T+51, then review what the evidence can establish."),
        ("nearby_result", "Separate imagery from telemetry", "Keep the gap visible", "An image arrives.\nThe coverage gap remains.", "result", "LINE_058", "Drone 4", 51, 12, [51],
         "The image result is recorded for LINE_058 with Drone 4's actual observation location.",
         "LINE_058 still has no asset-specific telemetry. The model keeps its assessment Unknown and does not calculate a sensor posterior from LINE_025's readings.",
         "Keep the coverage-review request open; release the separate LINE_015 lead after this image result."),
        ("dispatch", "Use the available drone for a distant lead", "Dispatch Drone 5", "Save the flight\nfor a distant lead.", "selection", "LINE_015", "Drone 5", 51, 10, [51, 52],
         "The LINE_058 image result releases the received LINE_015 follow-up. Drone 5 can serve this distant location.",
         "Drone 4 continues charging at LINE_025. LINE_015 lies beyond its nearby viewing radius, so this request needs a real simulated flight.",
         "Dispatch Drone 5 from LINE_009 at T+52, subject to weather, recharge and origin-coverage constraints."),
        ("flight", "Fly to the distant inspection", "Fly the route", "From an available drone\nto an on-site inspection.", "flight", "LINE_015", "Drone 5", 52, 18, list(range(52, 79)),
         "Drone 5 follows its recorded flight from LINE_009 to LINE_015; arrival is T+78.",
         "The 26-minute leg is time compressed here. In-flight motion supplies no usable target telemetry, and LINE_015 stays Unknown until arrival.",
         "Land, keep the mandatory recharge running and collect four minutes of stationary evidence."),
        ("telemetry", "Observe the target after arrival", "Read target sensors", "Now on site.\nNow target telemetry.", "telemetry", "LINE_015", "Drone 5", 78, 14, [78, 79, 80, 81],
         "At T+78 Drone 5 arrives at LINE_015. Its stationary telemetry can now be compared with the current weather-conditioned healthy baseline.",
         "The Bayesian model combines the current mechanical, thermal and sensor explanations. It recomputes each window and excludes transit readings.",
         "Finish the RGB inspection at T+82 and compare the same telemetry window with and without the received image."),
        ("bn_update", "Update the same-window decision", "Update the BN", "One telemetry window.\nOne received image.", "followup", "LINE_015", "Drone 5", 82, 15, [82],
         "At T+82 the clear RGB view updates LINE_015's current telemetry window. The recommendation remains Continue monitoring.",
         "The synthetic anomaly estimate changes from a 4.94% window prior to 0.100% after sensors and 0.058% after the image. A clear RGB view remains imperfect evidence.",
         "Continue monitoring LINE_015 while the separate LINE_058 telemetry gap and its human coverage-review request remain unresolved."),
    ]
    return [{"id": key, "title": title, "short_title": short_title,
             "headline": headline, "kind": kind, "asset_id": asset_id,
             "focus_sensor_id": focus_sensor_id, "minute": minute,
             "snapshot_minute": minute, "start_minute": minutes[0],
             "end_minute": minutes[-1], "duration_seconds": duration,
             "frame_minutes": minutes, "what": what, "summary": what,
             "why": why, "next": next_step}
            for key, title, short_title, headline, kind, asset_id, focus_sensor_id,
            minute, duration, minutes, what, why, next_step in rows]


def frame_schedule() -> list[tuple[int, str]]:
    """Unique, chronological capture requests; same-minute targets stay distinct."""
    wanted = {(minute, chapter["asset_id"]) for chapter in chapters()
              for minute in chapter["frame_minutes"]}
    # Preserve a later evidence record for the unresolved first target without
    # rewinding the public story after it switches to the distant lead.
    wanted.update({(60, ASSET_ID), (83, "LINE_015"), (84, "LINE_015")})
    return sorted(wanted, key=lambda item: (item[0], ASSET_IDS.index(item[1])))


FRAME_MINUTES = tuple(sorted({minute for minute, _ in frame_schedule()}))


def _public_operation(operation: dict | None) -> dict | None:
    if operation is None:
        return None
    return {key: deepcopy(value) for key, value in operation.items()
            if not key.startswith("_")}


def _capture_frame(simulation: TwinSimulation, asset_id: str = ASSET_ID) -> dict:
    """Copy only public state available at this exact decision time."""
    sim = simulation
    operation = next((row for row in reversed(sim.operations)
                      if row["asset_id"] == asset_id), None)
    operation = _public_operation(operation)
    route_event = next((row for row in reversed(sim.audit)
                        if row["type"] == "relocation"
                        and row.get("target_asset") == asset_id), None)
    route = None
    if route_event is not None:
        route = deepcopy(route_event)
        route["coordinates"] = [
            list(sim.dataset.segments[route["origin_asset"]]["position"]),
            list(sim.dataset.segments[route["target_asset"]]["position"]),
        ]
        route["label"] = "Simulated flight leg; no obstacle or airspace planning"
    explanation = sim.explain_asset(asset_id)
    # All these records have already been received. No pending packet queue,
    # injected fault labels or future operation states are exported.
    return deepcopy({
        "snapshot_id": f"dynamic-42:{asset_id}:{sim.minute}",
        "minute": sim.minute, "simulation_time": sim.minute,
        "asset_id": asset_id,
        "operation_id": operation["id"] if operation else None,
        "fleet": [{**asdict(drone), "position": list(sim.position(drone))}
                  for drone in sim.drones],
        "map_states": {asset: {"status": sim.current(asset)["status"],
                                "anomaly": sim.current(asset).get("anomaly")}
                       for asset in sim.dataset.segments},
        "operation": operation,
        "candidates": (operation or {}).get("decision_explanation", {}).get("candidates", []),
        "explanation": explanation,
        "recommendations": sim.recommendations[asset_id],
        "human_alerts": [row for row in sim.human_alerts if row["asset_id"] == asset_id],
        "weather": sim.weather,
        "weather_decision": sim.weather_decision,
        "audit": [row for row in sim.audit
                  if (row.get("asset_id") == asset_id
                      or row.get("target_asset") == asset_id)
                  and row["type"] != "telemetry_received"],
        "replans": [{**row, "decisions": [decision for decision in row["decisions"]
                                          if decision.get("asset_id") == asset_id]}
                    for row in sim.replans
                    if any(decision.get("asset_id") == asset_id
                           for decision in row["decisions"])],
        "inspection_requests": [row for row in sim.inspection_requests
                                if row["asset_id"] == asset_id],
        "route": route,
        "narrative": _frame_narrative(sim, operation, asset_id),
    })


def _frame_narrative(sim: TwinSimulation, operation: dict | None, asset_id: str = ASSET_ID) -> dict:
    """State-aware text never announces an inspection before it is received."""
    minute = sim.minute
    if asset_id == "LINE_015":
        if operation is None or operation["status"] in {"queued", "deferred"}:
            return {"status": "Distant lead · awaiting dispatch", "what": "The received LINE_015 lead is a separate geographic follow-up. Its dependency can be released after the LINE_058 image result.",
                    "next": "Use a feasible available drone for this location; nearby LINE_025 imagery cannot cover it."}
        if operation["status"] == "flying":
            return {"status": "Flying · target remains Unknown", "what": f"Drone 5 is flying from {operation['origin_asset']} to LINE_015. Transit readings do not diagnose the target.",
                    "next": f"Arrive at T+{operation['arrival_at']}, then collect stationary target telemetry and RGB imagery."}
        if operation["status"] == "inspecting":
            return {"status": "On site · target telemetry available", "what": "Drone 5 now supplies stationary LINE_015 telemetry. Current weather conditions define the healthy reference; the RGB view is still being collected.",
                    "next": f"At T+{operation['inspection_due_at']}, compare the same telemetry window before and after the received inspection."}
        if operation["status"] == "completed":
            return {"status": "BN updated · continue monitoring", "what": f"The {operation['result']} RGB view was received at T+{operation['completed_at']} and combined with that window's LINE_015 telemetry. The current recommendation is Continue monitoring.",
                    "next": "Keep collecting fresh target windows. LINE_058's separate missing-telemetry gap remains unresolved."}
        return {"status": "Follow-up pending", "what": "The distant lead still requires an accountable inspection.",
                "next": "Review the current operation and its received evidence."}
    if minute < 46:
        return {"status": "Unknown · not observed", "what": "The wind warning has ended; LINE_058 has no stationary measurements.",
                "next": "Wait for received evidence before selecting the next inspection."}
    if minute < 47:
        return {"status": "Unverified lead received", "what": "A high-priority observer report requests a stationary view at LINE_058.",
                "next": "Compare nearby stationary inspection access before assigning another flight."}
    if operation and operation["status"] == "inspecting":
        return {"status": "Nearby RGB inspection", "what": "Drone 4 inspects LINE_058 from LINE_025 without taking off. Charging and LINE_025 monitoring continue.",
                "next": f"Image collection finishes at T+{operation['inspection_due_at']}; LINE_058 telemetry remains unavailable."}
    if operation and operation["status"] == "completed":
        result = operation["result"]
        return {"status": "Image received · telemetry missing", "what": f"The nearby RGB result is {result}. No target telemetry was collected, so LINE_058 stays Unknown.",
                "next": "Keep the coverage-review request open; arrange asset-specific measurements without duplicating the nearby image check."}
    return {"status": "Awaiting nearby inspection", "what": "The received lead is awaiting a feasible stationary view; the target remains Unknown.",
            "next": "Retain the missing-telemetry distinction while reviewing inspection access."}


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
    for minute, asset_id in frame_schedule():
        sim.advance_to(minute)
        frames.append(_capture_frame(sim, asset_id))
    story = chapters()
    metadata = {
        "schema_version": 2, "case_id": "dynamic-42-nearby-and-remote",
        "title": "GridScout · Reuse a nearby view, fly for target evidence",
        "scenario": "dynamic", "seed": 42, "synthetic": True,
        "asset_id": ASSET_ID, "asset_ids": list(ASSET_IDS),
        "duration_seconds": sum(chapter["duration_seconds"] for chapter in story),
        "chapter_count": len(story),
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
            "dispatch": "Nearby stationary imagery reuse, then greedy priority with travel, recharge and origin-coverage constraints",
            "route": "Point-to-point simulated leg; no obstacle, terrain or airspace validation",
            "nearby_imagery": "Assumed RGB access within 25 metres and a shared mapped endpoint; no line-of-sight validation, shared telemetry or inferred electrical connection",
        },
        "assumptions": {"costs": dict(DEFAULT_COSTS), "charge_minutes": 180,
                        "stationary_inspection_minutes": 4, "max_flight_minutes": 30,
                        "flight_gust_limit_mps_exclusive": 18.0,
                        "nearby_imagery_radius_m": NEARBY_IMAGERY_RADIUS_M,
                        "inference_mode": "current_window; no recursive multiplication of adjacent windows"},
    }
    if validation is not None and (validation["metadata"]["model_version"] != MODEL_VERSION
                                   or validation["metadata"]["code_hash"] != metadata["code_hash"]):
        raise ValueError("Validation does not match the current model and source fingerprint")
    data = {
        "metadata": metadata, "chapters": story,
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
                      "bytes": len(encoded.encode("utf-8")), "duration_seconds": data["metadata"]["duration_seconds"],
                      "model_version": MODEL_VERSION, "code_hash": data["metadata"]["code_hash"]}))
    return data


if __name__ == "__main__":
    main()
