"""Exercise weather, forecast revisions and CAP-like warning lifecycle.

All times are exercise minutes. No network calls, actual warnings or real-world
operating limits are represented here. A weather warning is contextual evidence,
not an additional independent observation that a line is damaged.
"""
from __future__ import annotations

from copy import deepcopy
import math

WARNING_AREA = [10.45, 48.09, 10.88, 48.38]


def _known_time(message: dict, name: str, default: float) -> float:
    value = message.get(name)
    return default if value is None else float(value)


def resolve_warnings(messages, minute: float, position=None) -> list[dict]:
    """Resolve event versions before validity/position filtering.

    Only received AND issued messages may supersede earlier records. Expired or
    future-valid updates still replace older versions; cancellation tombstones
    prevent a stale translated copy from reactivating the event. ``references``
    may list prior record IDs (as a string, dict or list). Explicit ``event_id``
    is preferred, permitting multilingual messages to represent one event.
    """
    available = [deepcopy(record) for record in messages
                 if _known_time(record, "issued_at", math.inf) <= minute
                 and _known_time(record, "received_at", math.inf) <= minute]
    available.sort(key=lambda r: (_known_time(r, "issued_at", 0),
                                  _known_time(r, "received_at", 0),
                                  str(r.get("id", r.get("record_id", "")))))
    record_event = {}
    events = {}
    for record in available:
        record_id = str(record.get("id", record.get("record_id", "")))
        references = record.get("references", [])
        if isinstance(references, (str, dict)):
            references = [references]
        referenced_events = []
        for reference in references:
            if isinstance(reference, dict):
                reference = reference.get("id", reference.get("identifier", ""))
            # CAP references may be "sender,identifier,sent" triplets.
            reference_text = str(reference)
            parts = reference_text.split(",")
            reference_id = parts[1] if len(parts) == 3 else reference_text
            if reference_id in record_event:
                referenced_events.append(record_event[reference_id])
        event = str(record.get("event_id") or (referenced_events[0] if referenced_events else record_id))
        # A later update may explicitly name a new event id but reference the old
        # record. Treat the reference lineage as the same lifecycle.
        if referenced_events:
            event = referenced_events[0]
        record_event[record_id] = event
        previous = events.get(event)
        issue = _known_time(record, "issued_at", 0)
        kind = str(record.get("msg_type", "Alert")).lower()
        if previous is not None:
            prev_issue = _known_time(previous, "issued_at", 0)
            prev_kind = str(previous.get("msg_type", "Alert")).lower()
            # Same-version language/transport duplicates never undo cancellation.
            if issue == prev_issue and prev_kind == "cancel" and kind != "cancel":
                continue
            # A delayed translated Alert is not a new alert after a lifecycle
            # Update/Cancel unless it really has a newer issue timestamp.
            if issue < prev_issue:
                continue
        events[event] = record
    active = []
    for event, record in events.items():
        if str(record.get("msg_type", "Alert")).lower() == "cancel":
            continue
        if not _known_time(record, "valid_from", -math.inf) <= minute < _known_time(record, "valid_to", math.inf):
            continue
        if position is not None and record.get("area") is not None:
            west, south, east, north = record["area"]
            lon, lat = position
            if not (west <= lon <= east and south <= lat <= north):
                continue
        record["event_id"] = event
        active.append(record)
    return sorted(active, key=lambda item: str(item["event_id"]))


def _warning_messages(storm: bool) -> list[dict]:
    if not storm:
        return []
    base = {"event_id": "SYN-WIND-01", "area": WARNING_AREA,
            "source": "Synthetic exercise weather desk (CAP-like)", "synthetic": True,
            "dependency_group": "SYN-WEATHER-01", "quality": "exercise assumption"}
    return [
        {**base, "id": "wind-alert-en", "msg_type": "Alert", "language": "en", "issued_at": 4.0, "received_at": 5.0,
         "valid_from": 10.0, "valid_to": 50.0, "severity": "Moderate", "headline": "Exercise: strong gusts expected"},
        {**base, "id": "wind-alert-de", "msg_type": "Alert", "language": "de", "issued_at": 4.0, "received_at": 6.0,
         "valid_from": 10.0, "valid_to": 50.0, "severity": "Moderate", "headline": "Übung: starke Böen erwartet"},
        {**base, "id": "wind-update-en", "msg_type": "Update", "references": ["wind-alert-en"], "language": "en",
         "issued_at": 18.0, "received_at": 19.0, "valid_from": 18.0, "valid_to": 48.0,
         "severity": "Severe", "headline": "Exercise: gust episode updated"},
        {**base, "id": "wind-cancel", "msg_type": "Cancel", "references": ["wind-update-en"], "language": "en",
         "issued_at": 43.0, "received_at": 44.0, "valid_from": 43.0, "valid_to": 48.0,
         "severity": "Minor", "headline": "Exercise: wind warning cancelled"},
    ]


def weather_at(minute: float, scenario: str = "mechanical", seed: int = 42) -> dict:
    """Public weather context known at this time, separate from future truth."""
    if not math.isfinite(minute) or minute < 0:
        raise ValueError("Exercise minute must be finite and nonnegative")
    if scenario not in ("normal", "gusts", "mechanical", "thermal", "dropout", "drift", "dynamic"):
        raise ValueError(f"Unknown synthetic scenario: {scenario}")
    storm = scenario in ("gusts", "mechanical", "dropout", "drift", "dynamic")
    phase = (seed % 19) / 19
    if storm and 10 <= minute <= 45:
        # An asymmetric pulse: maximum around minute 27, calm again at 45.
        fraction = (minute - 10) / 17 if minute <= 27 else (45 - minute) / 18
        pulse = max(0.0, fraction)
    else:
        pulse = 0.0
    wind = 3.2 + 0.45 * math.sin(minute / 11 + phase) + 9.0 * pulse
    gust = wind + 1.5 + 6.0 * pulse
    ambient = 19.0 + 1.8 * math.sin(minute / 75 + phase)
    solar = max(0, 460 + 120 * math.sin(minute / 55 + phase) - 190 * pulse)
    # Forecast revisions are selected by publication/receipt, not future values.
    revision = 0 if minute < 19 else (1 if minute < 44 else 2)
    issue, receipt, valid_from, valid_to = [(0.0, 0.0, 0.0, 45.0), (18.0, 19.0, 19.0, 60.0), (43.0, 44.0, 44.0, 90.0)][revision]
    forecast_gust = ([22.5, 24.0, 7.0][revision] if storm else 6.5)
    if minute >= valid_to:
        # Later routine refresh, always known by the current exercise time.
        issue = receipt = math.floor(minute / 30) * 30.0
        valid_from, valid_to, forecast_gust = issue, issue + 45.0, 7.0
    all_messages = _warning_messages(storm)
    messages = [message for message in all_messages if message["issued_at"] <= minute and message["received_at"] <= minute]
    forecast = {"record_id": f"SYN-FORECAST-{issue:g}", "issued_at": issue, "received_at": receipt,
                "valid_from": valid_from, "valid_to": valid_to, "gust_mps": forecast_gust,
                "source": "Synthetic exercise point forecast", "synthetic": True,
                "dependency_group": "SYN-WEATHER-01", "units": {"gust_mps": "m/s"},
                "quality": "uncalibrated exercise forecast"}
    if storm and revision < 2:
        # Published future interval, allowing a short flight to complete before
        # hazardous gusts are expected. This is forecast metadata, not peeked
        # simulator weather; actual gust timing and magnitude can differ.
        forecast.update(peak_from=10.0, peak_to=45.0)
    return {"ambient_c": ambient, "wind_mps": wind, "gust_mps": gust, "solar_wm2": solar,
            "humidity_pct": min(98.0, 57.0 + 20.0 * pulse), "load_pu": None,
            "energized": True, "observed_at": float(minute), "received_at": float(minute),
            "source": "Synthetic exercise weather observation", "synthetic": True,
            "forecast": forecast, "messages": deepcopy(messages), "warnings": resolve_warnings(messages, minute)}
