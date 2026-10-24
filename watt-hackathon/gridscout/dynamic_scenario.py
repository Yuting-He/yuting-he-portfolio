"""Received public exercise reports and the separate synthetic changing world.

The report feed is an assumed operator/observer input. Reports are fallible leads,
not damage labels. The controller may consume the feed; only telemetry and camera
generators may use ``dynamic_asset_state``. No electrical connectivity is implied
by the geographic follow-up group.
"""
from __future__ import annotations

from copy import deepcopy
import math


def _validate_minute(minute):
    if not isinstance(minute, (int, float)) or not math.isfinite(minute) or minute < 0:
        raise ValueError("Exercise minute must be finite and nonnegative")


def generate_mission_requests(minute, scenario="dynamic", seed=42, initial_assets=None):
    """Return only issued AND received public lifecycle events as of this minute.

    Repeated calls intentionally return prior events too: the receiving boundary
    deduplicates by stable ``event_id``. Update/Cancel share a request ID. ``seed``
    and ``initial_assets`` are accepted for a uniform world-adapter API; these
    particular observer reports do not depend on simulator truth or random seed.
    """
    _validate_minute(minute)
    if scenario != "dynamic":
        return []
    common = {"source": "Synthetic exercise observer report", "synthetic": True,
              "observation_need": "imagery", "priority": "routine",
              "expires_at": 100.0,
              "note": "Unverified public observer lead; priority sets inspection urgency."}
    corridor = {**common, "request_id": "SYN-LEAD-REVISION", "report_group": "SYN-OBSERVER-01"}
    followup = {**common, "report_group": "SYN-FOLLOWUP-01", "expires_at": 130.0}
    events = [
        {**corridor, "event_id": "SYN-LEAD-REVISION:1", "msg_type": "Alert",
         "asset_id": "LINE_028", "issued_at": 19.0, "received_at": 20.0,
         "reason": "Observer requests a routine view near LINE_028 after reporting unusual movement. Weather may delay flight."},
        {**corridor, "event_id": "SYN-LEAD-REVISION:2", "msg_type": "Update",
         "asset_id": "LINE_002", "issued_at": 28.0, "received_at": 29.0,
         "references": ["SYN-LEAD-REVISION:1"],
         "reason": "Observer corrects the reported location to LINE_002; supersede the queued LINE_028 lead."},
        {**corridor, "event_id": "SYN-LEAD-REVISION:3", "msg_type": "Cancel",
         "asset_id": "LINE_002", "issued_at": 31.0, "received_at": 32.0,
         "references": ["SYN-LEAD-REVISION:2"],
         "reason": "Observer withdraws the corrected lead after reviewing their location. Cancel its queued check and retain the current asset assessment."},
        {**followup, "request_id": "SYN-LEAD-WEST", "event_id": "SYN-LEAD-WEST:1",
         "msg_type": "Alert", "asset_id": "LINE_058", "priority": "high",
         "issued_at": 45.0, "received_at": 46.0,
         "reason": "A new observer reports recurring movement near LINE_058 after the gust warning ended. Obtain a stationary view; the site has no live coverage."},
        {**followup, "request_id": "SYN-LEAD-FOLLOWUP", "event_id": "SYN-LEAD-FOLLOWUP:1",
         "msg_type": "Alert", "asset_id": "LINE_015", "issued_at": 49.0, "received_at": 50.0,
         "related_asset_id": "LINE_058", "hold_for_inspection_asset": "LINE_058",
         "reason": "A second unverified geographic lead concerns LINE_015. First obtain the LINE_058 inspection result, then reassess this follow-up's priority. The report group links geographic leads; electrical connectivity is unknown."},
    ]
    return deepcopy([event for event in events
                     if event["issued_at"] <= minute and event["received_at"] <= minute])


def resolve_mission_requests(events, minute):
    """Resolve latest received lifecycle versions; retain raw events elsewhere.

    This pure feed helper never reads world state. A cancellation remains a
    tombstone, so replaying an older or translated report cannot resurrect it.
    """
    _validate_minute(minute)
    available = [deepcopy(event) for event in events
                 if event.get("issued_at", math.inf) <= minute
                 and event.get("received_at", math.inf) <= minute]
    available.sort(key=lambda event: (event["issued_at"], event["received_at"], event["event_id"]))
    latest = {}
    for event in available:
        request_id = event["request_id"]
        previous = latest.get(request_id)
        if previous and previous["issued_at"] == event["issued_at"] and previous["msg_type"].lower() == "cancel":
            continue
        latest[request_id] = event
    return [event for _, event in sorted(latest.items())
            if event["msg_type"].lower() != "cancel" and minute < event.get("expires_at", math.inf)]


def dynamic_asset_state(asset_id, minute):
    """Hidden physical process for generator/evaluator use only.

    LINE_026 develops a transient persistent residual after the gust episode,
    then relaxes. A later LINE_058 residual starts independently of report arrival
    and drone routing. Real repairs are never inferred or simulated by recovery.
    """
    _validate_minute(minute)
    phases = {"LINE_026": (25.0, 33.0, 65.0, 72.0),
              "LINE_058": (48.0, 53.0, 88.0, 94.0)}
    start, full, recover, end = phases.get(str(asset_id), (math.inf,) * 4)
    if minute <= start or minute >= end:
        mechanical = 0.0
    elif minute < full:
        mechanical = (minute - start) / (full - start)
    elif minute <= recover:
        mechanical = 1.0
    else:
        mechanical = (end - minute) / (end - recover)
    return {"mechanical_strength": mechanical,
            "mechanical_anomaly": mechanical >= .4,
            "thermal_anomaly": False,
            "measurement_drift": False,
            "communication_loss": False}
