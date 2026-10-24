"""Controlled bridge from private simulation truth to noisy sensor evidence."""
from .models import HiddenEnvironment, InspectionAction, Observation, ScenarioConfig


def observe(environment: HiddenEnvironment, action: InspectionAction,
            config: ScenarioConfig) -> Observation:
    threshold = (config.sensitivity if environment.failures[action.line_id]
                 else 1 - config.specificity)
    positive = environment.observation_uniforms[action.line_id] < threshold
    return Observation(line_id=action.line_id, positive=positive,
                       time=action.finish_time, sensor_id=action.sensor_id,
                       observation_id=f"{environment.fingerprint}:{action.line_id}")
