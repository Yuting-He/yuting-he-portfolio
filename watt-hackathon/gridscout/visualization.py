"""Offline Plotly charts. No remote map tiles, geographic data, or services."""
from __future__ import annotations

import pandas as pd
import plotly.graph_objects as go
from plotly.colors import sample_colorscale

from .models import BeliefState, GridState, MissionState
from .network import lines


PROBABILITY_SCALE = [[0, "#38b6a1"], [0.5, "#e7b75b"], [1, "#ed6478"]]


def network_figure(grid: GridState, beliefs: BeliefState, mission: MissionState,
                   selected_line: str | None = None) -> go.Figure:
    fig = go.Figure()
    for line_id, data in lines(grid).items():
        left, right = grid.graph.nodes[data["u"]], grid.graph.nodes[data["v"]]
        probability = beliefs.line_probabilities[line_id]
        observed = beliefs.observations.get(line_id)
        if observed:
            status = "Positive sensor report" if observed.positive else "Negative sensor report"
        elif line_id in {action.line_id for action in mission.pending.values()}:
            status = "Assigned"
        else:
            status = "Uninspected"
        color = sample_colorscale(PROBABILITY_SCALE, [probability])[0]
        fig.add_trace(go.Scatter(
            x=[left["x"], right["x"]], y=[left["y"], right["y"]],
            mode="lines", line=dict(color=color, width=7 if line_id == selected_line else 4,
                                    dash="dot" if observed else "solid"),
            name=line_id, showlegend=False,
            hovertemplate=(f"<b>{line_id}</b> · {data['zone']}<br>Posterior failure: {probability:.1%}"
                           f"<br>{status}<extra></extra>"),
        ))
        mid = data["midpoint"]
        fig.add_annotation(x=mid[0], y=mid[1], text=line_id, showarrow=False,
                           font=dict(size=10, color="#a6b7cc"), yshift=10)

    nodes = list(grid.graph.nodes(data=True))
    node_colors = {"source": "#63dcbb", "substation": "#8eafff", "distribution": "#b7c8dc", "load": "#f5f7fc"}
    fig.add_trace(go.Scatter(
        x=[n[1]["x"] for n in nodes], y=[n[1]["y"] for n in nodes], mode="markers",
        marker=dict(
            size=[19 if n[1].get("critical") else 14 if n[1].get("kind") == "source" else 10 for n in nodes],
            color=["#caa7ff" if n[1].get("critical") else node_colors.get(n[1].get("kind"), "#b7c8dc") for n in nodes],
            symbol=["star" if n[1].get("critical") else "square" if n[1].get("kind") == "source" else "circle" for n in nodes],
            line=dict(color="#102135", width=1.5)),
        text=[f"<b>{n[1].get('name', n[0])}</b><br>{n[1].get('kind', 'node')} · {n[1].get('criticality', 'standard')}"
              f"<br>{n[1].get('customers', 0):,.0f} customers · {n[1].get('demand_kw', 0):,.0f} kW" for n in nodes],
        hovertemplate="%{text}<extra></extra>", showlegend=False,
    ))
    for sensor in mission.sensors:
        fig.add_trace(go.Scatter(
            x=[sensor.position[0]], y=[sensor.position[1]], mode="markers+text",
            text=[sensor.sensor_id], textposition="bottom center",
            marker=dict(size=15, color="#75ccff", symbol="diamond", line=dict(color="#fff", width=1)),
            name=sensor.sensor_id,
            hovertemplate=f"<b>{sensor.sensor_id}</b><br>{sensor.status}<br>Endurance remaining: {sensor.remaining_endurance:.1f} min<extra></extra>",
        ))
    fig.add_trace(go.Scatter(
        x=[None], y=[None], mode="markers", showlegend=False,
        marker=dict(color=[0], cmin=0, cmax=1, colorscale=PROBABILITY_SCALE, showscale=True,
                    colorbar=dict(title="P(failure)", tickformat=".0%", thickness=12, len=0.7)),
    ))
    fig.update_layout(
        height=510, paper_bgcolor="#111f30", plot_bgcolor="#111f30", font=dict(color="#dce7f5"),
        margin=dict(l=15, r=25, t=15, b=10), hovermode="closest", dragmode="pan",
        legend=dict(orientation="h", y=1.06, x=0),
        xaxis=dict(showgrid=False, zeroline=False, showticklabels=False, title=""),
        yaxis=dict(showgrid=False, zeroline=False, showticklabels=False, scaleanchor="x", scaleratio=1, title=""),
    )
    return fig


def severity_figure(prior, posterior, title: str) -> go.Figure:
    fig = go.Figure([
        go.Bar(name="Prior", x=["Low", "Medium", "High"], y=list(prior), marker_color="#70839f"),
        go.Bar(name="Posterior", x=["Low", "Medium", "High"], y=list(posterior), marker_color="#38b6a1"),
    ])
    fig.update_layout(title=title, height=320, barmode="group", yaxis=dict(range=[0, 1], tickformat=".0%"),
                      margin=dict(l=15, r=15, t=50, b=10), legend=dict(orientation="h"))
    return fig


def probability_change_figure(frame: pd.DataFrame) -> go.Figure:
    fig = go.Figure([
        go.Bar(name="Before observation", x=frame["Line"], y=frame["Before"], marker_color="#70839f"),
        go.Bar(name="After observation", x=frame["Line"], y=frame["After"], marker_color="#38b6a1"),
    ])
    fig.update_layout(height=330, barmode="group", yaxis=dict(range=[0, 1], tickformat=".0%"),
                      margin=dict(l=15, r=15, t=20, b=10), legend=dict(orientation="h"))
    return fig
