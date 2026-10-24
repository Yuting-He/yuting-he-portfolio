"""Paired offline policy benchmarks with descriptive uncertainty.

True-fault metrics are evaluated only after the mission, outside policy code.
The weighted-fault metric sums isolated-failure service-impact weights. It is a
fault-prioritization proxy; overlapping downstream outages are not additive.
There is no repair simulation and no customer interruption-duration claim.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict, replace
from pathlib import Path
from time import perf_counter
from collections.abc import Iterable

import numpy as np
import pandas as pd

from .decisions import POLICIES
from .models import EvaluationResult, ScenarioConfig
from .simulation import auto_run, create_simulation


def run_benchmark(config: ScenarioConfig, seeds: Iterable[int] | int,
                  policies: Iterable[str] | None = None) -> list[EvaluationResult]:
    """Run matched worlds; per-line sensor draws are fixed before any policy runs.

An integer seeds argument means that many consecutive seeds starting at
config.seed. Explicit seed sequences make cross-run pairing unambiguous.
Runtime includes constructing the world and running the policy; it is measured,
not deterministic. All other result fields are independent of execution order.
"""
    seed_values = list(range(config.seed, config.seed + seeds)) if isinstance(seeds, int) else list(seeds)
    policy_values = list(POLICIES if policies is None else policies)
    if not seed_values:
        raise ValueError("At least one benchmark seed is required")
    if not policy_values or any(policy not in POLICIES for policy in policy_values):
        raise ValueError("Choose at least one supported policy")
    results = []
    for seed in seed_values:
        scenario = replace(config, seed=int(seed))
        for policy in policy_values:
            start = perf_counter()
            sim = auto_run(create_simulation(scenario), policy)
            runtime = perf_counter() - start
            detections = [observation for observation in sim.mission.completed
                          if observation.positive and sim.environment.failures[observation.line_id]]
            detected = {observation.line_id for observation in detections}
            critical_times = [observation.time for observation in detections
                              if sim.impacts[observation.line_id].critical_sites > 0]
            results.append(EvaluationResult(
                policy=policy, seed=int(seed), environment_fingerprint=sim.environment.fingerprint,
                weighted_faults_detected=sum(sim.impacts[line_id].weighted for line_id in detected),
                inspection_coverage=len(sim.mission.completed) / len(sim.impacts),
                first_critical_detection_minutes=min(critical_times) if critical_times else None,
                remaining_undetected_impact=sum(impact.weighted for line_id, impact in sim.impacts.items()
                                                if sim.environment.failures[line_id] and line_id not in detected),
                runtime_seconds=runtime, inspections=len(sim.mission.completed),
                positive_reports=sum(observation.positive for observation in sim.mission.completed),
                true_faults_detected=len(detected),
            ))
    return results


def summarize_results(results: list[EvaluationResult]) -> pd.DataFrame:
    """Long-form means, SDs, empirical bootstrap intervals, and sample counts.

The time-to-critical-detection mean is conditional on a detection. Misses are
right-censored at mission end and excluded from that mean, so ALWAYS present
critical_detection_rate alongside it. Intervals describe sampling variability;
a small benchmark does not justify significance claims.
"""
    columns = ["policy", "metric", "mean", "std", "ci_low", "ci_high", "n", "observed_n", "interpretation"]
    if not results:
        return pd.DataFrame(columns=columns)
    frame = pd.DataFrame(asdict(result) for result in results)
    frame["critical_detection_rate"] = frame["first_critical_detection_minutes"].notna().astype(float)
    metrics = ["weighted_faults_detected", "inspection_coverage", "first_critical_detection_minutes",
               "critical_detection_rate", "remaining_undetected_impact", "runtime_seconds",
               "inspections", "positive_reports", "true_faults_detected"]
    rows = []
    for policy, group in frame.groupby("policy", sort=True):
        for metric in metrics:
            values = group[metric].dropna().to_numpy(dtype=float)
            count = len(values)
            mean = float(values.mean()) if count else float("nan")
            std = float(values.std(ddof=1)) if count > 1 else (0.0 if count else float("nan"))
            if count:
                # Fixed local RNG; summary results never depend on policy order.
                rng = np.random.default_rng(20261023)
                bootstrap_means = rng.choice(values, size=(1000, count), replace=True).mean(axis=1)
                low, high = np.quantile(bootstrap_means, (0.025, 0.975)).tolist()
            else:
                low = high = float("nan")
            note = "Descriptive 95% empirical bootstrap interval for the mean"
            if metric == "first_critical_detection_minutes":
                note += "; conditional on detection, non-detections censored at mission end"
            rows.append({"policy": policy, "metric": metric, "mean": mean, "std": std,
                         "ci_low": low, "ci_high": high, "n": len(group), "observed_n": count,
                         "interpretation": note})
    return pd.DataFrame(rows, columns=columns)


def main() -> None:
    parser = argparse.ArgumentParser(description="Reproducible paired GridScout policy benchmark")
    parser.add_argument("--seeds", type=int, default=12, help="Number of consecutive paired seeds")
    parser.add_argument("--seed", type=int, default=42, help="Starting seed")
    parser.add_argument("--minutes", type=float, default=90.0, help="Mission duration in simulated minutes (default: demo preset 90)")
    parser.add_argument("--output", type=Path, default=Path("artifacts/benchmark.csv"))
    arguments = parser.parse_args()
    results = run_benchmark(ScenarioConfig(seed=arguments.seed, mission_minutes=arguments.minutes), arguments.seeds)
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(asdict(result) for result in results).to_csv(arguments.output, index=False)
    summary = summarize_results(results)
    summary_path = arguments.output.with_name(f"{arguments.output.stem}_summary.csv")
    summary.to_csv(summary_path, index=False)
    print(summary[summary.metric.isin(["weighted_faults_detected", "critical_detection_rate", "inspection_coverage"])].to_string(index=False))
    print(f"\nRaw paired results: {arguments.output}\nSummary: {summary_path}")


if __name__ == "__main__":
    main()
