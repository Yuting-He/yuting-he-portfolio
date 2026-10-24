"""Received-evidence mission controller with a bounded human handoff.

Scheduling is an explicit report-priority/flight-time heuristic, not a claimed
globally optimal routing solver. Persistence is a temporal gate, never repeated
independent Bayesian evidence. No scenario, injection selector, or hidden world
state is accessed here.
"""
from __future__ import annotations

from copy import deepcopy
import math

from .official_data import haversine_km

INSPECTION_MINUTES = 4
PERSISTENCE_WINDOWS = 3
UNCERTAINTY_DEADLINE = 10
TELEMETRY_DEADLINE = 5
INITIAL_COVERAGE_FLIGHTS = 2
COVERAGE_REVIEW_MINUTES = 30
RECHECK_COOLDOWN = 20
MAX_EPISODE_CHECKS = 2
CLEAR_WINDOWS = 5
TERMINAL = {"completed", "cancelled", "superseded"}


class AutonomousOperations:
    def __init__(self, simulation):
        self.sim = simulation
        self.operations = []
        self.alerts = []
        self._planned = False
        self._signals = {}
        self.replans = []
        self._signature = None
        self._last_coverage_review = 0
        self._last_visit = {}
        self._requests_seen = {}
        self._processed_events = set()
        self._request_versions = {}
        self._pending_decisions = []
        self._episode_counts = {}
        self._alert_by_key = {}

    def _audit(self, event, **details):
        self.sim.audit.append({"type": event, "minute": self.sim.minute,
                               "synthetic": True, **deepcopy(details)})

    def _new_operation(self, kind, asset, drone, reason, priority, deadline):
        operation = {"id": f"op-{len(self.operations) + 1:03d}", "kind": kind,
                     "asset_id": asset, "sensor_id": drone.sensor_id if drone else None,
                     "origin_asset": drone.asset_id if drone else None, "target_asset": asset,
                     "status": "queued", "reason": reason, "selection_reason": reason,
                     "priority": priority, "created_at": self.sim.minute,
                     "updated_at": self.sim.minute, "started_at": None,
                     "arrival_at": None, "inspection_started_at": None,
                     "inspection_due_at": None, "completed_at": None,
                     "deadline_at": deadline, "result": None, "outcome": None,
                     "progress": 0.0, "eta_minutes": None, "stages": [],
                     "synthetic": True, "incident_id": f"incident:{asset}" if kind == "anomaly_check" else None,
                     "inspection_capability": "Assumed optional imagery emulator",
                     "posterior_before": None, "posterior_after": None,
                     "human_alert_id": None, "decision_explanation": {},
                     "finding": "Awaiting inspection evidence", "next_action": "Await constrained assignment",
                     "human_required": False, "request_id": None}
        self.operations.append(operation)
        self._stage(operation, "queued", reason)
        return operation

    def _stage(self, operation, status, reason):
        changed = operation["status"] != status or not operation["stages"]
        operation.update(status=status, reason=reason, updated_at=self.sim.minute)
        if changed:
            operation["stages"].append({"status": status, "minute": self.sim.minute, "reason": reason})
            self._audit("operation_stage", operation_id=operation["id"], asset_id=operation["asset_id"],
                        sensor_id=operation["sensor_id"], status=status, reason=reason)
            if status in {"cancelled", "superseded"}:
                self._pending_decisions.append({"operation_id": operation["id"], "asset_id": operation["asset_id"],
                    "previous_sensor_id": operation["sensor_id"], "sensor_id": operation["sensor_id"],
                    "action": status, "reason": reason})

    def _alert(self, asset, category, severity, title, reason, action, operation=None):
        key = (asset, category)
        alert = self._alert_by_key.get(key)
        if alert is None:
            alert = {"id": f"alert-{len(self.alerts) + 1:03d}", "asset_id": asset,
                     "category": category, "severity": severity, "status": "open",
                     "title": title, "reason": reason, "action": action,
                     "created_at": self.sim.minute, "updated_at": self.sim.minute,
                     "acknowledged_at": None, "operation_id": operation["id"] if operation else None,
                     "acknowledgment_history": [],
                     "synthetic": True, "resolution": "Requires human review and follow-up"}
            self.alerts.append(alert)
            self._alert_by_key[key] = alert
            self._audit("human_alert_opened", **alert)
        else:
            # Stable acknowledged alerts remain visible and unresolved. A new
            # severity increase reopens the same incident rather than hiding it.
            severity_rank = {"warning": 1, "high": 2, "critical": 3}
            if severity_rank.get(severity, 0) > severity_rank.get(alert["severity"], 0):
                alert.update(status="open", acknowledged_at=None, severity=severity, title=title)
                self._audit("human_alert_escalated", alert_id=alert["id"], asset_id=asset,
                            severity=severity, note="Material deterioration requires renewed acknowledgment")
            alert.update(updated_at=self.sim.minute, reason=reason, action=action)
            if severity == "critical":
                alert.update(severity=severity, title=title)
            if operation:
                alert["operation_id"] = operation["id"]
        if operation:
            operation["human_alert_id"] = alert["id"]
            operation["human_required"] = True
        return alert

    def acknowledge(self, alert_id):
        alert = next((a for a in self.alerts if a["id"] == alert_id), None)
        if alert is None:
            raise ValueError(f"Unknown human alert: {alert_id}")
        if alert["status"] != "acknowledged":
            alert.update(status="acknowledged", acknowledged_at=self.sim.minute)
            alert["acknowledgment_history"].append({"minute": self.sim.minute, "severity": alert["severity"]})
            self._audit("human_alert_acknowledged", alert_id=alert_id, asset_id=alert["asset_id"],
                        note="Operator acknowledged receipt; human follow-up remains outstanding")
        return deepcopy(alert)

    def _initial_plan(self):
        """Retain highest-report sentinels; inspect up to two unobserved sites."""
        self._planned = True
        ranked = sorted(self.sim.drones, key=lambda d: (
            -self.sim.dataset.segments[d.asset_id]["report_log_odds"], d.sensor_id))
        protected = {d.sensor_id for d in ranked[:2]}
        occupied = {d.target_asset if d.status == "flying" else d.asset_id for d in self.sim.drones}
        candidates = [asset for asset in self.sim.charging_sites if asset not in occupied
                      and self.sim.dataset.segments[asset]["report_log_odds"] > 0]
        available = [d for d in self.sim.drones if d.sensor_id not in protected and d.status != "flying"]
        for _ in range(INITIAL_COVERAGE_FLIGHTS):
            pairs = []
            for drone in available:
                # An existing anomaly/uncertainty at the origin is not abandoned.
                if self.sim.current(drone.asset_id)["status"] != "Normal":
                    continue
                for asset in candidates:
                    duration = max(1, math.ceil(haversine_km(
                        self.sim.dataset.segments[drone.asset_id]["position"],
                        self.sim.dataset.segments[asset]["position"]) / 1.2))
                    if duration > 30 or self.sim.minute + duration + INSPECTION_MINUTES >= 240:
                        continue
                    try:
                        self.sim._flight_plan(drone, asset)
                        feasible = True
                    except ValueError:
                        feasible = False
                    weight = self.sim.dataset.segments[asset]["report_log_odds"]
                    # Current feasibility first, then report relevance minus travel.
                    pairs.append((not feasible, -(weight - .01 * duration), duration,
                                  asset, drone.sensor_id, drone))
            if not pairs:
                break
            _, _, duration, asset, _, drone = min(pairs, key=lambda item: item[:5])
            reports = self.sim.dataset.segments[asset]["report_ids"]
            reason = (f"Public reports {', '.join(reports)} overlap this unobserved site. "
                      f"{drone.sensor_id} is a nearby eligible unit ({duration} min assumed flight). "
                      "Retain the two highest-report sites; origin coverage becomes Unknown. "
                      "Report/flight-time scheduling heuristic; explicit charging site.")
            self._new_operation("report_check", asset, drone, reason, "routine", min(235, self.sim.minute + 65))
            available.remove(drone)
            candidates.remove(asset)
        for drone in ranked[:2]:
            if drone.status != "flying" and self.sim.dataset.segments[drone.asset_id]["report_log_odds"] > 0:
                self._new_operation("report_check", drone.asset_id, drone,
                                    "Verify overlapping public reports with the drone already on site while retaining coverage.",
                                    "routine", min(235, self.sim.minute + 15))

    def _active_for(self, asset):
        return next((o for o in reversed(self.operations) if o["asset_id"] == asset and o["status"] not in TERMINAL), None)

    def _signals_and_incidents(self, dispatch):
        for drone in self.sim.drones:
            if drone.status == "flying":
                continue
            asset = drone.asset_id
            assessment = self.sim.current(asset)
            reading = self.sim.latest.get(asset, {})
            observation_id = reading.get("observation_id")
            signal = self._signals.setdefault(asset, {"last": None, "count": 0, "since": None,
                "missing_since": None, "sensor_since": None, "clear_count": 0, "episode": 0,
                "episode_open": False, "checks": 0, "last_check": None})
            top = self.sim.recommendations[asset][0]["action"]
            suspicious = assessment["status"] in {"Investigate", "Anomaly"} or top == "remote_review"
            fresh = observation_id != signal["last"]
            if fresh:
                signal["last"] = observation_id
                signal["count"] = signal["count"] + 1 if suspicious else 0
                signal["since"] = (signal["since"] if signal["since"] is not None else self.sim.minute) if suspicious else None
                # Missing or stale coverage can never clear an incident.
                healthy = assessment["status"] == "Normal" and top == "monitor"
                signal["clear_count"] = signal["clear_count"] + 1 if healthy else 0
                if signal["clear_count"] >= CLEAR_WINDOWS and signal["episode_open"]:
                    signal.update(episode_open=False, checks=0)
                    self._audit("anomaly_episode_cleared", asset_id=asset, episode=signal["episode"],
                                note="Five distinct fresh normal windows; previous human alerts remain unresolved until reviewed.")
                    operation = self._active_for(asset)
                    if operation and operation["kind"] == "anomaly_check" and operation["status"] in {"queued", "deferred"}:
                        self._stage(operation, "cancelled", "Fresh received evidence cleared across five windows before dispatch; retain monitoring.")
            missing = assessment["status"] == "Unknown"
            signal["missing_since"] = (self.sim.minute if signal["missing_since"] is None else signal["missing_since"]) if missing else None
            sensor_issue = assessment["status"] == "Sensor issue" or top == "inspect_sensor"
            signal["sensor_since"] = (self.sim.minute if signal["sensor_since"] is None else signal["sensor_since"]) if sensor_issue and not missing else None
            operation = self._active_for(asset)
            if assessment.get("urgent"):
                self._alert(asset, "asset", "critical", "Immediate operator assessment required",
                    assessment.get("urgent_basis") or "Severe received observation exceeded the synthetic urgency limit.",
                    "Assess safety immediately and decide field response; do not wait for autonomous inspection.", operation)
            if missing and self.sim.minute - signal["missing_since"] >= TELEMETRY_DEADLINE:
                self._alert(asset, "telemetry", "warning", "Telemetry unavailable — coverage unresolved",
                    f"{drone.sensor_id} has no usable asset stream for at least {TELEMETRY_DEADLINE} minutes; health remains Unknown.",
                    "Check communications and drone status; arrange a safe alternative observation if the link cannot be restored.", operation)
            if signal["sensor_since"] is not None and self.sim.minute - signal["sensor_since"] >= TELEMETRY_DEADLINE:
                self._alert(asset, "sensor", "warning", "Sensor / installation check needed",
                    "Received evidence remains consistent with sensor or mounting trouble; sensor calibration requires a separate check.",
                    "Review mounting, calibration and device diagnostics; retain asset uncertainty until verified.", operation)
            if signal["count"] < PERSISTENCE_WINDOWS:
                continue
            if dispatch and not signal["episode_open"]:
                signal.update(episode_open=True, episode=signal["episode"] + 1, checks=0, last_check=None)
                self._audit("anomaly_episode_opened", asset_id=asset, episode=signal["episode"])
            if dispatch and signal["episode_open"] and operation is None:
                cooldown_over = signal["last_check"] is None or self.sim.minute - signal["last_check"] >= RECHECK_COOLDOWN
                # A field-action decision is handed off immediately and doesn't need repeated camera work.
                confirmed = any(o["asset_id"] == asset and o.get("incident_id") == f"incident:{asset}:{signal['episode']}"
                                and o["status"] == "completed" and o.get("human_required") for o in self.operations)
                needs_view = signal["checks"] == 0 or (signal["checks"] < MAX_EPISODE_CHECKS and not confirmed and top not in {"field_check", "urgent_review"})
                if cooldown_over and needs_view:
                    operation = self._new_operation("anomaly_check", asset, drone,
                        "Anomalous evidence persists across three distinct windows. Persistence triggers an inspection; BN inference uses the current window and one eligible local view.",
                        "high", self.sim.minute + UNCERTAINTY_DEADLINE)
                    operation["incident_id"] = f"incident:{asset}:{signal['episode']}"
                    signal["checks"] += 1
            elif dispatch and operation and operation["kind"] != "anomaly_check":
                operation.update(kind="anomaly_check", priority="high", incident_id=f"incident:{asset}:{signal['episode']}",
                    deadline_at=min(operation["deadline_at"], self.sim.minute + UNCERTAINTY_DEADLINE))
                if not operation.get("episode_counted"):
                    signal["checks"] += 1
                    operation["episode_counted"] = True
            if assessment.get("urgent"):
                continue
            if top == "field_check":
                self._alert(asset, "asset", "high", "Field inspection requested",
                    "Persistent residuals make field inspection the current lowest expected-loss action. Field review and automatic evidence collection proceed together.",
                    "Operator: review the evidence and arrange a field inspection; determine whether any repair is required.", operation)
            elif signal["since"] is not None and self.sim.minute - signal["since"] >= UNCERTAINTY_DEADLINE:
                self._alert(asset, "asset", "warning", "Persistent ambiguity needs operator review",
                    "The automatic evidence-collection window ended with unexplained residuals; operator review is required.",
                    "Review alternative causes and choose a targeted field or operations check.", operation)

    def _consume_requests(self):
        for request in self.sim.inspection_requests:
            identifier = request["request_id"]
            version = request["event_id"]
            if request["received_at"] > self.sim.minute or version in self._processed_events:
                continue
            self._processed_events.add(version)
            version_order = (request["issued_at"], request["msg_type"] == "Cancel", request["received_at"])
            if version_order < self._request_versions.get(identifier, (-1, -1, False)):
                continue
            self._request_versions[identifier] = version_order
            self._requests_seen[identifier] = version
            existing = next((o for o in reversed(self.operations) if o.get("request_id") == identifier and o["status"] not in TERMINAL), None)
            cancelled = request.get("msg_type") == "Cancel" or (request.get("expires_at") is not None and request["expires_at"] <= self.sim.minute)
            if existing and existing["status"] in {"flying", "inspecting"}:
                existing["request_update"] = deepcopy(request)
                existing["next_action"] = "Finish committed leg safely; reassess the received request revision on arrival."
                if cancelled or existing["asset_id"] != request["asset_id"]:
                    existing["withdrawn_while_committed"] = True
                if not cancelled and existing["asset_id"] != request["asset_id"]:
                    # Keep the committed leg, but create a separate successor task
                    # for the publicly revised location in this same receive pass.
                    existing = None
                else:
                    continue
            if existing and (cancelled or existing["asset_id"] != request["asset_id"]):
                self._stage(existing, "cancelled" if cancelled else "superseded",
                            "Received request cancellation." if cancelled else "Received request update moved the inspection location.")
                existing = None
            if cancelled:
                continue
            if existing:
                existing.update(priority=request["priority"], selection_reason=request["reason"],
                                deadline_at=request.get("deadline_at", existing["deadline_at"]))
                continue
            operation = self._active_for(request["asset_id"])
            if operation is None:
                operation = self._new_operation("report_check", request["asset_id"], None,
                    request["reason"], request["priority"], request.get("deadline_at", min(239, self.sim.minute + 35)))
            operation.update(request_id=identifier, request_source=request["source"],
                             related_asset_id=request.get("related_asset_id"), report_group=request.get("report_group"),
                             hold_for_inspection_asset=request.get("hold_for_inspection_asset"),
                             expires_at=request.get("expires_at"))

    def _priority(self, operation):
        assessment = self.sim.current(operation["asset_id"])
        action = self.sim.recommendations[operation["asset_id"]][0]
        risk = assessment.get("anomaly") or 0
        base = {"routine": 20, "high": 70, "critical": 120}.get(operation["priority"], 20)
        remote = next((a for a in self.sim.recommendations[operation["asset_id"]] if a["action"] == "remote_review"), {})
        information = max(0, remote.get("net_value", 0))
        age = min(20, max(0, self.sim.minute - operation["created_at"]) * .3)
        related = operation.get("related_asset_id")
        related_ops = [o for o in self.operations if o["asset_id"] == related and o["status"] == "completed"]
        corroboration = 0
        if related_ops:
            latest = related_ops[-1]
            if self.sim.minute - latest["completed_at"] <= 20:
                corroboration = 15 if latest["result"] == "supports" else -8 if latest["result"] == "clear" else 0
        score = base + 40*risk + min(15, information) + age + corroboration
        if assessment.get("urgent"):
            score += 100
        return score, {"request_priority": base, "current_bn_risk": round(40*risk, 2),
            "value_of_information": round(min(15, information), 2), "waiting_age": round(age, 2),
            "related_inspection": corroboration, "bn_action": action["action"]}

    def _candidates(self, operation):
        asset = operation["asset_id"]
        ranked = sorted(self.sim.drones, key=lambda d: (-self.sim.dataset.segments[d.asset_id]["report_log_odds"], d.sensor_id))
        sentinel_ids = {d.sensor_id for d in ranked[:2]}
        rows = []
        preferred = {"routine": 20.0, "high": 40.0, "critical": 60.0}.get(operation["priority"], 20.0)
        dependency = operation.get("hold_for_inspection_asset")
        dependency_view = next((o for o in reversed(self.operations) if o["asset_id"] == dependency and o["status"] == "completed"), None)
        waiting_for_view = dependency and (dependency_view is None or self.sim.minute - dependency_view["completed_at"] > 20)
        for drone in self.sim.drones:
            local = drone.status != "flying" and drone.asset_id == asset
            busy = next((o for o in self.operations if o is not operation and o["sensor_id"] == drone.sensor_id and o["status"] in {"flying", "inspecting"}), None)
            coverage = 0 if local else (25 if drone.sensor_id in sentinel_ids else 0) + max(0, self.sim.dataset.segments[drone.asset_id]["report_log_odds"]) * 2
            distance = haversine_km(self.sim.dataset.segments[drone.asset_id]["position"], self.sim.dataset.segments[asset]["position"])
            minutes = 0 if local else max(1, math.ceil(distance / (preferred*.06)))
            reason = "On site; retain coverage and inspect while stationary, including during recharge." if local else "Eligible within weather, route, charging and mission constraints."
            eligible = True
            speed = preferred
            if waiting_for_view:
                eligible, reason = False, f"Received request requires the inspection result at {dependency} before dispatch; bounded review deadline still applies."
            elif busy:
                eligible, reason = False, f"Committed to {busy['id']} ({busy['status']}); finish the current operation first."
            elif not local:
                origin = self.sim.current(drone.asset_id)
                pending_origin = self._active_for(drone.asset_id)
                if pending_origin and pending_origin is not operation and pending_origin["kind"] == "anomaly_check":
                    eligible, reason = False, f"Retain origin coverage until unresolved inspection {pending_origin['id']} is checked or clears across five fresh windows."
                elif origin["status"] != "Normal":
                    eligible, reason = False, f"Retain origin coverage until a fresh normal assessment: {origin['status']}."
                else:
                    last_error = None
                    for speed in sorted({preferred, 40.0, 60.0}):
                        if speed < preferred:
                            continue
                        try:
                            plan = self.sim._flight_plan(drone, asset, speed_mps=speed)
                            if plan["arrival_at"] + INSPECTION_MINUTES > 240:
                                raise ValueError("Insufficient mission time to arrive and finish inspection")
                        except ValueError as error:
                            last_error = str(error)
                        else:
                            minutes = plan["flight_minutes"]
                            last_error = None
                            if speed > preferred:
                                reason = f"Use {speed:g} m/s to finish within the received flight window; inspect after landing."
                            break
                    if last_error:
                        eligible, reason = False, last_error
            ready = drone.charge_ready_at if drone.needs_charge else self.sim.minute
            if drone.status == "flying":
                ready = (drone.arrival_at or self.sim.minute) + 180
            flight_ready = ready
            if local and not busy:
                ready = self.sim.minute
            score = minutes + coverage + (speed-20)*.08 - (3 if local else 0)
            rows.append({"sensor_id": drone.sensor_id, "eligible": eligible, "flight_minutes": minutes,
                "flight_speed_mps": 0 if local else speed, "ready_at": ready, "eta_at": self.sim.minute + minutes if eligible else None,
                "flight_ready_at": flight_ready,
                "score": round(score, 3), "reason": reason, "origin_asset": drone.asset_id,
                "coverage_penalty": round(coverage, 2), "observation_need": "Four-minute stationary imagery plus four-channel telemetry; transit motion excluded"})
        return rows

    def _replan(self, trigger):
        decisions = self._pending_decisions[:]
        self._pending_decisions.clear()
        pending = [o for o in self.operations if o["status"] in {"queued", "deferred"}]
        pending.sort(key=lambda o: (-self._priority(o)[0], o["created_at"], o["id"]))
        assigned = set()
        for operation in pending:
            if operation.get("expires_at") is not None and self.sim.minute >= operation["expires_at"]:
                self._stage(operation, "cancelled", "Received request expired before dispatch; coverage remains unresolved.")
                decisions.append({"operation_id": operation["id"], "asset_id": operation["asset_id"], "action": "cancelled", "reason": operation["reason"]})
                continue
            rows = self._candidates(operation)
            for row in rows:
                if row["sensor_id"] in assigned and row["eligible"]:
                    row.update(eligible=False, reason="Allocated to a higher-priority pending inspection in this replan.")
            eligible = sorted((r for r in rows if r["eligible"]), key=lambda r: (r["score"], r["sensor_id"]))
            selected = eligible[0] if eligible else min(rows, key=lambda r: (r["ready_at"] or 999, r["score"], r["sensor_id"]))
            previous = operation["sensor_id"]
            prior_assignment = operation.get("_assignment_signature")
            drone = self.sim._drone(selected["sensor_id"])
            priority, components = self._priority(operation)
            why_location = f"{operation['selection_reason']} Current BN action: {components['bn_action']}; task priority {priority:.1f} combines received urgency, current evidence, information value and waiting time."
            why_drone = (f"{drone.sensor_id}: {selected['reason']} Assumed travel {selected['flight_minutes']} min; origin coverage penalty {selected['coverage_penalty']:.1f}."
                         if eligible else f"No drone can launch now. {drone.sensor_id} retained as a provisional assignment: {selected['reason']}")
            operation.update(sensor_id=drone.sensor_id, origin_asset=drone.asset_id,
                dispatch_speed_mps=selected["flight_speed_mps"], priority_score=round(priority, 2),
                assignment_eligible=bool(eligible),
                decision_explanation={"why_location": why_location, "why_drone": why_drone,
                    "candidates": rows, "alternatives": [r for r in rows if r["sensor_id"] != drone.sensor_id],
                    "trigger": trigger, "chosen_at": self.sim.minute, "score_components": components},
                next_action="Inspect on site" if selected["flight_minutes"] == 0 else "Dispatch when constraints allow")
            if eligible:
                assigned.add(drone.sensor_id)
                if operation["status"] == "deferred":
                    self._stage(operation, "queued", "Replan found a currently feasible drone after constraint/evidence change.")
            else:
                self._stage(operation, "deferred", selected["reason"])
            assignment = (drone.sensor_id, bool(eligible), selected["reason"], components["related_inspection"],
                          components["bn_action"], operation["selection_reason"])
            operation["_assignment_signature"] = assignment
            if assignment != prior_assignment:
                decisions.append({"operation_id": operation["id"], "asset_id": operation["asset_id"],
                    "previous_sensor_id": previous, "sensor_id": drone.sensor_id,
                    "action": "reassigned" if previous and previous != drone.sensor_id else "assigned" if eligible else "deferred",
                    "reason": why_drone})
        # A completed inspection is itself a concrete policy update even when
        # every drone is busy and no queued assignment changes.
        for operation in self.operations:
            if operation["status"] == "completed" and not operation.get("result_planned"):
                operation["result_planned"] = True
                decisions.append({"operation_id": operation["id"], "asset_id": operation["asset_id"],
                    "previous_sensor_id": operation["sensor_id"], "sensor_id": operation["sensor_id"],
                    "action": "result reviewed", "reason": operation["finding"]})
        if not decisions:
            return
        record = {"id": f"plan-{len(self.replans)+1:03d}", "minute": self.sim.minute, "trigger": trigger,
            "summary": f"Reviewed {len(pending)} pending tasks against all five drones; committed flights and inspections retained.", "decisions": decisions,
            "policy": "Greedy priority informed by expected loss, travel and origin coverage", "synthetic": True}
        self.replans.append(record)
        self._audit("mission_replanned", **record)

    def _state_signature(self):
        return (tuple((d.sensor_id, d.status, d.asset_id, d.target_asset, d.needs_charge) for d in self.sim.drones),
            tuple((asset, a["status"], self.sim.recommendations[asset][0]["action"],
                   None if a.get("anomaly") is None else int(a["anomaly"]*4))
                  for asset, a in sorted(self.sim.assessments.items()) if asset in self.sim.latest),
            self.sim.weather_decision["status"], tuple(self.sim.weather_decision.get("forecast_high_gust_window") or []),
            tuple((o["id"], o["status"], o.get("result")) for o in self.operations),
            tuple(sorted(self._requests_seen.items())))

    def _coverage_review(self):
        if self.sim.minute - self._last_coverage_review < COVERAGE_REVIEW_MINUTES or self.sim.minute > 215:
            return
        self._last_coverage_review = self.sim.minute
        # One bounded new revisit per review, chosen from explicit charging sites.
        # A previously observed site may need a fresh view; stale readings stay Unknown.
        candidates = []
        for asset in self.sim.charging_sites:
            if self._active_for(asset) or any(d.status != "flying" and d.asset_id == asset for d in self.sim.drones):
                continue
            if self.sim.dataset.segments[asset]["report_log_odds"] <= 0:
                continue
            last = self._last_visit.get(asset, -100)
            if self.sim.minute - last < 60:
                continue
            probe = {"asset_id": asset, "priority": "routine", "sensor_id": None}
            rows = self._candidates(probe)
            if any(r["eligible"] for r in rows):
                candidates.append((self.sim.dataset.segments[asset]["report_log_odds"], self.sim.minute-last, asset))
        if candidates:
            _, _, asset = max(candidates)
            self._new_operation("report_check", asset, None,
                "Periodic coverage review: collect a fresh stationary view at a report-linked site.",
                "routine", min(239, self.sim.minute+35))
            self._last_visit[asset] = self.sim.minute

    def _start_inspection(self, operation, drone):
        if self.sim.minute + INSPECTION_MINUTES > 240:
            self._stage(operation, "deferred", "Insufficient mission time to complete the assumed four-minute inspection.")
            return
        operation.update(inspection_started_at=self.sim.minute,
                         inspection_due_at=self.sim.minute + INSPECTION_MINUTES,
                         posterior_at_start=self.sim.current(operation["asset_id"])["anomaly"])
        if operation["started_at"] is None:
            operation["started_at"] = self.sim.minute
        self._stage(operation, "inspecting", "Stationary synthetic imagery collection and analysis in progress; charging can continue.")

    def _finish_inspection(self, operation):
        # Compare before/after against the same received telemetry window.
        operation["posterior_before"] = self.sim.current(operation["asset_id"])["anomaly"]
        observation = self.sim._collect_autonomous_inspection(operation)
        assessment = self.sim.current(operation["asset_id"])
        operation.update(result=observation["result"], observation_id=observation["observation_id"],
                         posterior_after=assessment["anomaly"], completed_at=self.sim.minute, progress=1.0,
                         eta_minutes=0, outcome=("Human action required" if assessment.get("urgent") or self.sim.recommendations[operation["asset_id"]][0]["action"] == "field_check"
                                                else "Continue monitoring; current evidence supports a normal assessment" if assessment["status"] == "Normal"
                                                else "Unresolved; bounded follow-up"))
        self._last_visit[operation["asset_id"]] = self.sim.minute
        signal = self._signals.get(operation["asset_id"])
        if signal:
            signal["last_check"] = self.sim.minute
        operation["human_required"] = bool(assessment.get("urgent") or self.sim.recommendations[operation["asset_id"]][0]["action"] == "field_check")
        operation["finding"] = (f"Received an imperfect {observation['result']} view at T+{self.sim.minute}; "
            f"current asset status {assessment['status']}. "
            + ("The observation is inconclusive; retain the sensor-based assessment." if observation["result"] == "inconclusive" else
               "The view supports abnormality within the selected modality's coverage." if observation["result"] == "supports" else
               "The view is clear within the selected modality's coverage."))
        operation["next_action"] = "Operator: review evidence and arrange field inspection; decide repair separately." if operation["human_required"] else "Replan pending work; continue monitoring and bounded follow-up if ambiguity remains."
        self._stage(operation, "completed", f"Received {observation['result']} inspection evidence; BN recalculated from current telemetry plus one view.")
        if assessment.get("urgent") or self.sim.recommendations[operation["asset_id"]][0]["action"] == "field_check":
            self._alert(operation["asset_id"], "asset", "critical" if assessment.get("urgent") else "high",
                        "Field inspection requested", "Current telemetry and inspection evidence support further operator action.",
                        "Operator: review the evidence and arrange field inspection; authorize any repair separately.", operation)

    def _progress_operations(self, dispatch):
        ordered = sorted(self.operations, key=lambda o: (o["status"] not in {"flying", "inspecting"}, -self._priority(o)[0], o["id"]))
        for operation in ordered:
            if operation["status"] in TERMINAL:
                continue
            drone = self.sim._drone(operation["sensor_id"])
            if operation["status"] == "inspecting":
                if drone.status == "flying" or drone.asset_id != operation["asset_id"]:
                    operation.update(inspection_started_at=None, inspection_due_at=None)
                    self._stage(operation, "deferred", "Assigned drone left before inspection completed; evidence not collected.")
                elif self.sim.minute >= operation["inspection_due_at"]:
                    self._finish_inspection(operation)
            elif operation["status"] == "flying":
                if drone.status != "flying" and drone.asset_id == operation["asset_id"]:
                    assessment = self.sim.current(operation["asset_id"])
                    still_needed = assessment.get("urgent") or assessment["status"] in {"Investigate", "Anomaly"} or self.sim.recommendations[operation["asset_id"]][0]["action"] in {"remote_review", "field_check", "urgent_review"}
                    if operation.get("withdrawn_while_committed") and not still_needed:
                        operation.update(completed_at=self.sim.minute, finding="Received request was withdrawn during flight; finish the committed leg, then cancel the obsolete check. The asset still requires ordinary ongoing monitoring.",
                                         next_action="Replan remaining received requests after the mandatory recharge.")
                        self._stage(operation, "cancelled", "Arrived safely; withdrawn request has no independent current anomaly requiring inspection.")
                    else:
                        self._start_inspection(operation, drone)
            elif dispatch and operation["created_at"] < self.sim.minute:
                busy = any(o is not operation and o["sensor_id"] == drone.sensor_id and o["status"] in {"flying", "inspecting"} for o in self.operations)
                if not operation.get("assignment_eligible", True):
                    pass  # Provisional assignment is explanation only, never a launch authorization.
                elif busy:
                    self._stage(operation, "deferred", "Assigned drone is completing another operation; replan pending work.")
                elif operation.get("hold_for_inspection_asset") and not any(o["asset_id"] == operation["hold_for_inspection_asset"] and o["status"] == "completed" and self.sim.minute-o["completed_at"] <= 20 for o in self.operations):
                    self._stage(operation, "deferred", "Await the inspection result required by the received follow-up request.")
                elif drone.status != "flying" and drone.asset_id == operation["asset_id"]:
                    self._start_inspection(operation, drone)
                elif drone.status == "flying":
                    self._stage(operation, "deferred", "Assigned drone is on another flight; wait for arrival.")
                elif any(o is not operation and o["sensor_id"] == drone.sensor_id and o["status"] in {"flying", "inspecting"} for o in self.operations):
                    self._stage(operation, "deferred", "Assigned drone is completing another operation.")
                elif self.sim.current(drone.asset_id)["status"] != "Normal":
                    self._stage(operation, "deferred", "Current origin evidence is not normal; retain coverage and review before moving.")
                else:
                    try:
                        plan = self.sim._flight_plan(drone, operation["asset_id"], speed_mps=operation.get("dispatch_speed_mps") or 20)
                        if plan["arrival_at"] + INSPECTION_MINUTES > 240:
                            raise ValueError("Insufficient mission time to arrive and complete inspection")
                        plan = self.sim.relocate(drone.sensor_id, operation["asset_id"], speed_mps=operation.get("dispatch_speed_mps") or 20)
                    except ValueError as error:
                        self._stage(operation, "deferred", str(error))
                    else:
                        operation.update(started_at=self.sim.minute, **plan)
                        self._stage(operation, "flying", "Constrained flight dispatched; origin coverage is Unknown until observed again.")
            if operation["status"] in TERMINAL:
                continue
            if self.sim.minute >= 240:
                self._stage(operation, "deferred", "Mission ended before this inspection could be completed.")
                self._alert(operation["asset_id"], "blocked", "warning", "Mission ended with inspection incomplete",
                            "The 240-minute mission horizon ended; the uninspected asset remains unresolved.",
                            "Hand this outstanding inspection to the operator for a follow-on mission or field check.", operation)
            elif operation["status"] != "completed" and self.sim.minute >= operation["deadline_at"]:
                self._alert(operation["asset_id"], "blocked", "warning", "Inspection delayed beyond its review deadline",
                            f"Automatic inspection remains {operation['status']}: {operation['reason']}",
                            "Review the constraint and arrange an alternative inspection for the unresolved asset.", operation)
            if operation["status"] == "flying":
                duration = operation["arrival_at"] - operation["started_at"]
                operation["progress"] = .65 * min(1, (self.sim.minute - operation["started_at"]) / max(duration, 1))
                operation["eta_minutes"] = max(0, operation["arrival_at"] - self.sim.minute) + INSPECTION_MINUTES
            elif operation["status"] == "inspecting":
                completed_flight = .65 if operation.get("flight_minutes") else 0.0
                operation["progress"] = completed_flight + (1-completed_flight) * min(1, (self.sim.minute - operation["inspection_started_at"]) / INSPECTION_MINUTES)
                operation["eta_minutes"] = max(0, operation["inspection_due_at"] - self.sim.minute)
            elif operation["status"] != "completed":
                operation["progress"] = 0.0
                operation["eta_minutes"] = None

    def tick(self, dispatch=True):
        if dispatch and not self._planned:
            self._initial_plan()
        if dispatch:
            self._consume_requests()
        self._signals_and_incidents(dispatch)
        if dispatch:
            self._coverage_review()
            signature = self._state_signature()
            if signature != self._signature:
                latest_request = self.sim.inspection_requests[-1] if self.sim.inspection_requests else None
                trigger = "Received evidence / inspection outcome / mission constraint changed"
                if any(o["status"] == "completed" and not o.get("result_planned") for o in self.operations):
                    trigger = "New inspection result: update BN and reprioritize follow-up tasks"
                elif self._signature and signature[2:4] != self._signature[2:4]:
                    trigger = "Received weather/forecast changed flight feasibility"
                elif self._signature and signature[0] != self._signature[0]:
                    trigger = "Drone arrival, departure or recharge changed availability"
                if latest_request and latest_request["received_at"] == self.sim.minute:
                    trigger = f"Received {latest_request['msg_type']} request {latest_request['request_id']}"
                self._replan(trigger)
                self._signature = self._state_signature()
        self._progress_operations(dispatch)
        # Inspection results arrive during operation progression. Refresh the
        # pending plan at this same decision time so a paused dashboard already
        # explains the received result and releases any observation dependency.
        # This second pass only plans; it must not dispatch/progress work twice.
        if dispatch and (self._pending_decisions or any(
                o["status"] == "completed" and not o.get("result_planned") for o in self.operations)):
            self._replan("New inspection result: update BN and reprioritize follow-up tasks")
            self._signature = self._state_signature()

    @property
    def summary(self):
        return {"enabled": self.sim.autonomous,
                "active": sum(o["status"] not in TERMINAL for o in self.operations),
                "completed": sum(o["status"] == "completed" for o in self.operations),
                "flying": sum(o["status"] == "flying" for o in self.operations),
                "inspecting": sum(o["status"] == "inspecting" for o in self.operations),
                "deferred": sum(o["status"] == "deferred" for o in self.operations),
                "open_alerts": sum(a["status"] == "open" for a in self.alerts),
                "acknowledged_alerts": sum(a["status"] == "acknowledged" for a in self.alerts),
                "cancelled": sum(o["status"] in {"cancelled", "superseded"} for o in self.operations),
                "replans": len(self.replans),
                "policy": "Dynamic greedy evidence/value-of-information priority with travel and origin-coverage cost; current-window BN, bounded rechecks and human handoff",
                "inspection_minutes": INSPECTION_MINUTES,
                "mode_note": "Synthetic mission commands and simulated inspection evidence"}
