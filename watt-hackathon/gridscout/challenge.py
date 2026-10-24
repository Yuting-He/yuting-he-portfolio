"""Official challenge engine: public reports, hypothetical readings, explicit charging.

No organizer fault truth, customer supply model, or electrical connectivity is
invented here. The legacy synthetic laboratory remains a separate simulator.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from copy import deepcopy
import hashlib
import math

from .beliefs import expected_information_gain, update_beliefs
from .models import BeliefState, Observation
from .official_data import OfficialDataset, choose_sites, haversine_km, load_official_dataset

POLICIES = ("Evidence + information gain", "Risk-only", "Random")
READINGS = ("Positive", "Negative", "Inconclusive")


@dataclass(frozen=True)
class ChallengeConfig:
    seed: int = 42
    sensor_count: int = 5
    mission_minutes: float = 240.0
    max_flight_minutes: float = 30.0
    charge_minutes: float = 180.0
    speed_km_per_minute: float = .6
    inspection_minutes: float = 5.0
    sensitivity: float = .9
    specificity: float = .94
    information_weight: float = .35
    inconclusive_probability: float = .2
    start_lines: tuple[str, ...] = ()
    assumed_charging_lines: tuple[str, ...] | None = None
    allow_terminal_visits: bool = False

    def __post_init__(self):
        if self.sensor_count != 5:
            raise ValueError("The official challenge uses exactly five sensors")
        if self.max_flight_minutes != 30 or self.charge_minutes != 180:
            raise ValueError("Official limits are 30 flight minutes and 180 charging minutes")
        for name in ("mission_minutes", "speed_km_per_minute", "inspection_minutes"):
            if not math.isfinite(getattr(self,name)) or getattr(self,name) <= 0:
                raise ValueError(f"{name} must be positive and finite")
        for name in ("sensitivity", "specificity"):
            if not .5 <= getattr(self,name) <= 1:
                raise ValueError(f"{name} must be between .5 and 1")
        if not 0 <= self.inconclusive_probability < 1:
            raise ValueError("Inconclusive probability must be in [0,1)")
        if not math.isfinite(self.information_weight) or self.information_weight < 0:
            raise ValueError("Information weight must be finite and nonnegative")
        if not isinstance(self.seed,int) or self.seed < 0:
            raise ValueError("Seed must be a nonnegative integer")
        if self.start_lines and (len(self.start_lines) != 5 or len(set(self.start_lines)) != 5):
            raise ValueError("Select five distinct starting line IDs")


@dataclass(frozen=True)
class ChargingSite:
    energized: bool | None
    sufficient_power: bool | None
    source: str

    @property
    def can_charge(self):
        return self.energized is True and self.sufficient_power is True


@dataclass(frozen=True)
class ChallengeAction:
    sensor_id: str
    line_id: str
    start: float
    arrival: float
    finish: float
    flight_minutes: float
    origin_line: str

    @property
    def is_flight(self):
        return self.origin_line != self.line_id


@dataclass
class ChallengeSensor:
    sensor_id: str
    line_id: str
    status: str = "ready"
    needs_charge: bool = False
    charge_started_at: float | None = None
    charge_ready_at: float | None = None
    flight_count: int = 0


@dataclass(frozen=True)
class ChallengeReading:
    line_id: str
    sensor_id: str
    time: float
    result: str
    source: str = "Hypothetical seeded demonstration"


@dataclass(frozen=True)
class ChallengeRecommendation:
    action: ChallengeAction
    probability: float
    information_gain: float
    normalized_risk: float
    normalized_information: float
    score: float
    can_charge: bool
    report_ids: tuple[str, ...]


@dataclass
class ChallengeState:
    config: ChallengeConfig
    dataset: OfficialDataset
    beliefs: BeliefState
    sites: dict[str, ChargingSite]
    sensors: list[ChallengeSensor]
    time: float = 0
    pending: dict[str, ChallengeAction] = field(default_factory=dict)
    readings: list[ChallengeReading] = field(default_factory=list)
    evidence: list[dict] = field(default_factory=list)
    history: list[dict] = field(default_factory=list)
    finished: bool = False
    initial_probabilities: dict[str, float] = field(default_factory=dict)


def create_report_beliefs(dataset: OfficialDataset) -> BeliefState:
    """Reports set illustrative priors ONCE; they are never treated as measurements.

    Report 01 selects the assumed severity prior (.10,.35,.55). Each spatially
    intersecting report 02–06 supplies one weak log-odds offset (.35,.20,.10,.30,.25).
    LINE_024's known de-energization is modeled separately, not as known damage.
    """
    zones = {key: row["hazard_zone"] for key,row in dataset.segments.items()}
    priors = {zone:(.10,.35,.55) for zone in sorted(set(zones.values()))}
    conditionals = {key:tuple(1/(1+math.exp(-(-3.4+1.1*s+row["report_log_odds"])))
                              for s in range(3)) for key,row in dataset.segments.items()}
    marginals = {key:sum(p*q for p,q in zip(priors[zones[key]],probs))
                 for key,probs in conditionals.items()}
    return BeliefState(dict(priors),dict(priors),conditionals,zones,marginals)


def create_challenge(config: ChallengeConfig | None = None, dataset: OfficialDataset | None = None):
    config = config or ChallengeConfig()
    dataset = dataset or load_official_dataset()
    assumptions = (choose_sites(dataset, 12) if config.assumed_charging_lines is None
                   else config.assumed_charging_lines)
    if any(key not in dataset.segments for key in assumptions) or "LINE_024" in assumptions:
        raise ValueError("Charging assumptions must reference valid lines other than de-energized LINE_024")
    starts = config.start_lines or choose_sites(dataset,5,assumptions or None)
    if len(starts) != 5 or any(key not in dataset.segments for key in starts):
        raise ValueError("Five valid, distinct initial line IDs are required")
    sites = {key:ChargingSite(None,None,"Official dataset: charging status unknown") for key in dataset.segments}
    for key in assumptions:
        sites[key] = ChargingSite(True,True,"Explicit demo assumption — energized and sufficient charging power")
    sites["LINE_024"] = ChargingSite(False,None,"Official SYN_REPORT_03: precautionarily de-energized")
    beliefs = create_report_beliefs(dataset)
    state = ChallengeState(config,dataset,beliefs,sites,
                           [ChallengeSensor(f"Sensor {i+1}",key) for i,key in enumerate(starts)],
                           initial_probabilities=dict(beliefs.line_probabilities))
    state.history.append({"type":"initial_information", "time":0,
                          "reports":[r["information_id"] for r in dataset.reports],
                          "initial_sites":dict(zip((s.sensor_id for s in state.sensors),starts)),
                          "note":"All six reports available at mission start; original timestamps record source provenance"})
    return state


def _attempts(state, line):
    return sum(r.line_id == line for r in state.readings)


def feasible_challenge_actions(state: ChallengeState, sensor: ChallengeSensor):
    if state.finished or sensor.sensor_id in state.pending:
        return []
    reserved = {a.line_id for a in state.pending.values()}
    # An unresolved starting/perched sensor owns its site; simultaneous duplicates cannot occur.
    reserved |= {s.line_id for s in state.sensors if s.sensor_id != sensor.sensor_id
                 and s.line_id not in state.beliefs.observations}
    current = sensor.line_id
    if current not in state.beliefs.observations and _attempts(state,current) < 2 and current not in reserved:
        finish = state.time + state.config.inspection_minutes
        return [ChallengeAction(sensor.sensor_id,current,state.time,state.time,finish,0,current)] if (
            finish <= state.config.mission_minutes+1e-9) else []
    if sensor.needs_charge:
        return []
    actions = []
    for line,row in sorted(state.dataset.segments.items()):
        if line == current or line in reserved or _attempts(state,line):
            continue
        if not state.sites[line].can_charge and not state.config.allow_terminal_visits:
            continue
        flight = haversine_km(state.dataset.segments[current]["position"],row["position"]) / state.config.speed_km_per_minute
        if flight > state.config.max_flight_minutes+1e-9:
            continue
        arrival = state.time+flight
        finish = arrival+state.config.inspection_minutes
        if finish <= state.config.mission_minutes+1e-9:
            actions.append(ChallengeAction(sensor.sensor_id,line,state.time,arrival,finish,flight,current))
    return actions


def rank_challenge_actions(state, actions, policy="Evidence + information gain"):
    if policy not in POLICIES:
        raise ValueError("Unknown official policy")
    information = {a.line_id: expected_information_gain(state.beliefs,a.line_id,state.config.sensitivity,
                                                      state.config.specificity) for a in actions}
    maxrisk = max((state.beliefs.line_probabilities[a.line_id] for a in actions),default=0)
    maxinfo = max(information.values(),default=0)
    result=[]
    for action in actions:
        p=state.beliefs.line_probabilities[action.line_id]
        risk=p/maxrisk if maxrisk else 0
        info=information[action.line_id]/maxinfo if maxinfo > 1e-12 else 0
        # Independent of hidden truths and pure when previewing recommendations.
        if policy == "Random":
            payload=f"{state.config.seed}|{len(state.readings)}|{action.sensor_id}|{action.line_id}".encode()
            score=int.from_bytes(hashlib.sha256(payload).digest()[:8],"big")/2**64
        else:
            score=(risk+(state.config.information_weight*info if policy==POLICIES[0] else 0))/(
                action.flight_minutes+state.config.inspection_minutes)
        result.append(ChallengeRecommendation(action,p,information[action.line_id],risk,info,score,
                                               state.sites[action.line_id].can_charge,
                                               tuple(state.dataset.segments[action.line_id]["report_ids"])))
    return sorted(result,key=lambda r:(-r.score,r.action.line_id))


def recommend_challenge(state,policy=POLICIES[0]):
    for sensor in state.sensors:
        actions=feasible_challenge_actions(state,sensor)
        if actions:
            return rank_challenge_actions(state,actions,policy)
    return []


def _settled_status(sensor):
    return "ready" if not sensor.needs_charge else (
        "charging" if sensor.charge_ready_at is not None else "awaiting_power")


def _begin_charge(state,sensor):
    if sensor.needs_charge and state.sites[sensor.line_id].can_charge:
        sensor.charge_started_at=state.time
        sensor.charge_ready_at=state.time+state.config.charge_minutes
        state.history.append({"type":"charge_start","time":state.time,"sensor_id":sensor.sensor_id,
                              "line_id":sensor.line_id,"finish_time":sensor.charge_ready_at,
                              "energized":True,"sufficient_power":True,
                              "source":state.sites[sensor.line_id].source})


def set_charging_site(state,line_id,energized,sufficient_power):
    """Explicit operator/demo status; never infer live status from voltage or damage."""
    if line_id == "LINE_024":
        raise ValueError("Official LINE_024 remains de-energized throughout the scenario")
    if line_id not in state.sites or any(value is not None and not isinstance(value,bool)
                                        for value in (energized,sufficient_power)):
        raise ValueError("Use a valid line and True/False/None site statuses")
    state.sites[line_id]=ChargingSite(energized,sufficient_power,"Explicit operator/demo site assumption")
    if state.finished and state.time < state.config.mission_minutes:
        state.finished=False
        state.history.append({"type":"mission_resumed","time":state.time,
                              "note":"Operator changed a site assumption before the horizon"})
    for sensor in state.sensors:
        if sensor.line_id != line_id or not sensor.needs_charge:
            continue
        if not state.sites[line_id].can_charge:
            if sensor.charge_ready_at is not None:
                state.history.append({"type":"charge_interrupted","time":state.time,
                                      "sensor_id":sensor.sensor_id,"line_id":line_id})
            sensor.charge_started_at=sensor.charge_ready_at=None
        elif sensor.charge_ready_at is None:
            _begin_charge(state,sensor)
        if sensor.sensor_id not in state.pending:
            sensor.status=_settled_status(sensor)
    state.history.append({"type":"site_status_assumption","time":state.time,"line_id":line_id,
                          "energized":energized,"sufficient_power":sufficient_power})


def _reading(state,action,override):
    if override is not None and override not in READINGS:
        raise ValueError("Unknown hypothetical report")
    if override:
        result=override
    else:
        payload=f"{state.config.seed}|{action.line_id}|{_attempts(state,action.line_id)}".encode()
        uniform=int.from_bytes(hashlib.sha256(payload).digest()[:8],"big")/2**64
        if uniform < state.config.inconclusive_probability:
            result="Inconclusive"
        else:
            p=state.beliefs.line_probabilities[action.line_id]
            positive=state.config.sensitivity*p+(1-state.config.specificity)*(1-p)
            uniform=(uniform-state.config.inconclusive_probability)/(1-state.config.inconclusive_probability)
            result="Positive" if uniform < positive else "Negative"
    return ChallengeReading(action.line_id,action.sensor_id,state.time,result,
                            "Hypothetical manual example" if override else
                            "Hypothetical posterior-predictive example")


def advance_challenge(state:ChallengeState,policy=POLICIES[0],reading_override=None):
    """Dispatch feasible work, advance to arrival/report/charge events, then replan.

    Charging overlaps perched observation, never flight. A short flight still
    requires a full 180-minute recharge. Inconclusive results have likelihood one
    and leave beliefs unchanged; one in-place retry is allowed while charging.
    """
    if state.finished:
        return []
    if reading_override is not None and reading_override not in READINGS:
        raise ValueError("Unknown hypothetical report")
    for sensor in state.sensors:
        actions=feasible_challenge_actions(state,sensor)
        if not actions:
            continue
        action=rank_challenge_actions(state,actions,policy)[0].action
        state.pending[sensor.sensor_id]=action
        sensor.status="in_flight" if action.is_flight else "observing"
        state.history.append({"type":"flight_start" if action.is_flight else "measurement_start",
                              "time":state.time,"sensor_id":sensor.sensor_id,"line_id":action.line_id,
                              "origin_line":action.origin_line,"flight_minutes":action.flight_minutes,
                              "arrival":action.arrival,"finish_time":action.finish})
    times=[]
    for sensor in state.sensors:
        action=state.pending.get(sensor.sensor_id)
        if action:
            times.append(action.arrival if sensor.status=="in_flight" else action.finish)
        if sensor.charge_ready_at is not None:
            times.append(sensor.charge_ready_at)
    if not times:
        state.finished=True
        state.history.append({"type":"mission_complete","time":state.time,"note":"No feasible work or future charging event"})
        return []
    next_time=min(times)
    if next_time > state.config.mission_minutes+1e-9:
        state.time=state.config.mission_minutes
        state.finished=True
        state.history.append({"type":"mission_complete","time":state.time,"note":"Four-hour horizon reached"})
        return []
    state.time=next_time
    events=[]
    for sensor in state.sensors:
        action=state.pending.get(sensor.sensor_id)
        if action and sensor.status=="in_flight" and action.arrival <= state.time+1e-9:
            sensor.line_id=action.line_id
            sensor.flight_count+=1
            sensor.needs_charge=True
            sensor.charge_started_at=sensor.charge_ready_at=None
            _begin_charge(state,sensor)
            sensor.status="observing"
            event={"type":"flight_arrival","time":state.time,"sensor_id":sensor.sensor_id,
                   "line_id":action.line_id,"flight_minutes":action.flight_minutes}
            state.history.append(event); events.append(event)
        if sensor.charge_ready_at is not None and sensor.charge_ready_at <= state.time+1e-9:
            if not state.sites[sensor.line_id].can_charge:
                raise RuntimeError("Charge completed without energized and sufficient-power status")
            sensor.needs_charge=False
            sensor.charge_ready_at=sensor.charge_started_at=None
            if sensor.sensor_id not in state.pending:
                sensor.status="ready"
            event={"type":"charge_complete","time":state.time,"sensor_id":sensor.sensor_id,"line_id":sensor.line_id}
            state.history.append(event); events.append(event)
        if action and sensor.status!="in_flight" and action.finish <= state.time+1e-9:
            reading=_reading(state,action,reading_override)
            reading_override=None  # A manual example affects only the first report at this event.
            before=deepcopy(state.beliefs)
            if reading.result != "Inconclusive":
                state.beliefs=update_beliefs(state.beliefs,Observation(action.line_id,reading.result=="Positive",
                    state.time,sensor.sensor_id,f"official-demo-{len(state.readings)+1}"),
                    state.config.sensitivity,state.config.specificity)
            state.readings.append(reading)
            zone=state.beliefs.line_zones[action.line_id]
            state.evidence.append({"reading":reading,"zone":zone,
                                   "prior_probability":before.line_probabilities[action.line_id],
                                   "posterior_probability":state.beliefs.line_probabilities[action.line_id],
                                   "prior_zone":before.zone_severity[zone],"posterior_zone":state.beliefs.zone_severity[zone],
                                   "before_probabilities":dict(before.line_probabilities),
                                   "after_probabilities":dict(state.beliefs.line_probabilities)})
            del state.pending[sensor.sensor_id]
            sensor.status=_settled_status(sensor)
            event={"type":"hypothetical_reading","time":state.time,"sensor_id":sensor.sensor_id,
                   "line_id":action.line_id,"result":reading.result,"source":reading.source}
            state.history.append(event); events.append(event)
    return events


def run_challenge(state,policy=POLICIES[0]):
    for _ in range(1000):
        if state.finished:
            return state
        advance_challenge(state,policy)
    raise RuntimeError("Official mission exceeded its event bound")


def action_advice(state,line_id):
    readings=[r for r in state.readings if r.line_id==line_id]
    if not readings:
        return "Collect evidence", "Initial reports identify approximate areas; collect a site reading."
    latest=readings[-1]
    if latest.result=="Inconclusive":
        return "Seek additional evidence", "An inconclusive reading retains the prior belief. Repeat locally or request a field check."
    if latest.result=="Positive":
        return "Recommend operator / field inspection", "Hypothetical anomaly supports verification; repair requires fault identification and operator authorization."
    return "Continue monitoring", "A negative example reduces modeled anomaly probability. Energization follows the site's separate operational status."


def export_challenge(state):
    from dataclasses import asdict
    return {"model":"official-challenge-v1","configuration":asdict(state.config),
            "dataset_provenance":state.dataset.manifest,"finished":state.finished,"time":state.time,
            "initial_reports":list(state.dataset.reports),
            "charging_statuses":{key:asdict(site) for key,site in state.sites.items()},
            "sensors":[asdict(sensor) for sensor in state.sensors],
            "readings":[asdict(reading) for reading in state.readings],"history":state.history,
            "evidence":[{**event,"reading":asdict(event["reading"])} for event in state.evidence]}


def main():
    import argparse
    import json
    from pathlib import Path
    parser=argparse.ArgumentParser(description="Run the official four-hour hypothetical inspection mission")
    parser.add_argument("--seed",type=int,default=42)
    parser.add_argument("--conservative",action="store_true",help="Initialize charging power as unknown at every site")
    parser.add_argument("--output",type=Path,default=Path("artifacts/official_mission.json"))
    args=parser.parse_args()
    state=run_challenge(create_challenge(ChallengeConfig(seed=args.seed,
        assumed_charging_lines=() if args.conservative else None)))
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(export_challenge(state),indent=2,ensure_ascii=False),encoding="utf-8")
    flights=[e for e in state.history if e["type"]=="flight_start"]
    print(f"Official mission finished={state.finished}; time={state.time:.1f}; sensors={len(state.sensors)}; "
          f"readings={len(state.readings)}; flights={len(flights)}; "
          f"max flight={max((e['flight_minutes'] for e in flights),default=0):.2f} min")
    print(f"Evidence export: {args.output}")


if __name__=="__main__":
    main()
