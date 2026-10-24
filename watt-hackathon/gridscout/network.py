"""Synthetic distribution twin; connectivity is a service proxy, not power flow."""
from __future__ import annotations

import math
import networkx as nx

from .models import GridState


def build_grid() -> GridState:
    """Build a reproducible 22-node, 21-line radial distribution network.

    Coordinates are synthetic kilometres about a fictional origin. Geographic
    coordinates are provided for display only and do not describe a real grid.
    Hidden damage is deliberately absent from this public graph.
    """
    graph = nx.Graph(name="GridScout synthetic valley feeder")
    infrastructure = [
        ("SRC", "Valley supply", "source", 0.0, 0.0),
        ("SUB", "Main substation", "substation", 1.0, 0.0),
        ("DW", "Western feeder", "distribution", 2.1, 1.7),
        ("DC", "Central feeder", "distribution", 3.2, 0.0),
        ("DE", "Eastern feeder", "distribution", 2.2, -1.8),
        ("DNW", "Northwest branch", "distribution", 3.9, 2.5),
        ("DNE", "Southeast branch", "distribution", 4.0, -2.5),
    ]
    for node, name, kind, x, y in infrastructure:
        graph.add_node(node, name=name, kind=kind, x=x, y=y, pos=(x, y),
                       latitude=51.0 + y / 111.0,
                       longitude=9.0 + x / 70.0, customers=0, demand_kw=0.0,
                       criticality="standard", critical=False)
    loads = [
        ("H1", "Regional hospital", "DNW", 5.0, 3.0, 1, 850, "hospital"),
        ("W1", "Drinking water plant", "DNW", 4.8, 1.9, 1, 560, "water"),
        ("A1", "Pine estate", "DW", 2.1, 3.0, 220, 660, "standard"),
        ("A2", "Hill village", "DW", 1.0, 2.4, 130, 390, "standard"),
        ("A3", "West farms", "DNW", 4.0, 3.8, 70, 240, "standard"),
        ("B1", "Town centre", "DC", 4.3, 0.8, 340, 1150, "standard"),
        ("B2", "South estate", "DC", 4.3, -0.7, 280, 840, "standard"),
        ("T1", "Emergency communications", "DC", 5.0, 0.0, 1, 180, "telecom"),
        ("B3", "Industrial park", "DC", 3.2, 1.1, 45, 1250, "standard"),
        ("B4", "Riverside", "SUB", 0.9, -1.0, 160, 480, "standard"),
        ("C1", "Lakeside", "DE", 1.1, -2.6, 180, 540, "standard"),
        ("C2", "East village", "DE", 2.3, -3.2, 125, 375, "standard"),
        ("H2", "Community clinic", "DNE", 5.2, -2.0, 1, 300, "hospital"),
        ("C3", "Orchard homes", "DNE", 4.6, -3.7, 210, 630, "standard"),
        ("C4", "Forest hamlet", "DNE", 3.5, -3.8, 65, 195, "standard"),
    ]
    for node, name, _, x, y, customers, demand, category in loads:
        graph.add_node(node, name=name, kind="load", x=x, y=y, pos=(x, y),
                       latitude=51.0 + y / 111.0,
                       longitude=9.0 + x / 70.0, customers=customers,
                       demand_kw=float(demand), criticality=category,
                       critical=category != "standard")
    branches = [
        ("SRC", "SUB", "Central", .20, .16),
        ("SUB", "DW", "West", .85, .55),
        ("SUB", "DC", "Central", .62, .40),
        ("SUB", "DE", "East", .75, .48),
        ("DW", "DNW", "West", .92, .72),
        ("DE", "DNE", "East", .81, .65),
    ]
    for index, (node, _, parent, *_) in enumerate(loads):
        zone = "West" if parent in ("DW", "DNW") else (
            "East" if parent in ("DE", "DNE") else "Central")
        branches.append((parent, node, zone, .40 + (index % 5) * .1,
                         .25 + (index % 6) * .09))
    for index, (u, v, zone, exposure, vulnerability) in enumerate(branches, 1):
        a, b = graph.nodes[u], graph.nodes[v]
        length = math.hypot(a["x"] - b["x"], a["y"] - b["y"])
        graph.add_edge(u, v, line_id=f"L{index:02d}", zone=zone,
                       length_km=length, exposure=exposure,
                       vulnerability=vulnerability,
                       inspection_minutes=4.0 + (index % 3),
                       midpoint=((a["x"] + b["x"]) / 2,
                                 (a["y"] + b["y"]) / 2))
    return GridState(graph, ("SRC",), (0.0, 0.0))


def lines(grid: GridState) -> dict[str, dict]:
    return {data["line_id"]: {**data, "u": u, "v": v}
            for u, v, data in grid.graph.edges(data=True)}


def evaluate_supplied_load(grid: GridState, failed_lines=()) -> dict[str, float]:
    """Reachability from any source, allowing alternate paths and sources.

    No capacity, voltage, switching protection, or AC/DC flow constraints are
    modeled. A critical site is counted once regardless of its demand.
    """
    failed = set(failed_lines)
    active = nx.subgraph_view(
        grid.graph,
        filter_edge=lambda u, v: grid.graph.edges[u, v]["line_id"] not in failed)
    energized: set[str] = set()
    for source in grid.sources:
        if source in active and source not in energized:
            energized.update(nx.node_connected_component(active, source))
    result = dict(supplied_customers=0.0, supplied_kw=0.0,
                  disconnected_customers=0.0, unserved_kw=0.0,
                  critical_disconnected=0.0)
    for node, data in grid.graph.nodes(data=True):
        customers, demand = data.get("customers", 0), data.get("demand_kw", 0.0)
        if node in energized:
            result["supplied_customers"] += customers
            result["supplied_kw"] += demand
        else:
            result["disconnected_customers"] += customers
            result["unserved_kw"] += demand
            result["critical_disconnected"] += int(data.get("critical", False))
    return result


def disconnected_customers(grid: GridState, failed_lines=()) -> float:
    return evaluate_supplied_load(grid, failed_lines)["disconnected_customers"]


def unserved_demand(grid: GridState, failed_lines=()) -> float:
    return evaluate_supplied_load(grid, failed_lines)["unserved_kw"]


def important_network_edges(grid: GridState) -> list[dict]:
    """Rank edge removal by lost demand (not graph centrality)."""
    baseline = evaluate_supplied_load(grid)
    result = []
    for line_id in lines(grid):
        service = evaluate_supplied_load(grid, [line_id])
        result.append({"line_id": line_id,
                       "customers": service["disconnected_customers"] - baseline["disconnected_customers"],
                       "demand_kw": service["unserved_kw"] - baseline["unserved_kw"],
                       "critical_sites": service["critical_disconnected"] - baseline["critical_disconnected"]})
    return sorted(result, key=lambda row: (-row["demand_kw"], row["line_id"]))


def potential_restoration_impact(grid: GridState, failed_lines, repaired_line: str) -> dict[str, float]:
    """Exact service gain from repairing one edge in a given failure set."""
    failed = set(failed_lines)
    before = evaluate_supplied_load(grid, failed)
    after = evaluate_supplied_load(grid, failed - {repaired_line})
    return {"customers": after["supplied_customers"] - before["supplied_customers"],
            "demand_kw": after["supplied_kw"] - before["supplied_kw"],
            "critical_sites": before["critical_disconnected"] - after["critical_disconnected"]}
