"""Offline geographic figures and flight/charge audit timelines."""
from __future__ import annotations

import pandas as pd
import plotly.graph_objects as go
import plotly.express as px
from plotly.colors import sample_colorscale

COLORS = [[0,"#38b6a1"],[.5,"#e7b75b"],[1,"#ed6478"]]


def official_map(state, selected=None, show_reports=True, show_nodes=False):
    fig=go.Figure()
    if show_reports:
        for item in state.dataset.public_config["public_context"]["reports"][1:]:
            ring=item["location_area_coordinates"]
            fig.add_trace(go.Scatter(x=[p[0] for p in ring],y=[p[1] for p in ring],mode="lines",
                fill="toself",fillcolor="rgba(119,164,204,0.07)",line=dict(width=1,color="rgba(119,164,204,.45)"),
                name=item["information_id"],hovertemplate=item["information_id"]+" · approximate report area<extra></extra>",
                showlegend=False))
    for key,row in state.dataset.segments.items():
        p=state.beliefs.line_probabilities[key]
        observed=key in state.beliefs.observations
        site=state.sites[key]
        charge=("Eligible under explicit demo assumption" if site.can_charge else
                "De-energized (official report)" if key=="LINE_024" else "Unavailable / unknown")
        fig.add_trace(go.Scatter(x=[p[0] for p in row["coordinates"]],y=[p[1] for p in row["coordinates"]],
            mode="lines",line=dict(color=sample_colorscale(COLORS,[p])[0],
                                    width=6 if key==selected else 3,dash="dot" if observed else "solid"),
            name=key,showlegend=False,
            hovertemplate=f"<b>{key}</b> · {row.get('voltage_kv','unknown')} kV (asset tag)<br>"
                          f"Modeled anomaly probability: {p:.1%}<br>Charging: {charge}<br>"
                          f"Reports: {', '.join(row['report_ids']) or 'None'}<extra></extra>"))
    hubs=[key for key,site in state.sites.items() if site.can_charge]
    fig.add_trace(go.Scatter(x=[state.dataset.segments[k]["position"][0] for k in hubs],
        y=[state.dataset.segments[k]["position"][1] for k in hubs],mode="markers",
        marker=dict(symbol="square-open",size=13,color="#90c8ff",line=dict(width=2)),
        text=hubs,name="Assumed charging sites",hovertemplate="%{text}<br>Explicit demo charging-power assumption<extra></extra>"))
    dead=state.dataset.segments["LINE_024"]["position"]
    fig.add_trace(go.Scatter(x=[dead[0]],y=[dead[1]],mode="markers",name="LINE_024 · de-energized",
        marker=dict(symbol="x",size=16,color="#ff7c8a"),hovertemplate="LINE_024<br>Official report: de-energized<br>Charging unavailable<extra></extra>"))
    if show_nodes:
        nodes=list(state.dataset.nodes.values())
        fig.add_trace(go.Scatter(x=[n["coordinates"][0] for n in nodes],y=[n["coordinates"][1] for n in nodes],
            mode="markers",marker=dict(size=5,color="#b6c7d9"),text=[n["node_id"] for n in nodes],
            name="Mapped nodes",hovertemplate="%{text}<br>Electrical internal connections unknown<extra></extra>"))
    for sensor in state.sensors:
        position=state.dataset.segments[sensor.line_id]["position"]
        action=state.pending.get(sensor.sensor_id)
        if action and sensor.status=="in_flight":
            destination=state.dataset.segments[action.line_id]["position"]
            fig.add_trace(go.Scatter(x=[position[0],destination[0]],y=[position[1],destination[1]],
                mode="lines",line=dict(color="#b3dcff",dash="dash",width=1),showlegend=False))
            fraction=min(1,max(0,(state.time-action.start)/max(action.flight_minutes,1e-12)))
            position=tuple(a+fraction*(b-a) for a,b in zip(position,destination))
        fig.add_trace(go.Scatter(x=[position[0]],y=[position[1]],mode="markers+text",
            marker=dict(symbol="diamond",size=14,color="#e8f4ff",line=dict(color="#0b1625",width=2)),
            text=[sensor.sensor_id.replace("Sensor ","S")],textposition="top center",name=sensor.sensor_id,
            hovertemplate=f"{sensor.sensor_id}<br>{sensor.line_id} · {sensor.status}<extra></extra>",showlegend=False))
    fig.add_trace(go.Scatter(x=[None],y=[None],mode="markers",showlegend=False,
        marker=dict(color=[0],cmin=0,cmax=1,colorscale=COLORS,showscale=True,
                    colorbar=dict(title="Model P(anomaly)",tickformat=".0%",thickness=12,len=.65))))
    fig.update_layout(height=580,paper_bgcolor="#111f30",plot_bgcolor="#111f30",font=dict(color="#dce7f5"),
        margin=dict(l=15,r=15,t=15,b=15),legend=dict(orientation="h",y=1.05,font=dict(size=10)),
        xaxis=dict(title="Longitude · WGS84",showgrid=False,zeroline=False),
        yaxis=dict(title="Latitude",showgrid=False,zeroline=False,scaleanchor="x",scaleratio=1.50),
        dragmode="pan",uirevision="official-bavaria")
    return fig


def mission_timeline(state):
    rows=[]
    for event in state.history:
        kind=event["type"]
        if kind not in ("flight_start","flight_arrival","charge_start","measurement_start"):
            continue
        start=event["time"]
        end=(event["arrival"] if kind=="flight_start" else
             start+state.config.inspection_minutes if kind=="flight_arrival" else event["finish_time"])
        if kind=="charge_start":
            interruptions=[e["time"] for e in state.history if e["type"]=="charge_interrupted"
                           and e["sensor_id"]==event["sensor_id"] and start <= e["time"] < end]
            end=min([end]+interruptions)
        rows.append({"sensor":event["sensor_id"],"start":start,"duration":max(0,min(end,state.time)-start),
                     "kind":{"flight_start":"Flight","charge_start":"Charging","measurement_start":"Perched measurement",
                             "flight_arrival":"Perched measurement"}[kind],
                     "line":event["line_id"]})
    fig=go.Figure()
    palette={"Flight":"#8aafff","Charging":"#38b6a1","Perched measurement":"#e7b75b"}
    for kind in palette:
        group=[r for r in rows if r["kind"]==kind]
        if group:
            fig.add_trace(go.Bar(y=[r["sensor"] for r in group],x=[r["duration"] for r in group],
                base=[r["start"] for r in group],orientation="h",name=kind,
                text=[r["line"] for r in group],marker_color=palette[kind],
                hovertemplate="%{text}<br>Start %{base:.1f} min · duration %{x:.1f} min<extra></extra>"))
    fig.update_layout(barmode="overlay",height=330,xaxis=dict(title="Minutes since mission start",range=[0,state.config.mission_minutes]),
                      yaxis=dict(autorange="reversed"),margin=dict(l=10,r=10,t=20,b=10),legend=dict(orientation="h"))
    return fig
