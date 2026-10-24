"""Shared public contracts. HiddenEnvironment is never passed to policies."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
import math
import networkx as nx


@dataclass(frozen=True)
class ScenarioConfig:
    hazard: str = "Storm"
    severity: str = "High"
    sensor_count: int = 2
    mission_minutes: float = 90.0
    sensitivity: float = 0.9
    specificity: float = 0.94
    information_weight: float = 0.35
    decision_weight: float = 0.25
    seed: int = 42
    endurance_minutes: float = 100.0
    speed_km_per_minute: float = 0.6
    demand_weight: float = 0.5
    customer_weight: float = 0.3
    critical_weight: float = 0.2

    def __post_init__(self):
        if self.hazard not in ("Storm", "Wildfire", "Heatwave"):
            raise ValueError("Unknown hazard")
        if self.severity not in ("Low", "Medium", "High"):
            raise ValueError("Unknown severity")
        if not isinstance(self.sensor_count, int) or not 1 <= self.sensor_count <= 5:
            raise ValueError("Use 1–5 sensors")
        for name in ("sensitivity", "specificity"):
            if not 0.5 <= getattr(self, name) <= 1:
                raise ValueError(f"{name} must be between 0.5 and 1")
        for name in ("mission_minutes", "endurance_minutes", "speed_km_per_minute"):
            if not math.isfinite(getattr(self, name)) or getattr(self, name) <= 0:
                raise ValueError(f"{name} must be positive and finite")
        for name in ("information_weight", "decision_weight", "demand_weight", "customer_weight", "critical_weight"):
            if not math.isfinite(getattr(self, name)) or getattr(self, name) < 0:
                raise ValueError(f"{name} must be nonnegative and finite")
        if self.demand_weight + self.customer_weight + self.critical_weight <= 0:
            raise ValueError("At least one service impact weight must be positive")
        if not isinstance(self.seed, int) or self.seed < 0:
            raise ValueError("Seed must be a nonnegative integer")


@dataclass
class GridState:
    graph: nx.Graph
    sources: tuple[str, ...]
    base_position: tuple[float, float]


@dataclass(frozen=True)
class Observation:
    line_id: str
    positive: bool
    time: float = 0.0
    sensor_id: str = "hypothetical"
    observation_id: str = ""


@dataclass
class BeliefState:
    prior_severity: dict[str, tuple[float, float, float]]
    zone_severity: dict[str, tuple[float, float, float]]
    conditional_failure: dict[str, tuple[float, float, float]]
    line_zones: dict[str, str]
    line_probabilities: dict[str, float]
    observations: dict[str, Observation] = field(default_factory=dict)


@dataclass
class HiddenEnvironment:
    failures: dict[str, bool]
    zone_severity: dict[str, int]
    observation_uniforms: dict[str, float]
    fingerprint: str


@dataclass(frozen=True)
class InspectionAction:
    sensor_id: str
    line_id: str
    start_time: float
    finish_time: float
    travel_minutes: float
    inspection_minutes: float
    return_minutes: float
    destination: tuple[float, float]

    @property
    def duration(self) -> float:
        return self.travel_minutes + self.inspection_minutes


@dataclass
class SensorState:
    sensor_id: str
    position: tuple[float, float]
    available_at: float = 0.0
    remaining_endurance: float = 100.0
    status: str = "idle"
    target_line: str | None = None


@dataclass
class MissionState:
    time: float
    sensors: list[SensorState]
    pending: dict[str, InspectionAction] = field(default_factory=dict)
    completed: list[Observation] = field(default_factory=list)
    evidence: list[dict[str, Any]] = field(default_factory=list)
    history: list[dict[str, Any]] = field(default_factory=list)
    finished: bool = False


@dataclass(frozen=True)
class LineImpact:
    line_id: str
    customers: float
    demand_kw: float
    critical_sites: float
    weighted: float


@dataclass(frozen=True)
class Recommendation:
    action: InspectionAction
    probability: float
    impact: LineImpact
    expected_fault_impact: float
    information_gain: float
    decision_value: float
    score: float
    normalized_risk: float = 0.0
    normalized_information: float = 0.0
    normalized_decision: float = 0.0


@dataclass
class EvaluationResult:
    policy: str
    seed: int
    environment_fingerprint: str
    weighted_faults_detected: float
    inspection_coverage: float
    first_critical_detection_minutes: float | None
    remaining_undetected_impact: float
    runtime_seconds: float
    inspections: int
    positive_reports: int
    true_faults_detected: int

