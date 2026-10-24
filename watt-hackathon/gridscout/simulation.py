"""Simulation orchestration; the only boundary that can read hidden truth."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .beliefs import update_beliefs
from .decisions import rank_candidates
from .hazards import create_beliefs, create_environment
from .impact import line_impacts
from .models import (BeliefState, GridState, HiddenEnvironment, LineImpact, MissionState,
                     Observation, Recommendation, ScenarioConfig, SensorState)
from .network import build_grid
from .observations import observe
from .scheduler import (assign, available_sensors, complete_return_arrivals, feasible_actions,
                        finish_return_to_base, return_sensor_to_base)


@dataclass
class Simulation:
    config: ScenarioConfig
    grid: GridState
    beliefs: BeliefState
    environment: HiddenEnvironment
    mission: MissionState
    impacts: dict[str, LineImpact]
    initial_probabilities: dict[str, float]
    rng: np.random.Generator


def create_simulation(config: ScenarioConfig | None = None) -> Simulation:
    config = config or ScenarioConfig()
    grid = build_grid()
    beliefs = create_beliefs(grid, config)
    environment = create_environment(grid, beliefs, config)
    sensors = [SensorState(f"Sensor {index + 1}", grid.base_position,
                           remaining_endurance=config.endurance_minutes)
               for index in range(config.sensor_count)]
    return Simulation(config, grid, beliefs, environment, MissionState(0.0, sensors),
                      line_impacts(grid, config), dict(beliefs.line_probabilities),
                      np.random.default_rng(config.seed))


def _rank_for_sensor(sim: Simulation, sensor: SensorState, policy: str, mode: str) -> list[Recommendation]:
    actions = feasible_actions(sim.grid, sensor, sim.mission, set(sim.beliefs.observations), sim.config)
    return rank_candidates(sim.beliefs, actions, sim.impacts, sim.initial_probabilities, sim.config,
                           policy, mode, epoch=len(sim.mission.completed),
                           remaining_endurance=sensor.remaining_endurance)


def recommend(sim: Simulation, policy: str = "GridScout Advanced",
              mode: str = "Restoration-aware") -> list[Recommendation]:
    """Preview the first available sensor's ranking with no state changes."""
    if sim.mission.finished:
        return []
    for sensor in available_sensors(sim.mission):
        ranked = _rank_for_sensor(sim, sensor, policy, mode)
        if ranked:
            return ranked
    return []


def step(sim: Simulation, policy: str = "GridScout Advanced",
         mode: str = "Restoration-aware") -> list[Observation]:
    """Assign idle sensors then advance to the next inspection-completion event.

All sensors becoming ready at the event are processed before the next planning
round. Ties are deterministic; Bayesian likelihoods yield the same final state
regardless of observation order. Inspection never repairs a damaged line.
"""
    mission = sim.mission
    if mission.finished:
        return []
    for sensor in available_sensors(mission):
        ranked = _rank_for_sensor(sim, sensor, policy, mode)
        if ranked:
            assign(mission, ranked[0].action)
        else:
            return_sensor_to_base(sim.grid, mission, sensor, sim.config)
    if not mission.pending:
        finish_return_to_base(sim.grid, mission, sim.config)
        return []
    mission.time = min(action.finish_time for action in mission.pending.values())
    complete_return_arrivals(sim.grid, mission)
    ready = sorted((action for action in mission.pending.values()
                    if abs(action.finish_time - mission.time) < 1e-9),
                   key=lambda action: action.sensor_id)
    new_observations = []
    for action in ready:
        sensor = next(item for item in mission.sensors if item.sensor_id == action.sensor_id)
        sensor.position = action.destination
        sensor.remaining_endurance = max(0.0, sensor.remaining_endurance - action.duration)
        sensor.status = "idle"
        sensor.target_line = None
        del mission.pending[action.sensor_id]
        observation = observe(sim.environment, action, sim.config)
        prior_probabilities = dict(sim.beliefs.line_probabilities)
        zone = sim.beliefs.line_zones[action.line_id]
        prior_zone = tuple(sim.beliefs.zone_severity[zone])
        sim.beliefs = update_beliefs(sim.beliefs, observation, sim.config.sensitivity, sim.config.specificity)
        posterior_probabilities = dict(sim.beliefs.line_probabilities)
        posterior_zone = tuple(sim.beliefs.zone_severity[zone])
        neighbor_changes = {
            line_id: {"before": prior_probabilities[line_id], "after": posterior_probabilities[line_id],
                      "delta": posterior_probabilities[line_id] - prior_probabilities[line_id]}
            for line_id, line_zone in sim.beliefs.line_zones.items()
            if line_zone == zone and line_id != action.line_id
        }
        mission.evidence.append({
            "observation": observation, "line_id": action.line_id, "zone": zone,
            "positive": observation.positive, "prior_probability": prior_probabilities[action.line_id],
            "posterior_probability": posterior_probabilities[action.line_id],
            "prior_zone": prior_zone, "posterior_zone": posterior_zone,
            "prior_severity": prior_zone, "posterior_severity": posterior_zone,
            "prior_probabilities": prior_probabilities, "posterior_probabilities": posterior_probabilities,
            "before_probabilities": prior_probabilities, "after_probabilities": posterior_probabilities,
            "neighbor_changes": neighbor_changes,
        })
        mission.completed.append(observation)
        mission.history.append({"type": "inspection", "time": mission.time, "line_id": action.line_id,
                                "sensor_id": action.sensor_id, "positive": observation.positive})
        new_observations.append(observation)
    return new_observations


def auto_run(sim: Simulation, policy: str = "GridScout Advanced",
             mode: str = "Restoration-aware") -> Simulation:
    # Each step completes at least one previously uninspected edge, or finishes.
    for _ in range(len(sim.beliefs.line_probabilities) + 2):
        if sim.mission.finished:
            return sim
        step(sim, policy, mode)
    raise RuntimeError("Mission did not terminate within the bounded inspection count")
