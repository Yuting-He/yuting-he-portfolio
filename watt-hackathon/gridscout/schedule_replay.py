"""Adapt a teammate's exported node/line schedule into a geographic replay.

Run ``python -m gridscout.schedule_replay`` to rebuild the bundled showcase.
The text export is parsed as literal data; it is never executed.
"""
from __future__ import annotations

import argparse
import ast
from copy import deepcopy
from decimal import Decimal
import hashlib
import json
import math
from pathlib import Path
import re

from .official_data import OfficialDataset, haversine_km, load_official_dataset

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = PROJECT_ROOT / "data" / "schedules" / "teammate_output.txt"
DEFAULT_OUTPUT = PROJECT_ROOT / "artifacts" / "schedule_replay.json"
CHECKED_HEADER = "Newly checked lines (each line listed once):"
LEGS_HEADER = "Actual travel legs:"


def _literal(text: str, context: str):
    try:
        return ast.literal_eval(text)
    except (ValueError, SyntaxError, TypeError, RecursionError) as exc:
        raise ValueError(f"Invalid literal in {context}") from exc


def _number(value, context: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (float, int)):
        raise ValueError(f"{context} must be a finite nonnegative number")
    try:
        result = float(value)
    except (OverflowError, ValueError) as exc:
        raise ValueError(f"{context} must be a finite nonnegative number") from exc
    if not math.isfinite(result) or result < 0:
        raise ValueError(f"{context} must be a finite nonnegative number")
    return result


def _record(line: str, fields: set[str], context: str) -> dict:
    row = _literal(line, context)
    if not isinstance(row, dict) or set(row) != fields:
        raise ValueError(f"{context} must contain exactly {sorted(fields)}")
    if any(not isinstance(row[key], str) or not row[key]
           for key in fields - {"distance_km"}):
        raise ValueError(f"{context} IDs must be nonempty strings")
    return row


def parse_schedule_text(text: str, *, dataset: OfficialDataset | None = None) -> dict:
    """Validate the export against the official map and return JSON-ready data.

    Checked coverage is kept separate from travel. A line omitted from both
    coverage lists is explicitly unspecified, including the initial target.
    """
    if not isinstance(text, str) or len(text) > 5_000_000:
        raise ValueError("Schedule must be text smaller than 5 MB")
    lines = [line.strip() for line in text.lstrip("\ufeff").splitlines() if line.strip()]
    if len(lines) < 7:
        raise ValueError("Schedule is missing its header or record sections")
    distance_match = re.fullmatch(r"Total distance: ([0-9]+(?:\.[0-9]+)?) km", lines[0])
    status_match = re.fullmatch(r"All lines checked: (True|False)", lines[1])
    if not distance_match or not status_match or not lines[2].startswith("Unchecked lines: "):
        raise ValueError("Schedule header is invalid")
    distance_km = _number(float(distance_match[1]), "Total distance")
    unchecked = _literal(lines[2][len("Unchecked lines: "):], "unchecked lines")
    if not isinstance(unchecked, list) or any(not isinstance(item, str) for item in unchecked):
        raise ValueError("Unchecked lines must be a list of line IDs")
    if len(set(unchecked)) != len(unchecked):
        raise ValueError("Unchecked lines contain duplicate IDs")
    start_match = re.fullmatch(r"Starting from (\S+) to check (\S+)", lines[3])
    if not start_match or lines[4] != CHECKED_HEADER or lines.count(LEGS_HEADER) != 1:
        raise ValueError("Schedule start or record sections are invalid")
    legs_header = lines.index(LEGS_HEADER)
    if legs_header <= 4:
        raise ValueError("Travel section must follow checked lines")
    checked = [_record(line, {"line_id", "checked_at_node", "other_end_node_id"},
                       f"checked record {index}")
               for index, line in enumerate(lines[5:legs_header], 1)]
    travel = [_record(line, {"from_node_id", "to_node_id", "line_id", "distance_km"},
                      f"travel leg {index}")
              for index, line in enumerate(lines[legs_header + 1:], 1)]
    if not travel:
        raise ValueError("Schedule must contain at least one travel leg")
    dataset = dataset or load_official_dataset()
    segments, map_nodes = dataset.segments, dataset.nodes
    start_node_id, target_line_id = start_match.groups()
    if start_node_id not in map_nodes or target_line_id not in segments:
        raise ValueError("Unknown starting node or target line")
    checked_ids = [row["line_id"] for row in checked]
    if len(set(checked_ids)) != len(checked_ids):
        raise ValueError("Checked lines contain duplicate IDs")
    if set(checked_ids) & set(unchecked):
        raise ValueError("Checked and unchecked lines overlap")
    if not (set(checked_ids) | set(unchecked)) <= segments.keys():
        raise ValueError("Coverage references an unknown line ID")
    unspecified = sorted(segments.keys() - set(checked_ids) - set(unchecked))
    all_checked = not unchecked and not unspecified
    if (status_match[1] == "True") != all_checked:
        raise ValueError("All lines checked flag disagrees with coverage lists")
    for row in checked:
        segment = segments[row["line_id"]]
        if {row["checked_at_node"], row["other_end_node_id"]} != {
                segment["from_node"], segment["to_node"]}:
            raise ValueError(f"Checked endpoints do not match {row['line_id']}")

    legs = []
    total = Decimal("0")
    previous_node = start_node_id
    first_arrival = {start_node_id: 0}
    for index, row in enumerate(travel, 1):
        segment = segments.get(row["line_id"])
        if segment is None:
            raise ValueError(f"Travel leg {index} references an unknown line ID")
        if {row["from_node_id"], row["to_node_id"]} != {
                segment["from_node"], segment["to_node"]}:
            raise ValueError(f"Travel leg {index} endpoints do not match {row['line_id']}")
        if row["from_node_id"] != previous_node:
            raise ValueError(f"Travel leg {index} breaks route continuity")
        length = _number(row["distance_km"], f"Travel leg {index} distance")
        if not math.isclose(length, round(segment["length_km"], 6), abs_tol=1e-9, rel_tol=0):
            raise ValueError(f"Travel leg {index} distance disagrees with the official line length")
        total += Decimal(str(length))
        coordinates = deepcopy(segment["coordinates"])
        if row["from_node_id"] != segment["from_node"]:
            coordinates.reverse()
        legs.append({**row, "distance_km": length, "index": index,
                     "cumulative_distance_km": float(total), "coordinates": coordinates})
        previous_node = row["to_node_id"]
        first_arrival.setdefault(previous_node, index)
    if abs(total - Decimal(distance_match[1])) > Decimal("0.000001"):
        raise ValueError("Total distance disagrees with the sum of travel legs")
    if any(row["checked_at_node"] not in first_arrival for row in checked):
        raise ValueError("A checked node is never reached by the route")
    checked_set, unchecked_set = set(checked_ids), set(unchecked)
    data = {
        "schema_version": 1,
        "title": "Network route showcase",
        "start_node_id": start_node_id,
        "target_line_id": target_line_id,
        "end_node_id": previous_node,
        "summary": {"distance_km": float(total), "leg_count": len(legs),
                    "checked_count": len(checked), "unchecked_count": len(unchecked),
                    "unspecified_count": len(unspecified), "node_count": len(first_arrival),
                    "unique_travelled_lines": len({row["line_id"] for row in legs})},
        "legs": legs,
        "nodes": [{"node_id": key, "coordinates": list(row["coordinates"]),
                   "node_type": row["node_type"]} for key, row in map_nodes.items()],
        "geometry": [{"line_id": key, "coordinates": deepcopy(row["coordinates"]),
                      "coverage": "checked" if key in checked_set else (
                          "unchecked" if key in unchecked_set else "unspecified")}
                     for key, row in segments.items()],
        "checked": checked,
        "unchecked": unchecked,
        "unspecified": unspecified,
        "coverage_events": [{"line_id": row["line_id"],
                             "step": first_arrival[row["checked_at_node"]]} for row in checked],
    }
    json.dumps(data, allow_nan=False)
    return data


def build_schedule_replay(path: Path = DEFAULT_INPUT) -> dict:
    """Build from the bundled export or an explicitly selected input file."""
    path = Path(path)
    raw = path.read_bytes()
    data = parse_schedule_text(raw.decode("utf-8-sig"))
    data["metadata"] = {"source_filename": path.name,
                        "source_sha256": hashlib.sha256(raw).hexdigest()}
    return data


def frame_at(data: dict, step: float) -> dict:
    """Return route progress, including interpolation along the full polyline.

    An integer step is the number of completed legs. Fractional steps advance
    along the next leg; completed path data never includes a future leg.
    """
    step = _number(step, "Replay step")
    legs = data["legs"]
    if step > len(legs):
        raise ValueError("Replay step exceeds the route length")
    completed = int(step)
    fraction = step - completed
    active = legs[completed] if completed < len(legs) else None
    distance = legs[completed - 1]["cumulative_distance_km"] if completed else 0.0
    position = list(legs[max(0, completed - 1)]["coordinates"][-1] if completed else legs[0]["coordinates"][0])
    partial_coordinates = []
    if active is not None:
        coordinates = active["coordinates"]
        lengths = [haversine_km(a, b) for a, b in zip(coordinates, coordinates[1:])]
        remaining = sum(lengths) * fraction
        partial_coordinates = [list(coordinates[0])]
        position = list(coordinates[0])
        for a, b, length in zip(coordinates, coordinates[1:], lengths):
            if remaining <= length and length > 0:
                ratio = remaining / length
                position = [a[axis] + ratio * (b[axis] - a[axis]) for axis in (0, 1)]
                partial_coordinates.append(position)
                break
            remaining -= length
            partial_coordinates.append(list(b))
            position = list(b)
        distance += active["distance_km"] * fraction
    return {"step": step, "completed_leg_count": completed,
            "current_leg_index": active["index"] if active else None,
            "node_id": legs[completed - 1]["to_node_id"] if completed else data["start_node_id"],
            "distance_km": round(distance, 9), "position": position,
            "completed_legs": deepcopy(legs[:completed]),
            "partial_coordinates": partial_coordinates,
            "visited_node_ids": list(dict.fromkeys([data["start_node_id"], *[
                leg["to_node_id"] for leg in legs[:completed]]]))}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args(argv)
    data = build_schedule_replay(args.input)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False),
                           encoding="utf-8")
    print(json.dumps({"output": str(args.output), **data["summary"]}))
    return data


if __name__ == "__main__":
    main()
