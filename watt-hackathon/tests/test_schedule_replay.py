"""The imported route must preserve its geometry, coverage and ordering."""
import hashlib
import json

import pytest

from gridscout.official_data import load_official_dataset
from gridscout.schedule_replay import (
    DEFAULT_INPUT, DEFAULT_OUTPUT, build_schedule_replay, frame_at, main, parse_schedule_text,
)


@pytest.fixture(scope="module")
def replay():
    return build_schedule_replay()


@pytest.fixture(scope="module")
def text():
    return DEFAULT_INPUT.read_text(encoding="utf-8-sig")


def test_bundled_route_totals_and_missing_target(replay):
    assert replay["summary"] == {
        "distance_km": 184.681261, "leg_count": 56, "checked_count": 53,
        "unchecked_count": 10, "unspecified_count": 1, "node_count": 28,
        "unique_travelled_lines": 29,
    }
    assert replay["start_node_id"] == "SUBSTATION_07"
    assert replay["end_node_id"] == "NODE_019"
    assert replay["target_line_id"] == "LINE_024"
    assert replay["unspecified"] == ["LINE_024"]
    coverage = {row["line_id"]: row["coverage"] for row in replay["geometry"]}
    assert len(coverage) == 64
    assert coverage["LINE_024"] == "unspecified"
    assert all(coverage[row["line_id"]] == "checked" for row in replay["checked"])
    assert replay["metadata"]["source_sha256"] == hashlib.sha256(DEFAULT_INPUT.read_bytes()).hexdigest()


def test_reverse_and_repeated_legs_use_the_specific_official_polyline(replay):
    official = load_official_dataset()
    for index, leg in enumerate(replay["legs"], 1):
        segment = official.segments[leg["line_id"]]
        coordinates = segment["coordinates"]
        assert leg["index"] == index
        if leg["from_node_id"] != segment["from_node"]:
            coordinates = list(reversed(coordinates))
        assert leg["coordinates"] == coordinates
    assert replay["legs"][0]["coordinates"] == list(reversed(replay["legs"][1]["coordinates"]))
    # Parallel LINE_001 has different geometry and must not replace LINE_020.
    leg = replay["legs"][2]
    assert leg["line_id"] == "LINE_020"
    assert leg["coordinates"] != official.segments["LINE_001"]["coordinates"]


def test_frames_never_include_future_travel(replay):
    first = frame_at(replay, 0)
    assert first["completed_legs"] == []
    assert first["distance_km"] == 0
    assert first["position"] == replay["legs"][0]["coordinates"][0]
    middle = frame_at(replay, 1.5)
    assert len(middle["completed_legs"]) == 1
    assert middle["distance_km"] == pytest.approx(.120347 * 1.5)
    assert middle["current_leg_index"] == 2
    assert middle["visited_node_ids"] == ["SUBSTATION_07", "NODE_031"]
    last = frame_at(replay, 56)
    assert last["distance_km"] == 184.681261
    assert last["position"] == replay["legs"][-1]["coordinates"][-1]
    assert last["current_leg_index"] is None
    assert len(last["completed_legs"]) == 56
    assert frame_at(replay, 1.5) == middle


def test_coverage_events_only_reference_first_reached_nodes(replay):
    arrivals = {replay["start_node_id"]: 0}
    for leg in replay["legs"]:
        arrivals.setdefault(leg["to_node_id"], leg["index"])
    assert len(replay["coverage_events"]) == 53
    for checked, event in zip(replay["checked"], replay["coverage_events"]):
        assert event == {"line_id": checked["line_id"], "step": arrivals[checked["checked_at_node"]]}


@pytest.mark.parametrize("old,new,error", [
    ("'from_node_id': 'NODE_031', 'to_node_id': 'SUBSTATION_07'",
     "'from_node_id': 'SUBSTATION_07', 'to_node_id': 'NODE_031'", "continuity"),
    ("'line_id': 'LINE_045', 'distance_km': 0.120347",
     "'line_id': 'LINE_999', 'distance_km': 0.120347", "unknown"),
    ("'distance_km': 0.120347", "'distance_km': -1", "nonnegative"),
    ("'distance_km': 0.120347", "'distance_km': True", "nonnegative"),
    ("'distance_km': 0.120347", "'distance_km': 1e999", "finite"),
    ("'distance_km': 0.120347", "'distance_km': 99", "official line length"),
    ("Total distance: 184.681261 km", "Total distance: 184.6812629 km", "sum"),
    ("'other_end_node_id': 'NODE_026'", "'other_end_node_id': 'NODE_999'", "endpoints"),
    ("Unchecked lines: ['LINE_005'", "Unchecked lines: ['LINE_014'", "overlap"),
    ("All lines checked: False", "All lines checked: True", "flag"),
])
def test_invalid_exports_are_rejected(text, old, new, error):
    with pytest.raises(ValueError, match=error):
        parse_schedule_text(text.replace(old, new, 1))


def test_duplicate_checks_and_unsafe_literals_are_rejected(text, tmp_path):
    record = "{'line_id': 'LINE_014', 'checked_at_node': 'SUBSTATION_07', 'other_end_node_id': 'NODE_026'}"
    with pytest.raises(ValueError, match="duplicate"):
        parse_schedule_text(text.replace(record, f"{record}\n{record}", 1))
    sentinel = tmp_path / "must-not-exist"
    expression = f"__import__('pathlib').Path({str(sentinel)!r}).touch()"
    with pytest.raises(ValueError, match="literal"):
        parse_schedule_text(text.replace(record, expression, 1))
    assert not sentinel.exists()


@pytest.mark.parametrize("step", [-1, 56.1, True, float("nan"), float("inf"), "1"])
def test_invalid_frame_steps_are_rejected(replay, step):
    with pytest.raises(ValueError):
        frame_at(replay, step)


def test_cli_and_bundled_artifact_are_deterministic(replay, tmp_path):
    output = tmp_path / "replay.json"
    assert main(["--output", str(output)]) == replay
    assert json.loads(output.read_text(encoding="utf-8")) == replay
    assert json.loads(DEFAULT_OUTPUT.read_text(encoding="utf-8")) == replay
    assert len(output.read_bytes()) < 500_000
