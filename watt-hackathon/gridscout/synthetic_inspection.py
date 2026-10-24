"""Independent, imperfect inspection observations from the synthetic world.

The world generator samples an observation conditional on the injected scenario.
The mission controller receives that sampled observation. Imagery is an assumed
additional payload capability.
"""
from __future__ import annotations

import hashlib
import random

from .synthetic_telemetry import hidden_scenario_state
from .inspection_model import inspection_positive_probability, inspection_spec


def generate_inspection(sensor_id, asset_id, minute, operation_id, *, scenario,
                        seed, anomaly_asset_id, modality="rgb", visibility="clear", quality="valid"):
    """One reproducible observation per operation, sampled from world state.

    Generation and inference share explicit, uncalibrated observation assumptions.
    Default RGB views detect visible mechanical evidence. Thermal views detect
    thermal evidence. Twelve percent of otherwise ideal views are inconclusive;
    degraded views increase that probability. Communication loss is inconclusive.
    """
    digest = hashlib.sha256(repr((seed, operation_id, "inspection-camera-v1")).encode()).digest()
    rng = random.Random(int.from_bytes(digest[:8], "little"))
    state = hidden_scenario_state(sensor_id, minute, scenario, asset_id, anomaly_asset_id)
    spec = inspection_spec({"modality": modality, "visibility": visibility, "quality": quality})
    if state["communication_loss"]:
        result, quality = "inconclusive", "missing"
    elif rng.random() < 1-spec["coverage"]:
        result = "inconclusive"
    else:
        positive = inspection_positive_probability(state["mechanical_anomaly"], state["thermal_anomaly"], spec)
        result = "supports" if rng.random() < positive else "clear"
    return {"observation_id": f"inspection:{operation_id}", "operation_id": operation_id,
            "sensor_id": sensor_id, "asset_id": asset_id, "result": result,
            "quality": quality, "modality": modality, "visibility": visibility,
            "observed_at": minute, "received_at": minute,
            "synthetic": True, "source": "Independent synthetic inspection camera",
            "note": "Assumed optional imagery capability; sampled observation with modality-specific detection uncertainty.",
            "model": spec["model"], "calibrated": False}
