"""Reproducible stationary snapshot validation of synthetic twin scenarios.

Hidden scenario labels are imported HERE, never by inference or action policy.
The report scores recommendations at one timestamp, not executed dispatches,
real costs, field accuracy, future-event prediction, or probability calibration.
Run: python -m gridscout.twin_evaluation --seeds 6 --minute 55 \
         --output artifacts/twin_validation.json
"""
from __future__ import annotations

import argparse
from collections.abc import Iterable
from copy import deepcopy
import json
import math
from pathlib import Path

from .action_policy import DEFAULT_COSTS
from .asset_inference import MODEL_VERSION
from .synthetic_telemetry import CHANNELS, SCENARIOS, hidden_scenario_state
from .twin_engine import MISSION_MINUTES, TwinSimulation

HIGH_COST_ACTIONS = {"field_check", "urgent_review"}
EVALUATION_SCENARIOS = {key: SCENARIOS[key] for key in ("normal", "gusts", "mechanical", "thermal", "dropout", "drift")}


def _matrix(rows, truth_key, prediction_key):
    """Confusion matrix on explicitly observed rows; missing is never a TN."""
    matrix = {"true_positive": 0, "false_positive": 0,
              "true_negative": 0, "false_negative": 0}
    for row in rows:
        if not row["observed"]:
            continue
        truth, predicted = row[truth_key], row[prediction_key]
        key = ("true_positive" if predicted else "false_negative") if truth else (
            "false_positive" if predicted else "true_negative")
        matrix[key] += 1
    return matrix


def _summary(rows):
    observed = [row for row in rows if row["observed"]]
    missing = [row for row in rows if not row["observed"]]
    return {
        "counts": {"stationed_samples": len(rows), "observed": len(observed),
                   "partial_observations": sum(row["observed"] and row["available_channels"] < 4 for row in rows),
                   "missing": len(missing),
                   "asset_positive_all_samples": sum(row["asset_truth"] for row in rows),
                   "asset_negative_all_samples": sum(not row["asset_truth"] for row in rows),
                   "asset_positive_missing": sum(row["asset_truth"] for row in missing),
                   "asset_negative_missing": sum(not row["asset_truth"] for row in missing),
                   "drift_positive_all_samples": sum(row["sensor_truth"] for row in rows)},
        "asset_detection": {"denominator_observed": len(observed),
                            "confusion": _matrix(rows, "asset_truth", "asset_predicted")},
        "high_cost_recommendations": {
            "denominator_observed": len(observed),
            "confusion": _matrix(rows, "asset_truth", "high_cost_recommended"),
            "recommended_total": sum(row["high_cost_recommended"] for row in rows),
            "recommended_with_missing_evidence": sum(row["high_cost_recommended"] for row in missing),
            "interpretation": "Action recommendations at the evaluation snapshot, scored using hypothetical loss units."},
        "sensor_drift_detection": {"denominator_observed": len(observed),
                                  "confusion": _matrix(rows, "sensor_truth", "sensor_predicted"),
                                  "interpretation": "Sensor/installation posterior evaluated against the injected measurement-drift label."},
    }


def run_twin_evaluation(seeds: int | Iterable[int] = 6, minute: int = 55,
                        start_seed: int = 42, anomaly_threshold: float = 0.65,
                        sensor_threshold: float = 0.25) -> dict:
    """Run every scenario with the same seed list and no optional actions.

    Only five originally stationed drone/asset slots per run are scored. The
    remaining mapped segments have no labelled injected faults or observations
    and must not inflate true negatives. Missing observations are counted with
    their hidden labels separately and excluded from the observed matrices.
    """
    if not isinstance(minute, int) or isinstance(minute, bool) or not 0 <= minute <= MISSION_MINUTES:
        raise ValueError(f"minute must be an integer in [0, {MISSION_MINUTES}]")
    if not isinstance(start_seed, int) or isinstance(start_seed, bool) or start_seed < 0:
        raise ValueError("start_seed must be a nonnegative integer")
    if isinstance(seeds, bool):
        raise ValueError("seeds must be a positive count or nonempty sequence")
    if isinstance(seeds, int):
        if seeds <= 0:
            raise ValueError("At least one evaluation seed is required")
        seed_values = list(range(start_seed, start_seed+seeds))
    else:
        seed_values = list(seeds)
    if not seed_values or any(not isinstance(seed, int) or isinstance(seed, bool) or seed < 0 for seed in seed_values):
        raise ValueError("Seeds must be nonnegative integers")
    if len(set(seed_values)) != len(seed_values):
        raise ValueError("Evaluation seeds must be distinct")
    for threshold in (anomaly_threshold, sensor_threshold):
        if not isinstance(threshold, (float, int)) or isinstance(threshold, bool) or not math.isfinite(threshold) or not 0 < threshold < 1:
            raise ValueError("Thresholds must be finite and strictly between zero and one")

    cases, all_rows, scenario_rows = [], [], {scenario: [] for scenario in EVALUATION_SCENARIOS}
    for seed in seed_values:
        for scenario in EVALUATION_SCENARIOS:
            simulation = TwinSimulation(scenario=scenario, seed=seed)
            # Pin evaluation truth to the original first occupied physical asset,
            # matching the simulator scenario assignment without reading its
            # private injection selector. No relocation/verify action is called.
            original_sites = {drone.sensor_id: drone.asset_id for drone in simulation.drones}
            anomaly_asset_id = simulation.drones[0].asset_id
            simulation.advance_to(minute)
            rows = []
            for drone in simulation.drones:
                asset_id = drone.asset_id
                reading = deepcopy(simulation.latest.get(asset_id))
                inference = deepcopy(simulation.current(asset_id))
                recommendations = deepcopy(simulation.recommendations[asset_id])
                available = sum(reading is not None and isinstance(reading.get(channel), (int, float))
                                and math.isfinite(reading[channel]) for channel in CHANNELS)
                observed = bool(available and inference.get("evidence") and inference["status"] != "Unknown")
                truth = hidden_scenario_state(drone.sensor_id, minute, scenario,
                                              asset_id=asset_id, anomaly_asset_id=anomaly_asset_id)
                asset_truth = bool(truth["mechanical_anomaly"] or truth["thermal_anomaly"])
                p = inference.get("anomaly")
                s = inference.get("sensor_fault")
                top = recommendations[0]["action"]
                rows.append({"sensor_id": drone.sensor_id, "asset_id": asset_id,
                             "original_asset_id": original_sites[drone.sensor_id],
                             "observed": observed, "available_channels": available,
                             "truth": truth, "asset_truth": asset_truth,
                             "sensor_truth": bool(truth["measurement_drift"]),
                             "asset_predicted": bool(observed and p is not None and p >= anomaly_threshold),
                             "sensor_predicted": bool(observed and s is not None and s >= sensor_threshold),
                             "high_cost_recommended": top in HIGH_COST_ACTIONS,
                             "recommended_action": top, "reading": reading,
                             "inference": inference, "recommendations": recommendations})
            all_rows.extend(rows)
            scenario_rows[scenario].extend(rows)
            cases.append({"seed": seed, "scenario": scenario, "minute": minute,
                          "baseline_version": simulation.baseline.version,
                          "mapped_assets": len(simulation.dataset.segments),
                          "unobserved_mapped_assets_not_scored": len(simulation.dataset.segments)-len(rows),
                          "summary": _summary(rows), "rows": rows,
                          "weather": deepcopy(simulation.weather),
                          "weather_decision": deepcopy(simulation.weather_decision),
                          "audit": deepcopy(simulation.audit)})
    report = {
        "metadata": {
            "title": "GridScout stationary synthetic snapshot validation",
            "synthetic": True, "model_version": MODEL_VERSION,
            "minute": minute, "seeds": seed_values, "scenarios": dict(EVALUATION_SCENARIOS),
            "anomaly_threshold": float(anomaly_threshold), "sensor_threshold": float(sensor_threshold),
            "high_cost_action_names": sorted(HIGH_COST_ACTIONS), "costs": dict(DEFAULT_COSTS),
            "executed_optional_actions": 0,
            "protocol": "Matched seeds across six scenarios; five fixed occupied assets; passive telemetry collection to one evaluation timestamp.",
            "denominators": "Confusion matrices use observed stationed slots. Missing stationed slots and their hidden labels have separate counts. The scoring population is the five stationed assets.",
            "assumptions": [
                "Probability calibration status: synthetic demonstration parameters.",
                "Independent healthy synthetic history fits the frozen conditional baseline; generator and fault models are exercise assumptions.",
                "The evaluator reads fault labels after inference and action recommendations to score the resulting predictions.",
                "Each run scores the current assessment at one evaluation timestamp.",
                "Expected loss values use hypothetical relative cost units.",
                "Results describe model responses to the configured synthetic fault and observation generators.",
                "Matched synthetic samples provide descriptive comparisons across scenarios and seeds.",
            ],
        },
        "overall": _summary(all_rows),
        "scenarios": [{"scenario": scenario, "label": SCENARIOS[scenario],
                       "summary": _summary(scenario_rows[scenario])} for scenario in EVALUATION_SCENARIOS],
        "cases": cases,
    }
    # Fail loudly rather than silently serialize NaN or silently change counts.
    json.dumps(report, allow_nan=False)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seeds", type=int, default=6, help="Matched seed count, starting at --start-seed")
    parser.add_argument("--start-seed", type=int, default=42)
    parser.add_argument("--minute", type=int, default=55)
    parser.add_argument("--minute55", dest="minute", action="store_const", const=55, help=argparse.SUPPRESS)
    parser.add_argument("--output", type=Path, default=Path("artifacts/twin_validation.json"))
    args = parser.parse_args(argv)
    try:
        report = run_twin_evaluation(args.seeds, args.minute, args.start_seed)
    except ValueError as error:
        parser.error(str(error))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    compact = {item["scenario"]: item["summary"] for item in report["scenarios"]}
    print(json.dumps({"output": str(args.output.resolve()), "minute": args.minute,
                      "seeds": report["metadata"]["seeds"], "scenarios": compact}, ensure_ascii=False))
    return report


if __name__ == "__main__":
    main()
