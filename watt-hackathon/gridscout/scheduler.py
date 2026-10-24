"""Feasible, event-driven inspection scheduling with a return-to-base reserve.

Distances are straight-line synthetic kilometres. Endurance is a time budget;
there is no assumption that a de-energized power line can recharge a sensor.
"""
from __future__ import annotations

import math

from .models import GridState, InspectionAction, MissionState, ScenarioConfig, SensorState
from .network import lines


def travel_minutes(start: tuple[float, float], end: tuple[float, float], config: ScenarioConfig) -> float:
    return math.dist(start, end) / config.speed_km_per_minute


def available_sensors(mission: MissionState) -> list[SensorState]:
    return sorted(
        (sensor for sensor in mission.sensors if sensor.status == "idle" and sensor.available_at <= mission.time + 1e-9),
        key=lambda sensor: sensor.sensor_id,
    )


def inspection_action(grid: GridState, sensor: SensorState, line_id: str, now: float,
                      config: ScenarioConfig) -> InspectionAction | None:
    """Return an action only if inspection AND the home journey fit both limits."""
    if sensor.status != "idle" or sensor.available_at > now + 1e-9:
        return None
    attributes = lines(grid)[line_id]
    destination = tuple(attributes["midpoint"])
    travel = travel_minutes(sensor.position, destination, config)
    inspection = float(attributes["inspection_minutes"])
    home = travel_minutes(destination, grid.base_position, config)
    finish = now + travel + inspection
    if travel + inspection + home > sensor.remaining_endurance + 1e-9:
        return None
    if finish + home > config.mission_minutes + 1e-9:
        return None
    return InspectionAction(sensor.sensor_id, line_id, now, finish, travel, inspection, home, destination)


def feasible_actions(grid: GridState, sensor: SensorState, mission: MissionState,
                     inspected: set[str], config: ScenarioConfig) -> list[InspectionAction]:
    reserved = {action.line_id for action in mission.pending.values()}
    result = []
    for line_id in sorted(lines(grid)):
        if line_id in inspected or line_id in reserved:
            continue
        action = inspection_action(grid, sensor, line_id, mission.time, config)
        if action is not None:
            result.append(action)
    return result


def assign(mission: MissionState, action: InspectionAction) -> None:
    """Reserve a line immediately so a simultaneous assignment cannot duplicate it."""
    if action.sensor_id in mission.pending:
        raise ValueError("Sensor already has a pending assignment")
    if action.line_id in {item.line_id for item in mission.pending.values()}:
        raise ValueError("Line already has a pending assignment")
    if action.line_id in {item.line_id for item in mission.completed}:
        raise ValueError("Line already inspected")
    sensor = next(sensor for sensor in mission.sensors if sensor.sensor_id == action.sensor_id)
    if sensor.status != "idle":
        raise ValueError("Sensor must be idle")
    mission.pending[action.sensor_id] = action
    sensor.status = "inspecting"
    sensor.target_line = action.line_id
    sensor.available_at = action.finish_time
    mission.history.append({"type": "assignment", "time": mission.time,
                            "sensor_id": action.sensor_id, "line_id": action.line_id,
                            "finish_time": action.finish_time, "action": action})


def return_sensor_to_base(grid: GridState, mission: MissionState, sensor: SensorState,
                          config: ScenarioConfig) -> None:
    """Dispatch an idle sensor home immediately when no further work fits."""
    if sensor.status in ("returning", "returned"):
        return
    if sensor.status != "idle":
        raise ValueError("Only an idle sensor can begin its return journey")
    home = travel_minutes(sensor.position, grid.base_position, config)
    if home > sensor.remaining_endurance + 1e-8:
        raise RuntimeError("Return reserve was exhausted")
    if mission.time + home > config.mission_minutes + 1e-8:
        raise RuntimeError("Return journey would exceed mission time")
    sensor.remaining_endurance = max(0.0, sensor.remaining_endurance - home)
    sensor.available_at = mission.time + home
    sensor.status = "returning"
    sensor.target_line = None
    mission.history.append({"type": "return", "time": mission.time,
                            "sensor_id": sensor.sensor_id, "finish_time": sensor.available_at})
    complete_return_arrivals(grid, mission)


def complete_return_arrivals(grid: GridState, mission: MissionState) -> None:
    """Resolve arrivals up to the current event; keep transit at its last stop."""
    arriving = sorted((sensor for sensor in mission.sensors
                       if sensor.status == "returning" and sensor.available_at <= mission.time + 1e-9),
                      key=lambda sensor: (sensor.available_at, sensor.sensor_id))
    for sensor in arriving:
        sensor.position = grid.base_position
        sensor.status = "returned"
        mission.history.append({"type": "return_complete", "time": sensor.available_at,
                                "sensor_id": sensor.sensor_id})


def finish_return_to_base(grid: GridState, mission: MissionState, config: ScenarioConfig) -> None:
    if mission.pending:
        raise ValueError("Cannot finish while an inspection is pending")
    last_return = mission.time
    for sensor in mission.sensors:
        return_sensor_to_base(grid, mission, sensor, config)
        last_return = max(last_return, sensor.available_at)
    mission.time = last_return
    complete_return_arrivals(grid, mission)
    mission.finished = True
    mission.history.append({"type": "mission_complete", "time": mission.time})
