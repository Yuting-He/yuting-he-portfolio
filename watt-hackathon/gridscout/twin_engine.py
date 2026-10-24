"""One causal clock for the synthetic state twin, observations and drone tasks.

The official asset geometry is real challenge input; telemetry, weather, charging
sites and numerical operating limits below are explicit demonstration assumptions.
No simulator fault truth is read by inference, relocation, or visual review.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict, dataclass, is_dataclass
import math

from .official_data import choose_sites, haversine_km, load_official_dataset
from .conditional_baseline import fit_normal_baseline
from .synthetic_telemetry import generate_reading
from .weather_context import weather_at
from .asset_inference import infer_asset
from .action_policy import recommend_actions
from .autonomous_ops import AutonomousOperations
from .synthetic_inspection import generate_inspection
from .inspection_model import inspection_spec
from .operating_state import operating_context
from .bn_structure import model_structure


MISSION_MINUTES = 240
CHARGE_MINUTES = 180
MAX_FLIGHT_MINUTES = 30
MAX_SPEED_MPS = 60.0
DEMO_CRUISE_SPEED_MPS = 20.0
DEMO_SPEED_KM_PER_MINUTE = DEMO_CRUISE_SPEED_MPS * .06
DEMO_MAX_GUST_MPS = 18.0
STALE_AFTER_MINUTES = 2
VISUAL_TTL_MINUTES = 15
CHANNELS = ("temperature_c", "vibration_rms", "voltage_pu", "tilt_deg")


@dataclass
class Drone:
    sensor_id: str
    asset_id: str
    status: str = "perched"
    needs_charge: bool = False
    charge_started_at: int | None = None
    charge_ready_at: int | None = None
    origin_asset: str | None = None
    target_asset: str | None = None
    departure_at: int | None = None
    arrival_at: int | None = None
    flight_count: int = 0
    speed_mps: float = 0.0
    transit_quality: str = "stationary"

    @property
    def flight_origin(self):
        return self.origin_asset

    @property
    def flight_target(self):
        return self.target_asset

    @property
    def flight_arrival(self):
        return self.arrival_at


def _json_safe(value):
    """Return only JSON values, also supporting baseline dataclasses."""
    if is_dataclass(value):
        return _json_safe(asdict(value))
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if hasattr(value, "item"):
        return _json_safe(value.item())
    return str(value)


class TwinSimulation:
    """Seeded synthetic streams; inference consumes received public evidence only."""

    def __init__(self, scenario="mechanical", seed=42, autonomous=False):
        if not isinstance(seed, int) or isinstance(seed, bool) or seed < 0:
            raise ValueError("Seed must be a nonnegative integer")
        self.scenario = scenario
        self.seed = seed
        self.minute = 0
        self.dataset = load_official_dataset()
        self.baseline = fit_normal_baseline(seed=seed)
        self.charging_sites = set(choose_sites(self.dataset, 12))
        self.drones = [Drone(f"Drone {i + 1}", asset)
                       for i, asset in enumerate(choose_sites(self.dataset, 5))]
        self._scenario_asset = self.drones[0].asset_id
        self.history = []
        self.latest = {}
        self.assessments = {}
        # Compact observations of the current-window model, not recursively
        # accumulated probabilities. A second row in a window denotes new
        # inspection evidence or a freshness/coverage transition.
        self.assessment_history = []
        self.inspection_history = []
        self._assessment_signatures = {}
        self._inspection_history_ids = set()
        self.recommendations = {}
        self.visual_evidence = {}
        self.operating_records = {
            asset: {"energized": asset != "LINE_024", "energized_prior": .9,
                    "operating_source": "Official exercise: preventive de-energization" if asset == "LINE_024" else
                                        "Explicit synthetic initial energized assumption", "received_at": 0}
            for asset in self.dataset.segments}
        self.inspection_requests = []
        self._request_event_ids = set()
        self.audit = []
        self.weather_history = []
        self._pending = []
        self._seen_observations = set()
        self._last_decisions = {}
        self._visual_statuses = {}
        self.autonomous = bool(autonomous)
        self._operations = AutonomousOperations(self)
        self.operations = self._operations.operations
        self.replans = self._operations.replans
        self.human_alerts = self._operations.alerts
        self.weather = weather_at(0, scenario=scenario, seed=seed)
        self.audit.append({
            "type": "initialization", "minute": 0, "synthetic": True,
            "scenario": scenario, "seed": seed,
            "initial_sites": {d.sensor_id: d.asset_id for d in self.drones},
            "charging_sites": sorted(self.charging_sites),
            "autonomous": self.autonomous,
            "note": "Charging power and flight envelope are demo assumptions; geometry is not electrical topology.",
        })
        self._observe_window()

    def _drone(self, sensor_id):
        for drone in self.drones:
            if drone.sensor_id == sensor_id:
                return drone
        raise ValueError(f"Unknown drone: {sensor_id}")

    def _public_context(self, drone):
        context = deepcopy(self.weather)
        # Hidden simulator load must never become an inference covariate. Known
        # operations, unlike inferred voltage, may state whether an asset is on.
        context.pop("load_pu", None)
        context["load_state"] = "unknown"
        context.update(self.operating_records[drone.asset_id])
        return context

    def _observe_window(self):
        """Generate each stationary window once, and release only arrived data."""
        self.weather_history.append(deepcopy(self.weather))
        for drone in self.drones:
            if drone.status == "flying":
                continue
            context = self._public_context(drone)
            # Scenario generation knows its assigned asset, but inference never
            # receives this injection selector or simulator hidden states.
            generation_context = {**context, "asset_fault_target": drone.asset_id == self._scenario_asset,
                                  # World state is separate from uncertain public records.
                                  "energized": drone.asset_id != "LINE_024"}
            reading = generate_reading(
                drone.sensor_id, drone.asset_id, self.minute, generation_context,
                scenario=self.scenario, seed=self.seed, mode=drone.status)
            reading = deepcopy(reading)
            reading.setdefault("sensor_id", drone.sensor_id)
            reading.setdefault("asset_id", drone.asset_id)
            reading.setdefault("observed_at", self.minute)
            reading.setdefault("received_at", self.minute)
            reading.setdefault("window_id", f"{drone.sensor_id}:{self.minute}")
            reading.setdefault("observation_id", f"{drone.sensor_id}:{drone.asset_id}:{self.minute}")
            reading["synthetic"] = True
            reading["baseline"] = self.baseline.predict(context, drone.status)
            reading["baseline_version"] = getattr(self.baseline, "version", "synthetic-healthy-frozen")
            reading["weather_context"] = {key: deepcopy(value) for key, value in context.items()
                                          if key not in {"messages", "forecast", "warnings"}}
            self._pending.append(reading)
        self._release_arrivals()
        self._refresh_assessments()

    def _release_arrivals(self):
        remaining = []
        for reading in self._pending:
            received = reading.get("received_at")
            if received is None:
                # Explicit missing messages are observable; packets with a future
                # received_at remain inaccessible until that decision time.
                received = reading.get("observed_at", self.minute)
            if received > self.minute:
                remaining.append(reading)
                continue
            key = reading["observation_id"]
            if key in self._seen_observations:
                continue
            self._seen_observations.add(key)
            self.history.append(reading)
            asset = reading["asset_id"]
            previous = self.latest.get(asset)
            if previous is None or reading["observed_at"] >= previous["observed_at"]:
                self.latest[asset] = reading
            self.audit.append({"type": "telemetry_received", "minute": self.minute,
                               "observation_id": key, "asset_id": asset,
                               "observed_at": reading["observed_at"],
                               "received_at": received, "synthetic": True})
        self._pending = remaining

    def _is_current(self, asset_id, reading):
        if reading is None:
            return False
        occupants = [d for d in self.drones if d.asset_id == asset_id and d.status != "flying"]
        if not occupants or reading.get("sensor_id") != occupants[0].sensor_id:
            return False
        return (reading.get("received_at") is None or reading["received_at"] <= self.minute) and (
            0 <= self.minute - reading.get("observed_at", -100) <= STALE_AFTER_MINUTES)

    def _unknown(self, asset_id, reason):
        return {"asset_id": asset_id, "mechanical": None, "thermal": None,
                "sensor_fault": None, "anomaly": None, "status": "Unknown",
                "quality": "stale" if asset_id in self.latest else "unobserved",
                "urgent": False, "evidence": [], "alternatives": [],
                "missing": [reason], "joint_states": [],
                "observation_scope": "No current stationary measurement",
                "synthetic": True, "minute": self.minute,
                "calculation": {"available": False, "reason": reason, "structure": model_structure(),
                                "operation": operating_context(self.operating_records[asset_id]),
                                "mode": "current-window; no temporal recursion"}}

    def _visual_provenance(self, asset_id):
        """Eligibility is evaluated at decision time, never at publication alone."""
        evidence = self.visual_evidence.get(asset_id)
        if evidence is None:
            return {"status": "not_collected", "eligible": False, "used": False,
                    "evidence": None, "age_minutes": None, "observation_id": None}
        observed = evidence.get("observed_at")
        received = evidence.get("received_at", observed)
        try:
            age = self.minute - observed
            if not math.isfinite(observed) or not math.isfinite(received):
                status = "invalid"
            elif received > self.minute or observed > self.minute:
                status = "not_received"
            elif received < observed:
                status = "invalid"
            else:
                status = "fresh" if age <= VISUAL_TTL_MINUTES else "stale"
        except (TypeError, ValueError, OverflowError):
            status, age = "invalid", None
        identifier = evidence.get("observation_id") or (
            f"visual:{asset_id}:{observed}:{evidence.get('result')}:{evidence.get('source')}")
        return {"status": status, "eligible": status == "fresh",
                "used": (status == "fresh" and inspection_spec(evidence)["usable"]
                         and evidence.get("result") in {"supports", "clear"}),
                "evidence": deepcopy(evidence), "age_minutes": age,
                "observation_id": identifier}

    def _record_assessment(self, asset_id, reading, result, visual):
        """Record distinct evidence states, not rerenders or every unknown asset."""
        if reading is None:
            return
        current = self._is_current(asset_id, reading)
        signature = (reading.get("observation_id"), current, result.get("status"),
                     result.get("quality"), visual["observation_id"], visual["status"],
                     repr(self.operating_records[asset_id]))
        if signature == self._assessment_signatures.get(asset_id):
            return
        self._assessment_signatures[asset_id] = signature
        known = result.get("status") != "Unknown" and current
        calculation = result.get("calculation") or {}
        summaries = calculation.get("summaries") or {}
        priors = calculation.get("priors") or result.get("priors") or {}
        prior_anomaly = priors.get("anomaly")
        if prior_anomaly is None and all(key in priors for key in ("mechanical", "thermal")):
            prior_anomaly = 1 - (1 - priors["mechanical"]) * (1 - priors["thermal"])
        telemetry_only = (summaries.get("telemetry_only") or {}).get("anomaly")
        if telemetry_only is None and known and not visual["used"]:
            telemetry_only = result.get("anomaly")
        row = {"minute": self.minute, "asset_id": asset_id,
               "sensor_id": reading.get("sensor_id"),
               "observation_id": reading.get("observation_id"),
               "observed_at": reading.get("observed_at"), "received_at": reading.get("received_at"),
               "status": result.get("status"), "quality": result.get("quality"),
               "fresh": current, "evidence_count": len(result.get("evidence", [])),
               "prior_anomaly": prior_anomaly if known else None,
               "telemetry_only_anomaly": telemetry_only if known else None,
               "with_visual_anomaly": result.get("anomaly") if known and visual["used"] else None,
               "visual_id": visual["observation_id"] if visual["status"] in {"fresh", "stale"} else None,
               "visual_status": visual["status"],
               "visual_result": (visual.get("evidence") or {}).get("result")
                                if visual["status"] in {"fresh", "stale"} else None,
               "visual_used": known and visual["used"],
               "model_mode": "current_window", "synthetic": True}
        row.update({key: result.get(key) if known else None
                    for key in ("anomaly", "mechanical", "thermal", "sensor_fault")})
        self.assessment_history.append(row)

    def _refresh_assessments(self):
        for asset_id in self.dataset.segments:
            reading = self.latest.get(asset_id)
            visual_info = self._visual_provenance(asset_id)
            visual = visual_info["evidence"]
            visual_status = visual_info["status"]
            if visual is not None:
                if visual_status == "stale" and self._visual_statuses.get(asset_id) != "stale":
                    self.audit.append({"type": "visual_review_expired", "minute": self.minute,
                                       "asset_id": asset_id, "observed_at": visual["observed_at"],
                                       "note": "Visual evidence older than the assumed 15-minute validity window; recollect before using it.",
                                       "synthetic": True})
            self._visual_statuses[asset_id] = visual_status
            if not self._is_current(asset_id, reading):
                result = self._unknown(asset_id, "No fresh received observation at the current location")
            else:
                context = deepcopy(reading.get("weather_context", self.weather))
                context.pop("load_pu", None)
                context["load_state"] = "unknown"
                context.update(self.operating_records[asset_id])
                # Recondition frozen coefficients after an operating-record update;
                # never rewrite the original telemetry or its source-time context.
                conditioned = dict(self.baseline.predict(context, reading.get("mode", "perched")))
                conditioned["mechanical_correlation"] = self.baseline.mechanical_correlation
                result = infer_asset(reading, conditioned, context,
                                     visual=visual if visual_status == "fresh" else None)
                result = dict(result)
                result.update(asset_id=asset_id, minute=self.minute, synthetic=True)
            result["visual_status"] = visual_status
            if visual_status == "stale":
                result["missing"].append("Visual review expired after 15 minutes; recollect if it can change the decision")
            self.assessments[asset_id] = result
            self._record_assessment(asset_id, reading, result, visual_info)
            self.recommendations[asset_id] = recommend_actions(result)
            if asset_id in self.latest:
                top = self.recommendations[asset_id][0]
                signature = (result["status"], top["action"])
                if signature != self._last_decisions.get(asset_id):
                    self.audit.append({"type": "decision_update", "minute": self.minute,
                                       "asset_id": asset_id, "status": result["status"],
                                       "action": top["action"], "reason": top["reason"],
                                       "expected_loss": top["expected_loss"],
                                       "next_check_minutes": top["next_check_minutes"],
                                       "synthetic": True})
                    self._last_decisions[asset_id] = signature

    def current(self, asset_id):
        if asset_id not in self.dataset.segments:
            raise ValueError(f"Unknown asset: {asset_id}")
        return self.assessments[asset_id]

    def set_operating_state(self, asset_id, energized, source="Operator demo input", prior_energized=.9):
        """Update a public inference record, not simulator truth or charging power."""
        if asset_id not in self.dataset.segments:
            raise ValueError(f"Unknown asset: {asset_id}")
        if energized is not None and type(energized) is not bool:
            raise ValueError("Operating state must be True, False or None (unknown)")
        if asset_id == "LINE_024" and energized is not False:
            raise ValueError("LINE_024 remains officially de-energized in this exercise")
        if isinstance(prior_energized, bool) or not isinstance(prior_energized, (int, float)) or not math.isfinite(prior_energized) or not 0 < prior_energized < 1:
            raise ValueError("Unknown-state prior must be strictly between zero and one")
        was_permitted = self._charging_permitted(asset_id)
        self.operating_records[asset_id] = {"energized": energized, "energized_prior": prior_energized,
                                             "operating_source": str(source), "received_at": self.minute}
        self.audit.append({"type": "operating_record_update", "minute": self.minute, "asset_id": asset_id,
                           **self.operating_records[asset_id], "synthetic": True,
                           "note": "Public operating record used by state inference. Charging requires a listed powered site."})
        for drone in self.drones:
            if drone.asset_id == asset_id and drone.status == "charging" and was_permitted != self._charging_permitted(asset_id):
                drone.charge_started_at = self.minute if self._charging_permitted(asset_id) else None
                drone.charge_ready_at = self.minute+CHARGE_MINUTES if self._charging_permitted(asset_id) else None
        self._refresh_assessments()
        return deepcopy(self.operating_records[asset_id])

    def _charging_permitted(self, asset_id):
        return asset_id in self.charging_sites and self.operating_records[asset_id]["energized"] is True

    def temporal_history(self, asset_id):
        """History of independent window posteriors, explicitly not a DBN."""
        self.current(asset_id)  # Keep asset validation consistent with current().
        return deepcopy([row for row in self.assessment_history if row["asset_id"] == asset_id])

    def explain_asset(self, asset_id):
        """A selected asset's evidence, calculation and frozen inspection records.

        `reading` is current evidence only; `last_reading` is clearly historical.
        Current calculation always uses this window's telemetry, never a past
        inspection's older telemetry. Inspection records preserve that past
        same-window comparison separately for honest review after expiry.
        """
        assessment = self.current(asset_id)
        last = self.latest.get(asset_id)
        fresh = self._is_current(asset_id, last)
        visual = self._visual_provenance(asset_id)
        if visual["status"] not in {"fresh", "stale"}:
            visual["evidence"] = None
            visual["observation_id"] = None
        visual["used"] = bool(visual["used"] and fresh and assessment.get("status") != "Unknown")
        age = None if last is None else self.minute - last.get("observed_at", self.minute)
        context = deepcopy(last.get("weather_context", self.weather)) if last is not None and fresh else None
        if context is not None:
            context.update(self.operating_records[asset_id])
        conditioned = ({**self.baseline.predict(context, last.get("mode", "perched")),
                        "mechanical_correlation": self.baseline.mechanical_correlation} if context is not None else None)
        return deepcopy({
            "asset_id": asset_id, "minute": self.minute,
            "model_mode": "current_window",
            "temporal_note": "Each point records one observation window and its eligible inspection.",
            "assessment": assessment, "calculation": assessment.get("calculation", {"available": False}),
            "reading": last if fresh else None, "last_reading": last,
            "baseline": conditioned,
            "context": context,
            "freshness": {"fresh": fresh, "age_minutes": age,
                          "observed_at": last.get("observed_at") if last else None,
                          "received_at": last.get("received_at") if last else None,
                          "stale_after_minutes": STALE_AFTER_MINUTES,
                          "source": last.get("source") if last else None},
            "visual": visual, "history": self.temporal_history(asset_id),
            "inspection_history": [row for row in self.inspection_history if row["asset_id"] == asset_id],
            "synthetic": True,
        })

    def _record_inspection_comparison(self, asset_id, evidence, previous_assessment):
        """Freeze a comparison at collection, so future windows cannot rewrite it."""
        visual = self._visual_provenance(asset_id)
        identifier = visual["observation_id"]
        if identifier in self._inspection_history_ids:
            return
        self._inspection_history_ids.add(identifier)
        current = self.assessments[asset_id]
        reading = self.latest.get(asset_id)
        calculation = current.get("calculation") or {}
        summaries = calculation.get("summaries") or {}
        available = current.get("status") != "Unknown" and self._is_current(asset_id, reading)
        before = (summaries.get("telemetry_only") or {}).get("anomaly")
        if before is None and not previous_assessment.get("visual_status") == "fresh":
            before = previous_assessment.get("anomaly")
        after = current.get("anomaly") if available else None
        inputs = self.explain_asset(asset_id) if available else {}
        record = {
            "id": identifier, "observation_id": identifier,
            "operation_id": evidence.get("operation_id"), "asset_id": asset_id,
            "sensor_id": evidence.get("sensor_id") or (reading or {}).get("sensor_id"),
            "minute": self.minute, "observed_at": evidence.get("observed_at"),
            "received_at": evidence.get("received_at"), "result": evidence.get("result"),
            "quality": evidence.get("quality"), "source": evidence.get("source"),
            "available": available, "visual_used": bool(available and visual["used"]),
            "before_anomaly": before if available else None, "after_anomaly": after,
            "delta_pp": (after - before) * 100 if before is not None and after is not None else None,
            "previous_current_anomaly": previous_assessment.get("anomaly"),
            "telemetry_observation_id": (reading or {}).get("observation_id"),
            "comparison_scope": "Historical same-window telemetry-only versus telemetry + this inspection",
            "reading": deepcopy(reading) if available else None,
            "baseline": deepcopy(inputs.get("baseline")),
            "context": deepcopy(inputs.get("context")),
            "calculation": deepcopy(calculation), "assessment": deepcopy(current),
            "visual": deepcopy(evidence), "synthetic": True,
        }
        self.inspection_history.append(record)

    def step(self, minutes=1):
        if not isinstance(minutes, int) or isinstance(minutes, bool) or minutes < 0:
            raise ValueError("Advance by a nonnegative integer number of minutes")
        for _ in range(min(minutes, MISSION_MINUTES - self.minute)):
            self.minute += 1
            self.weather = weather_at(self.minute, scenario=self.scenario, seed=self.seed)
            for drone in self.drones:
                if drone.status == "flying" and self.minute >= drone.arrival_at:
                    drone.asset_id = drone.target_asset
                    drone.status = "charging"
                    drone.speed_mps = 0.0
                    drone.transit_quality = "stationary"
                    drone.charge_started_at = self.minute if self._charging_permitted(drone.asset_id) else None
                    drone.charge_ready_at = self.minute+CHARGE_MINUTES if self._charging_permitted(drone.asset_id) else None
                    self.audit.append({"type": "arrival", "minute": self.minute,
                                       "sensor_id": drone.sensor_id, "asset_id": drone.asset_id,
                                       "charge_ready_at": drone.charge_ready_at, "synthetic": True})
                if drone.status == "charging" and not self._charging_permitted(drone.asset_id):
                    drone.charge_started_at = drone.charge_ready_at = None
                if drone.status == "charging" and self._charging_permitted(drone.asset_id) and drone.charge_ready_at is None:
                    drone.charge_started_at = self.minute
                    drone.charge_ready_at = self.minute+CHARGE_MINUTES
                if drone.status == "charging" and drone.charge_ready_at is not None and self.minute >= drone.charge_ready_at:
                    drone.status = "perched"
                    drone.needs_charge = False
                    self.audit.append({"type": "charge_complete", "minute": self.minute,
                                       "sensor_id": drone.sensor_id, "asset_id": drone.asset_id,
                                       "synthetic": True})
            self._observe_window()
            if self.autonomous:
                from .dynamic_scenario import generate_mission_requests
                for request in generate_mission_requests(self.minute, self.scenario, self.seed,
                        initial_assets=[d.asset_id for d in self.drones]):
                    self.receive_inspection_request(**request)
            if self.autonomous or self.operations:
                self._operations.tick(dispatch=self.autonomous)
        return self

    def set_autonomous(self, enabled):
        """Enable future dispatch; already airborne/collecting work finishes safely."""
        enabled = bool(enabled)
        if enabled != self.autonomous:
            self.autonomous = enabled
            self.audit.append({"type": "autonomous_mode_changed", "minute": self.minute,
                               "enabled": enabled, "synthetic": True,
                               "note": "Disabling stops new dispatch; existing flights/inspections and safety handoffs continue."})
        return self

    def receive_inspection_request(self, asset_id, priority="routine", reason="Received inspection request",
                                   request_id=None, received_at=None, expires_at=None, source="Synthetic operator report",
                                   issued_at=None, msg_type="Alert", event_id=None, deadline_at=None,
                                   related_asset_id=None, report_group=None, hold_for_inspection_asset=None,
                                   observation_need="Stationary imagery and four-channel telemetry", synthetic=True,
                                   note=None, references=None):
        """Receive an auditable public request lifecycle event, never simulator truth.

        Future messages are rejected at this boundary; the world must deliver them
        when received. Retransmissions are idempotent by event ID. Request Updates
        can move a pending target; Cancel never interrupts an airborne leg.
        """
        if asset_id not in self.dataset.segments:
            raise ValueError("Inspection request must reference a mapped asset")
        if priority not in {"routine", "high", "critical"} or msg_type not in {"Alert", "Update", "Cancel"}:
            raise ValueError("Unsupported request priority or lifecycle type")
        received_at = self.minute if received_at is None else received_at
        issued_at = received_at if issued_at is None else issued_at
        if not all(isinstance(t, (int, float)) and not isinstance(t, bool) and math.isfinite(t)
                   for t in (issued_at, received_at)) or not 0 <= issued_at <= received_at <= self.minute:
            raise ValueError("Requests require valid issued <= received <= current mission time")
        for value in (expires_at, deadline_at):
            if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < received_at):
                raise ValueError("Request expiration and deadline must follow receipt")
        for linked in (related_asset_id, hold_for_inspection_asset):
            if linked is not None and linked not in self.dataset.segments:
                raise ValueError("Related inspection asset must be mapped")
        request_id = request_id or f"request-{len(self.inspection_requests)+1:03d}"
        event_id = event_id or f"{request_id}:{msg_type}:{received_at}"
        if event_id in self._request_event_ids:
            return deepcopy(next(r for r in self.inspection_requests if r["event_id"] == event_id))
        request = {"request_id": str(request_id), "event_id": str(event_id), "asset_id": asset_id,
                   "priority": priority, "reason": str(reason), "received_at": received_at,
                   "issued_at": issued_at, "expires_at": expires_at, "source": str(source),
                   "msg_type": msg_type, "synthetic": True, "related_asset_id": related_asset_id,
                   "report_group": report_group, "hold_for_inspection_asset": hold_for_inspection_asset}
        request["observation_need"] = str(observation_need)
        request.update(note=note, references=deepcopy(references or []))
        if deadline_at is not None:
            request["deadline_at"] = deadline_at
        self.inspection_requests.append(request)
        self._request_event_ids.add(event_id)
        self.audit.append({"type": "inspection_request_received", "minute": self.minute, **deepcopy(request)})
        return deepcopy(request)

    def acknowledge_alert(self, alert_id):
        return self._operations.acknowledge(alert_id)

    @property
    def operations_summary(self):
        return self._operations.summary

    def _collect_autonomous_inspection(self, operation):
        """World boundary: deliver one imperfect synthetic camera observation.

        Controller and inference never receive the scenario's injection target.
        The returned camera result replaces previous visual evidence rather than
        multiplying repeated or expired observations into a previous posterior.
        """
        if not any(d.sensor_id == operation["sensor_id"] and d.asset_id == operation["asset_id"]
                   and d.status != "flying" for d in self.drones):
            raise ValueError("Autonomous inspection requires its assigned drone on site")
        previous_assessment = deepcopy(self.current(operation["asset_id"]))
        evidence = generate_inspection(operation["sensor_id"], operation["asset_id"],
                                       self.minute, operation["id"], scenario=self.scenario,
                                       seed=self.seed, anomaly_asset_id=self._scenario_asset)
        self.visual_evidence[operation["asset_id"]] = evidence
        self.audit.append({"type": "autonomous_inspection_received", "minute": self.minute,
                           **deepcopy(evidence)})
        self._refresh_assessments()
        self._record_inspection_comparison(operation["asset_id"], evidence, previous_assessment)
        return evidence

    def advance_to(self, minute):
        if not isinstance(minute, int) or isinstance(minute, bool) or minute < self.minute:
            raise ValueError("Target minute must be an integer at or after the current time")
        return self.step(minute - self.minute)

    def verify(self, asset_id, result="inconclusive", *, modality="rgb", visibility="clear", quality="valid"):
        """Append an explicit human-selected synthetic result, never fault truth."""
        if asset_id not in self.dataset.segments:
            raise ValueError(f"Unknown asset: {asset_id}")
        if result not in ("supports", "clear", "inconclusive"):
            raise ValueError("Visual result must be supports, clear, or inconclusive")
        spec = inspection_spec({"modality": modality, "visibility": visibility, "quality": quality})
        if spec["modality"] not in {"rgb", "thermal", "combined"}:
            raise ValueError("Inspection modality must be rgb, thermal or combined")
        if not any(d.asset_id == asset_id and d.status != "flying" for d in self.drones):
            raise ValueError("Visual review requires a stationary drone at this asset")
        previous_assessment = deepcopy(self.current(asset_id))
        evidence = {"result": result, "asset_id": asset_id, "observed_at": self.minute,
                    "observation_id": f"manual-visual:{asset_id}:{self.minute}:{result}:{modality}:{visibility}:{quality}",
                    "received_at": self.minute, "quality": quality, "modality": modality,
                    "visibility": visibility, "model": spec["model"], "synthetic": True,
                    "source": "User-selected synthetic independent visual review",
                    "note": "Synthetic asset-matched inspection conditioned on modality, visibility and quality."}
        self.visual_evidence[asset_id] = evidence
        self.audit.append({"type": "visual_review", "minute": self.minute, **evidence})
        self._refresh_assessments()
        self._record_inspection_comparison(asset_id, evidence, previous_assessment)
        return evidence

    def _flight_plan(self, drone, target_asset, speed_mps=None):
        speed_mps = DEMO_CRUISE_SPEED_MPS if speed_mps is None else speed_mps
        if isinstance(speed_mps, bool) or not isinstance(speed_mps, (int, float)) or not math.isfinite(speed_mps) or not 0 < speed_mps <= MAX_SPEED_MPS:
            raise ValueError("Flight speed must be greater than zero and at most the confirmed 60 m/s maximum")
        if self.minute >= MISSION_MINUTES:
            raise ValueError("The 240-minute mission has ended")
        if target_asset not in self.dataset.segments:
            raise ValueError("Target must be a mapped asset")
        if target_asset == "LINE_024":
            raise ValueError("LINE_024 is officially de-energized and cannot be assumed to charge")
        if target_asset not in self.charging_sites:
            raise ValueError("Charging power is unknown at this target; choose an explicit demo charging site")
        if not self._charging_permitted(target_asset):
            raise ValueError("Target charging requires an explicit energized operating record")
        if drone.status == "flying":
            raise ValueError("Drone is already flying")
        if drone.needs_charge or drone.status == "charging":
            raise ValueError("A full 180-minute recharge must finish before another flight")
        if target_asset == drone.asset_id:
            raise ValueError("Drone is already at this asset")
        if any(d.sensor_id != drone.sensor_id and (
                (d.status != "flying" and d.asset_id == target_asset) or
                (d.status == "flying" and d.target_asset == target_asset)) for d in self.drones):
            raise ValueError("Target is occupied or reserved by another drone")
        gust = self.weather.get("gust_mps")
        if gust is None or not math.isfinite(gust) or gust >= DEMO_MAX_GUST_MPS:
            raise ValueError("Current gust is outside the assumed demo flight envelope (<18 m/s)")
        distance = haversine_km(self.dataset.segments[drone.asset_id]["position"],
                                self.dataset.segments[target_asset]["position"])
        flight = max(1, math.ceil(distance / (speed_mps * .06)))
        if flight > MAX_FLIGHT_MINUTES:
            raise ValueError("Flight exceeds the 30-minute limit at the selected speed")
        if self.minute + flight > MISSION_MINUTES:
            raise ValueError("Insufficient mission time to arrive and observe")
        forecast_window = self._forecast_risk_window()
        if forecast_window and self.minute < forecast_window[1] and self.minute + flight > forecast_window[0]:
            raise ValueError("Flight overlaps the received forecast high-gust window; pre-position earlier or defer and review")
        return {"origin_asset": drone.asset_id, "target_asset": target_asset,
                "departure_at": self.minute, "arrival_at": self.minute + flight,
                "flight_minutes": flight, "distance_km": distance,
                "flight_speed_mps": float(speed_mps),
                "transit_quality": "low" if speed_mps >= MAX_SPEED_MPS else "limited" if speed_mps >= 40 else "transit only",
                "measurement_policy": "Collect asset evidence only while stationary; flight motion and high-speed samples are excluded"}

    def _forecast_risk_window(self):
        """A planning constraint from a received forecast, never future truth.

        Peak timing can refine the forecast validity interval. Missing timing
        conservatively uses the whole supplied validity period. Warnings alone
        never establish a numerical no-flight interval.
        """
        forecast = self.weather.get("forecast") or {}
        try:
            issued = float(forecast["issued_at"])
            received = float(forecast["received_at"])
            gust = float(forecast["gust_mps"])
            valid_from = float(forecast["valid_from"])
            valid_to = float(forecast["valid_to"])
            start = max(valid_from, float(forecast.get("peak_from", valid_from)))
            finish = min(valid_to, float(forecast.get("peak_to", valid_to)))
        except (KeyError, TypeError, ValueError, OverflowError):
            return None
        if not all(math.isfinite(value) for value in (issued, received, gust, start, finish)):
            return None
        if issued > self.minute or received > self.minute or gust < DEMO_MAX_GUST_MPS:
            return None
        if finish <= self.minute or finish <= start:
            return None
        return (start, finish)

    @property
    def weather_decision(self):
        window = self._forecast_risk_window()
        gust = self.weather.get("gust_mps")
        gust_known = isinstance(gust, (int, float)) and math.isfinite(gust)
        if not gust_known or gust >= DEMO_MAX_GUST_MPS:
            status = "defer"
            reason = "Current gust is unknown or exceeds the assumed flight envelope; retain stationary observations and reassess."
        elif window and window[0] <= self.minute:
            status = "defer"
            reason = f"Received forecast predicts gusts above the demo envelope through T+{window[1]:g}; defer relocation and review new observations."
        elif window:
            status = "preposition"
            reason = f"Pre-position before T+{window[0]:g} only if the entire flight finishes before the forecast high-gust window."
        else:
            status = "routine"
            reason = "Routine coverage planning within current observed gust limits; forecast and charging constraints are checked for every flight."
        return {"status": status, "reason": reason,
                "forecast_high_gust_window": list(window) if window else None,
                "flight_gust_limit_mps": DEMO_MAX_GUST_MPS,
                "source": "Received numerical forecast and current weather; assumed demo operating envelope",
                "synthetic": True}

    def available_targets(self, sensor_id):
        drone = self._drone(sensor_id)
        available = []
        for asset_id in sorted(self.charging_sites):
            try:
                self._flight_plan(drone, asset_id)
            except ValueError:
                continue
            available.append(asset_id)
        return available

    def relocate(self, sensor_id, target_asset, speed_mps=None):
        drone = self._drone(sensor_id)
        plan = self._flight_plan(drone, target_asset, speed_mps=speed_mps)
        drone.origin_asset = plan["origin_asset"]
        drone.target_asset = target_asset
        drone.departure_at = self.minute
        drone.arrival_at = plan["arrival_at"]
        drone.status = "flying"
        drone.needs_charge = True
        drone.charge_started_at = None
        drone.charge_ready_at = None
        drone.flight_count += 1
        drone.speed_mps = plan["flight_speed_mps"]
        drone.transit_quality = plan["transit_quality"]
        self.visual_evidence.pop(drone.origin_asset, None)
        self.visual_evidence.pop(target_asset, None)
        self.audit.append({"type": "relocation", "minute": self.minute,
                           "sensor_id": sensor_id, **plan, "synthetic": True,
                           "note": "Explicit demo charging destination; forecast uncertainty remains."})
        self._refresh_assessments()
        return plan

    def position(self, drone):
        if isinstance(drone, str):
            drone = self._drone(drone)
        if drone.status != "flying":
            return self.dataset.segments[drone.asset_id]["position"]
        origin = self.dataset.segments[drone.origin_asset]["position"]
        target = self.dataset.segments[drone.target_asset]["position"]
        fraction = (self.minute - drone.departure_at) / (drone.arrival_at - drone.departure_at)
        fraction = min(1.0, max(0.0, fraction))
        return tuple(a + fraction * (b - a) for a, b in zip(origin, target))

    def export(self):
        baseline = {"version": getattr(self.baseline, "version", "synthetic-healthy-frozen"),
                    "provenance": getattr(self.baseline, "provenance", "Independent healthy synthetic training data"),
                    "frozen_during_replay": True}
        if is_dataclass(self.baseline):
            baseline.update(asdict(self.baseline))
        if hasattr(self.baseline, "metadata"):
            baseline["metadata"] = self.baseline.metadata
        return _json_safe({
            "title": "GridScout synthetic state twin",
            "synthetic": True, "minute": self.minute, "scenario": self.scenario, "seed": self.seed,
            "baseline": baseline, "weather": deepcopy(self.weather),
            "weather_decision": self.weather_decision,
            "autonomous": self.autonomous, "operations_summary": self.operations_summary,
            "operations": deepcopy(self.operations), "human_alerts": deepcopy(self.human_alerts),
            "replans": deepcopy(self.replans), "inspection_requests": deepcopy(self.inspection_requests),
            "weather_history": deepcopy(self.weather_history), "readings": deepcopy(self.history),
            "visual_evidence": deepcopy(self.visual_evidence), "drones": self.drones,
            "operating_records": deepcopy(self.operating_records), "bn_structure": model_structure(),
            "assessment_history": deepcopy(self.assessment_history),
            "inspection_history": deepcopy(self.inspection_history),
            "inference_mode": {"mode": "current_window", "temporal_recursion": False,
                               "history": "Current-window posterior snapshots, observation gaps and same-window inspection comparisons"},
            "assessments": deepcopy(self.assessments), "recommendations": deepcopy(self.recommendations),
            "audit": deepcopy(self.audit), "charging_sites": sorted(self.charging_sites),
            "assumptions": {
                "mission_minutes": MISSION_MINUTES, "charge_minutes": CHARGE_MINUTES,
                "max_flight_minutes": MAX_FLIGHT_MINUTES,
                "flight_speed_km_per_minute": DEMO_SPEED_KM_PER_MINUTE,
                "max_speed_mps": MAX_SPEED_MPS, "default_cruise_speed_mps": DEMO_CRUISE_SPEED_MPS,
                "flight_speeds": "User-confirmed maximum60m/s; assumed cruise20/high40/critical60m/s. At maximum speed quality is poor; asset diagnosis uses stationary evidence.",
                "flight_gust_limit_mps_exclusive": DEMO_MAX_GUST_MPS,
                "stale_after_minutes": STALE_AFTER_MINUTES,
                "visual_evidence_ttl_minutes": VISUAL_TTL_MINUTES,
                "charging": "Charging requires a listed site with explicitly stated energization and sufficient power.",
                "baseline": "Healthy synthetic history; fault likelihoods and costs are illustrative, uncalibrated assumptions",
                "load": "Load: unknown; represented through temperature uncertainty.",
                "geometry": "Official mapped geometry; electrical connectivity and customer supply unknown",
                "hardware": "Payload budget: 3.8 kg base + at most 250 g total added payload.",
                "inspection": "Synthetic imagery: hand-specified modality/quality/visibility table shared by inference, preview and EVSI. RGB: mechanical .85, thermal-only .08 (same as healthy); thermal: thermal .90; combined: noisy-OR; healthy FP .08; default usable-view probability .88. Synthetic demonstration assumptions.",
                "operating_state": "E is clamped by stated operating records or marginalized over on/off conditional baselines when unknown. Charging eligibility uses explicit site records.",
                "autonomous": "Synthetic dispatch only. Dynamic greedy task priorities use received reports, current BN evidence, information value, travel, origin coverage and charging constraints. Repairs and switching require human execution",
            },
        })
