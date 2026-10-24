"""Deterministic live-like measurements from an independent synthetic process.

Public records never contain injected state/truth. Healthy generator physics are
intentionally slightly different from the regression baseline. A one-minute
record is an aggregated feature window, not an actual high-frequency waveform.
"""
from __future__ import annotations

import hashlib
import math
import re

import numpy as np

CHANNELS = ("temperature_c", "vibration_rms", "voltage_pu", "tilt_deg")
SCENARIOS = {
    "normal": "Normal operation · healthy",
    "gusts": "Strong gusts · no injected damage",
    "mechanical": "Persistent mechanical anomaly after gusts",
    "thermal": "Thermal anomaly with normal load variation",
    "dropout": "Communication loss on Drone 5",
    "drift": "Measurement drift on Drone 1",
    "dynamic": "Dynamic mission · evolving evidence and revised reports",
}


def _rng(seed, *keys):
    digest = hashlib.sha256(repr((seed, keys)).encode()).digest()
    return np.random.default_rng(int.from_bytes(digest[:8], "little"))


def _unit_id(sensor_id) -> int:
    match = re.search(r"(\d+)$", str(sensor_id))
    return int(match.group(1)) if match else 1


def _smooth_noise(seed, sensor_id, minute, component):
    """Finite AR-like moving average; stable across calls/processes and order."""
    window = math.floor(minute)
    weights = [0.72**lag for lag in range(8)]
    variance = math.sqrt(sum(weight**2 for weight in weights))
    return sum(weight * _rng(seed, sensor_id, component, window - lag).normal()
               for lag, weight in enumerate(weights)) / variance


def generate_reading(sensor_id, asset_id, minute: float, context: dict,
                     scenario: str = "mechanical", seed: int = 42, mode: str = "perched") -> dict:
    """Return an arrived synthetic feature window; no baseline/inference imports."""
    if scenario not in SCENARIOS:
        raise ValueError(f"Unknown synthetic scenario: {scenario}")
    if not math.isfinite(minute) or minute < 0:
        raise ValueError("Exercise minute must be finite and nonnegative")
    index = _unit_id(sensor_id)
    window = math.floor(minute)
    # Windows end at their timestamps. Fixed receipt latency is included without
    # pretending a future measurement has already arrived.
    observed = max(0.0, float(minute) - 0.08)
    result = {"observation_id": f"syn:{seed}:{scenario}:{sensor_id}:{asset_id}:{window}:{mode}",
              "window_id": f"{sensor_id}:{asset_id}:{window}", "sensor_id": sensor_id,
              "asset_id": asset_id, "observed_at": observed, "received_at": float(minute),
              "mode": mode, "quality": "valid", "synthetic": True,
              "source": "Independent synthetic telemetry generator",
              "units": {"temperature_c": "°C", "vibration_rms": "exercise RMS units", "voltage_pu": "pu", "tilt_deg": "degrees from installation reference"}}
    if scenario == "dropout" and index == 5 and minute >= 30:
        return {**result, "quality": "missing", **{channel: None for channel in CHANNELS}}
    ambient = float(context.get("ambient_c", 20))
    wind = max(0.0, float(context.get("wind_mps", 3)))
    gust = max(wind, float(context.get("gust_mps", wind)))
    solar = max(0.0, float(context.get("solar_wm2", 400)))
    supplied_load = context.get("load_pu")
    # Hidden operating load is deliberately not put into public records/context.
    load = (0.62 + 0.12 * math.sin(minute / 23 + index * 0.5)) if supplied_load is None else float(supplied_load)
    energized = bool(context.get("energized", True))
    shared = _smooth_noise(seed, sensor_id, minute, "mechanical-common")
    other = _smooth_noise(seed, sensor_id, minute, "tilt")
    scale = 1 + 0.045 * wind
    installation = (index - 3) * 0.025
    temp = 2.25 + ambient - 0.30 * wind + 0.0068 * solar + 23.5 * load**2 * energized
    temp += 1.9 * _smooth_noise(seed, sensor_id, minute, "temperature")
    vibration = 0.25 + 0.044 * wind + 0.0062 * wind**2 + 0.024 * (gust - wind) + 0.17 * scale * shared
    tilt = 0.025 + installation + 0.026 * wind + 0.078 * (gust - wind)
    tilt += 0.40 * scale * (0.59 * shared + math.sqrt(1 - 0.59**2) * other)
    voltage = (1.0 if energized else 0.003) + 0.0125 * _smooth_noise(seed, sensor_id, minute, "voltage")
    # Engines can pin an asset defect to a physical line across redeployments.
    # Device faults remain tied to a sensor; this simulation-only context flag
    # must not be forwarded to inference and is never copied into the record.
    affected_asset = (str(asset_id) == str(context["anomaly_asset_id"])) if "anomaly_asset_id" in context else bool(context.get("asset_fault_target", index == 1))
    if scenario == "dynamic":
        # World state is tied to physical assets and exercise time, never to a
        # selected drone or its route. Nothing from this state enters the packet.
        from .dynamic_scenario import dynamic_asset_state
        strength = dynamic_asset_state(asset_id, minute)["mechanical_strength"]
        vibration += 1.4 * strength
        tilt += 3.0 * strength
    if minute >= 25:
        elapsed = minute - 25
        if scenario == "mechanical" and affected_asset:
            progression = min(1.0, elapsed / 8.0)
            vibration += 1.4 * progression
            tilt += 3.0 * progression
        elif scenario == "thermal" and affected_asset:
            temp += 26.0 * min(1.0, elapsed / 10.0)
        elif scenario == "drift" and index == 1:
            temp += min(18.0, 0.25 * elapsed)
            tilt += min(3.0, 0.035 * elapsed)
            if minute >= 60:
                result["quality"] = "suspect"
                result["quality_note"] = "Exercise device self-check reports calibration concern"
    if mode not in ("perched", "charging"):
        vibration += 4.0 + abs(shared)
        tilt += 5.0 * math.sin(minute)
        result["quality"] = "suspect"
        result["quality_note"] = "Flight/unstable installation: mechanical features unsuitable for line inference"
    result.update(temperature_c=float(temp), vibration_rms=float(max(0.0, vibration)),
                  voltage_pu=float(max(0.0, voltage)), tilt_deg=float(tilt))
    return result


def hidden_scenario_state(sensor_id, minute: float, scenario: str = "mechanical",
                          asset_id=None, anomaly_asset_id=None) -> dict:
    """Offline evaluator only. Never attach this to a public telemetry record."""
    index = _unit_id(sensor_id)
    if scenario == "dynamic":
        from .dynamic_scenario import dynamic_asset_state
        state = dynamic_asset_state(asset_id, minute)
        return {key: value for key, value in state.items() if key != "mechanical_strength"}
    affected_asset = (asset_id == anomaly_asset_id) if anomaly_asset_id is not None else index == 1
    return {"mechanical_anomaly": scenario == "mechanical" and affected_asset and minute >= 29,
            "thermal_anomaly": scenario == "thermal" and affected_asset and minute >= 29,
            "measurement_drift": scenario == "drift" and index == 1 and minute >= 25,
            "communication_loss": scenario == "dropout" and index == 5 and minute >= 30}
