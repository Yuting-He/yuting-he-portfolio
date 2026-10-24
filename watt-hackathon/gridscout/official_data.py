"""Read the organizer's unmodified public package; mapped adjacency is not circuitry."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import csv
import hashlib
import json
import math

import networkx as nx

DATA_DIRECTORY = Path(__file__).resolve().parents[1] / "data" / "official"
CHALLENGE_URL = "https://app.notion.com/p/nomadicdrone/Nomadic-Challenge-Keeping-the-Power-Flowing-400b293a19d8818fb466caf01a743ed6"


@dataclass(frozen=True)
class OfficialDataset:
    segments: dict[str, dict]
    nodes: dict[str, dict]
    reports: tuple[dict, ...]
    context: dict
    public_config: dict
    mapped_graph: nx.MultiGraph
    manifest: dict


def haversine_km(a, b):
    """Great-circle distance between (longitude, latitude) positions."""
    lon1, lat1, lon2, lat2 = map(math.radians, (*a, *b))
    value = math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin((lon2-lon1)/2)**2
    return 6371.0088 * 2 * math.asin(math.sqrt(min(1.0, value)))


def geometry_midpoint(coordinates):
    lengths = [haversine_km(a, b) for a, b in zip(coordinates, coordinates[1:])]
    remaining = sum(lengths) / 2
    for a, b, length in zip(coordinates, coordinates[1:], lengths):
        if remaining <= length and length > 0:
            fraction = remaining / length
            return (a[0] + fraction*(b[0]-a[0]), a[1] + fraction*(b[1]-a[1]))
        remaining -= length
    return tuple(coordinates[-1])


def _cross(a, b, c):
    return (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0])


def _on_segment(a, b, point):
    return abs(_cross(a, b, point)) < 1e-12 and all(
        min(a[i], b[i])-1e-12 <= point[i] <= max(a[i], b[i])+1e-12 for i in (0, 1))


def _intersect(a, b, c, d):
    x, y, z, w = _cross(a,b,c), _cross(a,b,d), _cross(c,d,a), _cross(c,d,b)
    return (x*y < 0 and z*w < 0) or any((_on_segment(a,b,c), _on_segment(a,b,d),
                                                        _on_segment(c,d,a), _on_segment(c,d,b)))


def point_in_polygon(point, ring):
    inside = False
    for a, b in zip(ring, ring[1:] + ring[:1]):
        if _on_segment(a, b, point):
            return True
        if (a[1] > point[1]) != (b[1] > point[1]):
            crossing = a[0] + (point[1]-a[1])*(b[0]-a[0])/(b[1]-a[1])
            if point[0] < crossing:
                inside = not inside
    return inside


def line_intersects_polygon(coordinates, ring):
    """Intersection uses full polylines, not just a midpoint membership test."""
    return any(point_in_polygon(p, ring) for p in coordinates) or any(
        _intersect(a,b,c,d) for a,b in zip(coordinates,coordinates[1:])
        for c,d in zip(ring,ring[1:]+ring[:1]))


def load_official_dataset(directory: Path = DATA_DIRECTORY) -> OfficialDataset:
    directory = Path(directory)
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    for name, digest in manifest["files"].items():
        if hashlib.sha256((directory / name).read_bytes()).hexdigest() != digest:
            raise ValueError(f"Official package checksum mismatch: {name}")
    segment_geo = json.loads((directory / "grid_segments.geojson").read_text(encoding="utf-8-sig"))
    node_geo = json.loads((directory / "grid_nodes.geojson").read_text(encoding="utf-8-sig"))
    public = json.loads((directory / "scenario_public_config.json").read_text(encoding="utf-8-sig"))
    with (directory / "initial_information.csv").open(encoding="utf-8-sig", newline="") as handle:
        reports = tuple(dict(r) for r in csv.DictReader(handle))
    if len(reports) != 6 or len({r["information_id"] for r in reports}) != 6:
        raise ValueError("Expected all six unique organizer reports")
    polygons = {r["information_id"]:r["location_area_coordinates"] for r in public["public_context"]["reports"]}
    report_weights = {"SYN_REPORT_02": .35, "SYN_REPORT_03": .20,
                      "SYN_REPORT_04": .10, "SYN_REPORT_05": .30, "SYN_REPORT_06": .25}
    graph = nx.MultiGraph(name="Official mapped adjacency — electrical connectivity unknown")
    nodes = {}
    for feature in node_geo["features"]:
        row = dict(feature["properties"])
        row["coordinates"] = tuple(feature["geometry"]["coordinates"])
        nodes[row["node_id"]] = row
        graph.add_node(row["node_id"], **row)
    segments = {}
    for feature in segment_geo["features"]:
        row = dict(feature["properties"])
        row["coordinates"] = feature["geometry"]["coordinates"]
        row["position"] = geometry_midpoint(row["coordinates"])
        row["report_ids"] = [key for key, ring in polygons.items()
                             if line_intersects_polygon(row["coordinates"], ring)]
        row["report_log_odds"] = sum(report_weights.get(key, 0) for key in row["report_ids"])
        # Geographic bands share illustrative severity; component_id is NOT an outage zone.
        row["hazard_zone"] = "West" if row["position"][0] < 10.60 else (
            "Central" if row["position"][0] < 10.75 else "East")
        segments[row["segment_id"]] = row
        graph.add_edge(row["from_node"], row["to_node"], key=row["segment_id"], **row)
    return OfficialDataset(segments, nodes, reports,
                           json.loads((directory / "scenario_context.geojson").read_text(encoding="utf-8-sig")),
                           public, graph, manifest)


def choose_sites(dataset: OfficialDataset, count: int, candidates=None) -> tuple[str, ...]:
    """Reproducible report-informed, geographically spread starting-site heuristic."""
    remaining = sorted(candidates if candidates is not None else dataset.segments)
    remaining = [key for key in remaining if key != "LINE_024"]
    chosen = []
    while remaining and len(chosen) < count:
        def score(key):
            row = dataset.segments[key]
            distance = min((haversine_km(row["position"],dataset.segments[k]["position"])
                            for k in chosen), default=0)
            return row["report_log_odds"] + .025 * min(distance, 20)
        key = min(remaining, key=lambda key: (-score(key), key))
        chosen.append(key)
        remaining.remove(key)
    return tuple(chosen)
