"""Frozen conditional healthy reference fitted to independent synthetic history.

Units and coefficients are exercise assumptions, not calibrated Nomadic hardware.
Inference and live telemetry do not share a measurement generator with this fit.
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import hashlib
import math

import numpy as np

from .operating_state import operating_context

CHANNELS = ("temperature_c", "vibration_rms", "voltage_pu", "tilt_deg")


def _features(context: dict) -> dict[str, np.ndarray]:
    ambient = float(context.get("ambient_c", 20.0))
    wind = max(0.0, float(context.get("wind_mps", 3.0)))
    gust = max(wind, float(context.get("gust_mps", wind)))
    solar = max(0.0, float(context.get("solar_wm2", 400.0)))
    load = context.get("load_pu")
    # E[L²] for the healthy training load distribution, not inferred from voltage.
    load_squared = 0.4758333333 if load is None else float(load) ** 2
    energized = float(bool(context.get("energized", True)))
    mechanical = np.array([1.0, wind, wind**2, gust - wind])
    return {
        "temperature_c": np.array([1.0, ambient, wind, solar, load_squared * energized]),
        "vibration_rms": mechanical,
        "voltage_pu": np.array([1.0, energized]),
        "tilt_deg": mechanical,
    }


@dataclass(frozen=True)
class NormalBaseline:
    """Read-only training result; no live measurements are absorbed into it."""

    coefficients: dict[str, tuple[float, ...]]
    residual_sd: dict[str, float]
    mechanical_correlation: float
    version: str
    training_count: int
    seed: int

    def predict(self, context: dict, mode: str = "perched") -> dict:
        operation = operating_context(context)
        if not operation["known"]:
            # Keep separate physical hypotheses. A wide moment-matched reference
            # is for display only; inference uses the conditional components.
            on = self.predict({**context, "energized": True}, mode)
            off = self.predict({**context, "energized": False}, mode)
            p = operation["prior_energized"]
            result = {}
            for channel in CHANNELS:
                a, b = on[channel], off[channel]
                mean = p*a["mean"]+(1-p)*b["mean"]
                variance = p*(a["sd"]**2+(a["mean"]-mean)**2)+(1-p)*(b["sd"]**2+(b["mean"]-mean)**2)
                result[channel] = {"mean": mean, "sd": math.sqrt(variance),
                                   "low": min(a["low"], b["low"]), "high": max(a["high"], b["high"])}
            result["operating_components"] = {"on": on, "off": off}
            return result
        features = _features(context)
        result = {}
        wind = max(0.0, float(context.get("wind_mps", 3.0)))
        mechanical_scale = 1 + 0.04 * wind
        for channel in CHANNELS:
            mean = float(features[channel] @ np.array(self.coefficients[channel]))
            sd = self.residual_sd[channel]
            if channel in ("vibration_rms", "tilt_deg"):
                sd *= mechanical_scale
                if mode not in ("perched", "charging"):
                    # Flight is outside the stable installation baseline.
                    sd *= 8.0
            if channel == "temperature_c" and context.get("load_pu") is None and context.get("energized", True):
                sd = math.hypot(sd, 6.0)
            if channel == "temperature_c" and not context.get("energized", True):
                sd = max(sd, 2.0)
            low = mean - 1.96 * sd
            high = mean + 1.96 * sd
            if channel in ("vibration_rms", "voltage_pu"):
                low = max(0.0, low)
            result[channel] = {"mean": mean, "sd": float(sd), "low": float(low), "high": float(high)}
        return result


@lru_cache(maxsize=8)
def fit_normal_baseline(seed: int = 42) -> NormalBaseline:
    """OLS fit to 3,600 independently generated labelled healthy records.

    Training spans weather, load and energized states. Residual scale and joint
    mechanical correlation are estimated from training, rather than asserted by
    the live simulator. This cached frozen fit is stable for an exercise run.
    """
    rng = np.random.default_rng(seed)
    count = 3600
    ambient = rng.uniform(-5, 36, count)
    wind = rng.uniform(0, 17, count)
    gust_excess = rng.uniform(0, 10, count)
    solar = rng.uniform(0, 950, count)
    load = rng.uniform(0.25, 1.05, count)
    energized = rng.choice([0.0, 1.0], size=count, p=[0.12, 0.88])
    temp_x = np.column_stack([np.ones(count), ambient, wind, solar, load**2 * energized])
    mech_x = np.column_stack([np.ones(count), wind, wind**2, gust_excess])
    voltage_x = np.column_stack([np.ones(count), energized])
    shared = rng.normal(size=count)
    independent = rng.normal(size=count)
    factor = 1 + 0.04 * wind
    observations = {
        "temperature_c": 2.0 + ambient - 0.32 * wind + 0.007 * solar + 24 * load**2 * energized + rng.normal(0, 1.8, count),
        "vibration_rms": 0.24 + 0.045 * wind + 0.006 * wind**2 + 0.025 * gust_excess + 0.16 * factor * shared,
        "voltage_pu": 0.003 + 0.997 * energized + rng.normal(0, 0.012, count),
        "tilt_deg": 0.02 + 0.025 * wind + 0.08 * gust_excess + 0.38 * factor * (0.62 * shared + math.sqrt(1 - 0.62**2) * independent),
    }
    matrices = {"temperature_c": temp_x, "vibration_rms": mech_x, "voltage_pu": voltage_x, "tilt_deg": mech_x}
    coefficients, scales, residuals = {}, {}, {}
    for channel in CHANNELS:
        x = matrices[channel]
        beta = np.linalg.lstsq(x, observations[channel], rcond=None)[0]
        residual = observations[channel] - x @ beta
        if channel in ("vibration_rms", "tilt_deg"):
            residual = residual / factor
        coefficients[channel] = tuple(float(value) for value in beta)
        scales[channel] = float(np.std(residual, ddof=x.shape[1]))
        residuals[channel] = residual
    correlation = float(np.corrcoef(residuals["vibration_rms"], residuals["tilt_deg"])[0, 1])
    signature = hashlib.sha256(repr((seed, coefficients)).encode()).hexdigest()[:10]
    return NormalBaseline(coefficients, scales, correlation, f"healthy-synthetic-v1-{signature}", count, seed)
