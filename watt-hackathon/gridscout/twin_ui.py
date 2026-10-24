"""Five-device digital twin: synthetic streaming, inspectable beliefs and actions."""
from __future__ import annotations

from html import escape
import json

import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import streamlit as st

from .twin_engine import TwinSimulation
from .synthetic_telemetry import SCENARIOS
from .action_policy import recommend_actions, DEFAULT_COSTS
from .bn_ui import render_probability_explanation

CHANNELS = {
    "temperature_c": ("Conductor temperature", "°C"),
    "vibration_rms": ("Vibration RMS", "simulated units"),
    "voltage_pu": ("Energization proxy", "p.u."),
    "tilt_deg": ("Relative tilt", "°"),
}
ACCENT = "#59dec7"
BG = "#101e30"


def reset_twin(session, scenario="mechanical", seed=42):
    fresh = TwinSimulation(scenario=scenario, seed=seed, autonomous=True)
    for key in list(session):
        if str(key).startswith("tw_"):
            del session[key]
    session["tw_sim"] = fresh
    session["tw_playing"] = False
    session["tw_scenario"] = scenario
    session["tw_seed"] = seed
    session["tw_auto"] = True
    session["tw_follow"] = True


def _assessment(sim, asset):
    return sim.current(asset) or {"status": "Unknown", "anomaly": 0, "evidence": [], "alternatives": [], "missing": []}


def _risk_color(info):
    if "unknown" in str(info.get("status", "Unknown")).lower() or "stale" in str(info.get("status", "")).lower():
        return "#65758b"
    p = info.get("anomaly", 0)
    return "#ff8192" if p > .65 else "#f1bf6a" if p > .2 else ACCENT


def twin_map(sim, selected):
    fig = go.Figure()
    for warning in sim.weather.get("warnings", []):
        area = warning.get("area", [])
        if len(area) == 4 and all(isinstance(v, (float, int)) for v in area):
            west, south, east, north = area
            fig.add_trace(go.Scatter(x=[west,east,east,west,west], y=[south,south,north,north,south],
                fill="toself", fillcolor="rgba(241,191,106,.06)", mode="lines", line=dict(color="#766747",dash="dot"),
                name="Synthetic warning area", hoverinfo="name", showlegend=False))
    for asset, row in sim.dataset.segments.items():
        info = _assessment(sim, asset)
        observed = asset in sim.latest
        points = row["coordinates"]
        p = info.get("anomaly",0)
        fig.add_trace(go.Scatter(x=[p[0] for p in points], y=[p[1] for p in points], mode="lines",
            line=dict(color=_risk_color(info),width=6 if asset==selected else 2.5,
                      dash="solid" if observed and info.get("status")!="Unknown" else "dot"),
            name=asset, showlegend=False,
            hovertemplate=f"<b>{asset}</b><br>{escape(str(info.get('status','Unknown')))}<br>"+
                (f"Model P(anomaly): {p:.1%}" if observed and p is not None and info.get("status")!="Unknown" else "No fresh usable observation")+"<extra></extra>"))
    sites=sorted(sim.charging_sites)
    fig.add_trace(go.Scatter(x=[sim.dataset.segments[a]["position"][0] for a in sites],
        y=[sim.dataset.segments[a]["position"][1] for a in sites],mode="markers",
        marker=dict(symbol="square-open",size=10,color="#698dbb"),text=sites,name="Assumed charging site",
        hovertemplate="%{text}<br>Explicit demo power assumption<extra></extra>"))
    point=sim.dataset.segments["LINE_024"]["position"]
    fig.add_trace(go.Scatter(x=[point[0]],y=[point[1]],mode="markers",name="Known de-energized",
        marker=dict(symbol="x",size=13,color="#d18dbf"),hovertemplate="LINE_024: de-energized; damage unknown<extra></extra>"))
    for drone in sim.drones:
        point=sim.position(drone)
        if drone.status == "flying" and drone.target_asset:
            origin=sim.dataset.segments[drone.origin_asset]["position"]
            dest=sim.dataset.segments[drone.target_asset]["position"]
            fig.add_trace(go.Scatter(x=[origin[0],dest[0]],y=[origin[1],dest[1]],mode="lines",
                line=dict(color="#d7e7ff",dash="dash",width=2),showlegend=False,hoverinfo="skip"))
            fig.add_trace(go.Scatter(x=[origin[0],point[0]],y=[origin[1],point[1]],mode="lines",
                line=dict(color=ACCENT,width=4),showlegend=False,hoverinfo="skip"))
            fig.add_annotation(x=dest[0],y=dest[1],ax=point[0],ay=point[1],xref="x",yref="y",
                axref="x",ayref="y",showarrow=True,arrowhead=3,arrowwidth=2,arrowcolor="#d7e7ff")
        fig.add_trace(go.Scatter(x=[point[0]],y=[point[1]],mode="markers+text",
            marker=dict(symbol="diamond",size=14,color="#f0f6ff",line=dict(color="#122037",width=2)),
            text=[drone.sensor_id.replace("Drone ","D")],textposition="top center",
            name=drone.sensor_id,showlegend=False,
            hovertemplate=f"{drone.sensor_id}<br>{drone.asset_id} · {drone.status}<extra></extra>"))
    for op in _operations(sim):
        if op.get("status") not in {"queued","deferred","inspecting"}:
            continue
        asset=op.get("asset_id")
        if asset not in sim.dataset.segments:
            continue
        point=sim.dataset.segments[asset]["position"]
        inspecting=op["status"]=="inspecting"
        fig.add_trace(go.Scatter(x=[point[0]],y=[point[1]],mode="markers",
            marker=dict(symbol="circle-open",size=29 if inspecting else 22,color=ACCENT if inspecting else "#f1bf6a",line=dict(width=3)),
            name="Inspection" if inspecting else "Waiting task",showlegend=False,
            hovertemplate=f"{asset}<br>{op['status'].title()}<extra></extra>"))
    for color,label in [(ACCENT,"Observed · low anomaly"),("#f1bf6a","Needs investigation"),("#ff8192","Strong anomaly"),("#65758b","Unknown / unobserved")]:
        fig.add_trace(go.Scatter(x=[None],y=[None],mode="lines",line=dict(color=color,width=3),name=label))
    fig.update_layout(height=490,paper_bgcolor=BG,plot_bgcolor=BG,font=dict(color="#dfe9f6"),
        margin=dict(l=5,r=5,t=10,b=5),legend=dict(orientation="h",y=-.08,font=dict(size=10)),
        xaxis=dict(showgrid=False,zeroline=False,title=None),
        yaxis=dict(showgrid=False,zeroline=False,scaleanchor="x",scaleratio=1.5,title=None),
        uirevision="twin-bavaria",dragmode="pan")
    return fig


def signal_chart(sim, asset):
    rows=[r for r in sim.history if r.get("asset_id")==asset]
    fig=make_subplots(rows=4,cols=1,shared_xaxes=True,vertical_spacing=.055,
                      subplot_titles=[v[0] for v in CHANNELS.values()])
    for i,(key,(_,unit)) in enumerate(CHANNELS.items(),1):
        x=[r["observed_at"] for r in rows]
        bands=[r.get("baseline",{}).get(key,{}) for r in rows]
        fig.add_trace(go.Scatter(x=x,y=[b.get("high") for b in bands],mode="lines",line=dict(width=0),
                                showlegend=False,hoverinfo="skip"),row=i,col=1)
        fig.add_trace(go.Scatter(x=x,y=[b.get("low") for b in bands],mode="lines",line=dict(width=0),
                                fill="tonexty",fillcolor="rgba(89,222,199,.12)",showlegend=i==1,
                                name="Healthy reference interval",hoverinfo="skip"),row=i,col=1)
        fig.add_trace(go.Scatter(x=x,y=[b.get("mean") for b in bands],mode="lines",
                                line=dict(color="#809cb8",dash="dash",width=1.4),showlegend=i==1,
                                name="Conditional baseline"),row=i,col=1)
        fig.add_trace(go.Scatter(x=x,y=[r.get(key) for r in rows],mode="lines+markers",connectgaps=False,
                                line=dict(color=ACCENT,width=2),marker=dict(size=3),showlegend=i==1,
                                name="Received synthetic signal"),row=i,col=1)
        fig.update_yaxes(title_text=unit,row=i,col=1)
    fig.update_xaxes(title_text="Exercise minute",row=4,col=1)
    fig.update_layout(height=720,margin=dict(l=15,r=15,t=35,b=15),legend=dict(orientation="h",y=1.1),
                      paper_bgcolor=BG,plot_bgcolor=BG,font=dict(color="#dfe9f6"))
    return fig


def _decision_card(actions):
    if not actions:
        st.info("Await a valid measurement before selecting an asset action.")
        return
    best=actions[0]
    st.markdown(f"### {str(best['action']).replace('_',' ').title()}")
    st.write(best.get("reason",""))
    st.caption(f"Expected loss: {best['expected_loss']:.2f} relative units · review in {best.get('next_check_minutes',5):g} min")


ACTIVE_STAGES = {"queued", "deferred", "flying", "inspecting"}
SEVERITY_RANK = {"critical":3,"high":2,"warning":1}
STAGE_LABELS = {"queued":"Queued", "deferred":"Waiting for safe dispatch", "flying":"Flying to inspect",
                "inspecting":"Collecting inspection evidence", "completed":"Inspection complete",
                "cancelled":"Cancelled", "superseded":"Replaced by new evidence"}


def _operations(sim):
    return list(getattr(sim, "operations", []))


def _active_operations(sim):
    return [op for op in _operations(sim) if op.get("status") in ACTIVE_STAGES]


def _focus_asset(sim, fallback, follow):
    if not follow:
        return fallback
    alerts = getattr(sim, "human_alerts", [])
    opened = [a for a in alerts if a.get("status") == "open"]
    if opened:
        return max(opened, key=lambda a:(SEVERITY_RANK.get(a.get("severity"),0), a.get("created_at", 0)))["asset_id"]
    active = _active_operations(sim)
    if active:
        return max(active, key=lambda o:({"critical":3,"high":2,"routine":1}.get(o.get("priority"),0),
                                        o.get("status") == "inspecting"))["asset_id"]
    return fallback


def mission_timeline(sim):
    """Actual stage transitions; future durations are not painted as completed."""
    colors={"queued":"#65758b","deferred":"#e3ad55","flying":"#75a9ff","inspecting":ACCENT}
    fig=go.Figure()
    for op in _operations(sim)[-10:]:
        label=f"{op['asset_id']} · {op.get('sensor_id') or 'Unassigned'}"
        stages=op.get("stages",[])
        for index,stage in enumerate(stages):
            start=stage.get("minute",op.get("created_at",0))
            end=stages[index+1]["minute"] if index+1<len(stages) else sim.minute
            if stage["status"] not in colors or end<=start:
                continue
            fig.add_trace(go.Bar(x=[end-start],base=[start],y=[label],orientation="h",
                marker_color=colors[stage["status"]],showlegend=False,name=stage["status"],
                hovertemplate=f"{label}<br>{STAGE_LABELS.get(stage['status'],stage['status'])}<br>T+{start} → T+{end}<extra></extra>"))
    for status,color in colors.items():
        fig.add_trace(go.Bar(x=[None],y=[None],orientation="h",marker_color=color,name=STAGE_LABELS[status]))
    fig.update_layout(height=max(240,min(480,100+len(_operations(sim)[-10:])*35)),barmode="overlay",
        margin=dict(l=5,r=15,t=5,b=10),paper_bgcolor=BG,plot_bgcolor=BG,font=dict(color="#dfe9f6"),
        legend=dict(orientation="h",y=1.2,font=dict(size=10)),xaxis=dict(title="Exercise minute",range=[0,max(10,sim.minute+2)]),
        yaxis=dict(autorange="reversed"))
    return fig


def _human_attention(sim):
    alerts=list(getattr(sim,"human_alerts",[]))
    opened=[a for a in alerts if a.get("status")=="open"]
    if opened:
        st.error(f"HUMAN ACTION REQUIRED · {len(opened)} request{'s' if len(opened)!=1 else ''}",icon="🚩")
    elif alerts:
        st.warning(f"{len(alerts)} acknowledged request(s) remain unresolved. Monitoring continues.")
    else:
        st.success("No operator action requested. Automatic monitoring and inspection are enabled." if sim.autonomous
                   else "No operator action requested. Manual control is enabled.")
    for alert in sorted(alerts,key=lambda a:(a.get("status")!="open",-SEVERITY_RANK.get(a.get("severity"),0),-a.get("created_at",0))):
        with st.container(border=True):
            left,right=st.columns([4,1])
            left.markdown(f"**{alert['asset_id']} · {alert.get('title','Operator review required')}**")
            left.write(alert.get("action","Review evidence and decide the field response."))
            left.caption(f"Why: {alert.get('reason','')} · Requested T+{alert.get('created_at',0)} min")
            now=sim.current(alert['asset_id'])
            left.caption(f"Current asset assessment: {now.get('status','Unknown')}. This card tracks a human request awaiting follow-up.")
            if now.get('status')=="Normal":
                left.caption("Recent telemetry is within the normal model. Review whether the earlier field request is still needed; its history remains visible.")
            check=next((o for o in _operations(sim) if o.get("id")==alert.get("operation_id")),None)
            if check:
                left.caption(f"Automatic check: {STAGE_LABELS.get(check['status'],check['status'])}"+
                             (f" · T+{check.get('completed_at')} · result {check['result']}" if check.get("result") else ""))
                if sim.current(alert['asset_id']).get("visual_status")=="stale":
                    left.caption("That inspection is historical; current BN inference uses fresh telemetry. Human follow-up is still outstanding.")
            if alert.get("status")=="open":
                if right.button("Acknowledge",key=f"tw_ack_{alert['id']}"):
                    sim.acknowledge_alert(alert["id"]);st.rerun()
            else:
                right.markdown("**Acknowledged**")
                right.caption("Awaiting human follow-up")


def _task_card(op, minute):
    with st.container(border=True):
        st.markdown(f"**{op['asset_id']} · {STAGE_LABELS.get(op.get('status'),op.get('status','Queued'))}**")
        drone=op.get("sensor_id") or "Awaiting assignment"
        route=f"{op.get('origin_asset')} → {op['asset_id']}" if op.get("origin_asset") and op["origin_asset"]!=op["asset_id"] else "On-site check · no flight needed"
        st.caption(f"{drone} · {route}")
        explanation=op.get("decision_explanation") or {}
        if explanation.get("why_drone"):
            st.caption(str(explanation["why_drone"]))
        progress=float(op.get("progress",0) or 0)
        st.progress(min(1.,max(0.,progress/100 if progress>1 else progress)))
        due=op.get("inspection_due_at") if op.get("status")=="inspecting" else op.get("arrival_at")
        if due is not None and op.get("status") in {"flying","inspecting"}:
            st.caption(f"{'Result' if op['status']=='inspecting' else 'Arrival'} in {max(0,due-minute):g} min · T+{due:g}")
        stages=op.get("stages",[])
        reason=stages[-1].get("reason") if stages else None
        st.write(reason or op.get("reason",""))
        with st.expander("Why this task / this drone"):
            st.write(explanation.get("why_location") or op.get("selection_reason",op.get("reason","")))
        if op.get("status")=="deferred":
            st.caption("Re-evaluated every exercise minute; delays can trigger an operator request.")


def _fleet_cards(sim):
    for col,drone in zip(st.columns(5),sim.drones):
        op=next((o for o in _active_operations(sim) if o.get("sensor_id")==drone.sensor_id),None)
        status={"queued":"Queued","deferred":"Waiting","flying":"In flight","inspecting":"Inspecting"}.get(op.get("status"),drone.status.title()) if op else drone.status.title()
        current=_assessment(sim,drone.asset_id)
        wait=max(0,(drone.charge_ready_at or sim.minute)-sim.minute)
        detail=f"Recharge · {wait:g} min left" if drone.needs_charge and drone.status!="flying" else "Available for flight"
        if drone.status=="charging" and drone.charge_ready_at is None:
            detail="Charging paused · energized record required"
        if drone.status=="flying":
            place=f"{drone.origin_asset} → {drone.target_asset}"
            detail=f"Arrival in {max(0,drone.arrival_at-sim.minute)} min"
            speed=getattr(drone,"speed_mps",None) or (op or {}).get("flight_speed_mps")
            if speed:detail+=f" · {speed:g} m/s"
        else:
            place=drone.asset_id
            if not op and drone.status=="perched":status="Monitoring"
            if op and op.get("status")=="inspecting":
                detail=f"Result in {max(0,(op.get('inspection_due_at') or sim.minute)-sim.minute)} min" + (f" · recharge {wait:g} min" if drone.needs_charge else "")
        quality=("Transit data degraded · inspect after landing" if drone.status=="flying" else
                 "No current asset reading" if current.get("anomaly") is None else current.get("status","Unknown"))
        color="#75a9ff" if drone.status=="flying" else ACCENT if op and op.get("status")=="inspecting" else "#9eb2cb"
        col.markdown(f'<div class="tw-device" style="border-top:3px solid {color}"><small>{escape(drone.sensor_id)}</small><br><strong>{escape(status)}</strong><p>{escape(place)}</p><small>{escape(detail)}<br>{escape(quality)}</small></div>',unsafe_allow_html=True)


def _selected_summary(sim, selected):
    info=_assessment(sim,selected)
    st.subheader(selected)
    st.markdown(f"**{info.get('status','Unknown')}**")
    if info.get("anomaly") is None or info.get("status")=="Unknown":
        st.info("No fresh direct measurement. Asset condition remains unknown.")
    else:
        st.caption(f"Model anomaly probability {info['anomaly']:.0%} · illustrative, uncalibrated")
        strongest=sorted(info.get("evidence",[]),key=lambda e:abs(e.get("z",0)),reverse=True)[:2]
        for e in strongest:
            label,unit=CHANNELS.get(e["channel"],(e["channel"],""))
            st.write(f"{label}: **{e['observed']:.2f} {unit}**")
            st.caption(f"Expected {e['expected']:.2f} · deviation {e['z']:+.1f} normal standard deviations")
    tasks=[o for o in _operations(sim) if o.get("asset_id")==selected]
    if tasks:
        op=tasks[-1]
        st.write(f"**System action:** {STAGE_LABELS.get(op['status'],op['status'])}")
        st.caption(op.get("selection_reason",op.get("reason","")))
        if op.get("result"):
            st.write(f"Inspection at T+{op.get('completed_at')}: **{op['result']}**")
            if info.get("visual_status")=="stale":st.caption("Past inspection expired for current inference; current telemetry is evaluated separately.")
        if op.get("outcome"):st.caption(str(op["outcome"]))
    elif not sim.autonomous and info.get("anomaly") is not None:
        _decision_card(sim.recommendations.get(selected,[]))
    if selected in sim.latest:
        st.caption(f"Last measurement T+{sim.latest[selected]['observed_at']:.1f} · now T+{sim.minute}")
    st.caption("Open Evidence & baseline for measurements; Decision network for assumptions and cost tradeoffs.")


def _latest_replan(sim):
    plans=list(getattr(sim,"replans",[]))
    useful=[p for p in plans if p.get("decisions")]
    plan=(useful or plans)[-1] if plans else None
    if plan:
        with st.container(border=True):
            st.markdown(f"**Latest plan change · T+{plan['minute']}**")
            st.write(plan.get("summary") or plan.get("trigger","New received evidence"))
            st.caption("Trigger: "+str(plan.get("trigger","Received evidence update")))
            for change in plan.get("decisions",[])[:3]:
                previous=change.get("previous_sensor_id")
                unit=change.get("sensor_id") or "Awaiting an eligible drone"
                assignment=f"{previous} → {unit}" if previous and previous!=change.get("sensor_id") else unit
                st.write(f"{str(change.get('action','Re-evaluate')).replace('_',' ').title()} · **{change.get('asset_id','')}** · {assignment}")
                if change.get("reason"):st.caption(str(change["reason"]))
    else:
        st.caption("Rolling scheduler · received evidence, inspection results, weather and recharge state are reviewed as the exercise clock advances.")


def _explain_assignment(sim):
    operations=_operations(sim)
    if not operations:
        return
    st.subheader("Why this assignment? What did the check find?")
    ids=["Follow latest decision"]+[o["id"] for o in operations[::-1]]
    labels={o["id"]:f"{o['id']} · {o['asset_id']} · {STAGE_LABELS.get(o['status'],o['status'])}" for o in operations}
    pick=st.selectbox("Explain assignment",ids,format_func=lambda x:labels.get(x,x),key="tw_explain")
    if pick=="Follow latest decision":
        op=None
        for plan in reversed(getattr(sim,"replans",[])):
            for change in reversed(plan.get("decisions",[])):
                oid=change.get("operation_id",change.get("op_id"))
                op=next((o for o in operations if o["id"]==oid),None)
                if op:break
            if op:break
        op=op or operations[-1]
    else:
        op=next(o for o in operations if o["id"]==pick)
    explanation=op.get("decision_explanation") or {}
    with st.container(border=True):
        st.markdown(f"**{op['asset_id']} · {op.get('sensor_id') or 'Awaiting assignment'} · {STAGE_LABELS.get(op['status'],op['status'])}**")
        location=drone=findings=st.container()
        location.markdown("**Why this location**")
        location.write(explanation.get("why_location") or op.get("selection_reason",op.get("reason","")))
        drone.markdown("**Why this drone**")
        drone.write(explanation.get("why_drone") or "Assignment is being evaluated against all five drones.")
        speed=op.get("flight_speed_mps")
        if speed:
            drone.caption(f"Transit {speed:g} m/s · maximum 60 m/s. Stable inspection is collected after arrival.")
        findings.markdown("**Finding → next action**")
        if op.get("result"):
            findings.write(f"T+{op.get('completed_at')} · **{op['result']}**")
            findings.write(op.get("finding") or op.get("outcome") or "Evidence received; current beliefs recalculated.")
            before,after=op.get("posterior_before"),op.get("posterior_after")
            if before is not None and after is not None:
                findings.caption(f"Same-window model anomaly: {before:.1%} → {after:.1%}. This is the historical inspection update.")
        else:
            findings.write("No inspection result yet. " + str(op.get("reason","")))
        findings.caption(op.get("next_action") or op.get("outcome") or "Await the next received observation and feasibility review.")
        alerts=[a for a in sim.human_alerts if a['asset_id']==op['asset_id']]
        if alerts:
            findings.warning("Human follow-up outstanding")
        elif op.get("human_required"):
            findings.warning("Human review requested")
        else:
            findings.caption("No human request attached to this asset at this time.")
        candidates=explanation.get("candidates",[])
        if candidates:
            with st.expander("Compare all five drones · eligibility, travel and coverage tradeoff",expanded=op.get("status") in {"queued","deferred"}):
                rows=[]
                for row in candidates:
                    st.caption(f"{row.get('sensor_id')}: {'Eligible' if row.get('eligible') else 'Blocked'} — {row.get('reason','')}")
                    duration=row.get("flight_minutes")
                    score=row.get("score")
                    rows.append({"Drone":row.get("sensor_id"),"From":row.get("origin_asset"),
                        "Eligible":bool(row.get("eligible")),"Flight min":"—" if duration is None else f"{duration:g}",
                        "Ready at":"—" if row.get("ready_at") is None else f"T+{row['ready_at']:g}",
                        "Transit m/s":f"{row.get('flight_speed_mps',0):g}",
                        "Score":"—" if score is None else f"{score:.2f}","Reason":str(row.get("reason",""))})
                st.dataframe(pd.DataFrame(rows),use_container_width=True,hide_index=True)
                st.caption(f"Decision snapshot T+{explanation.get('chosen_at',op.get('updated_at'))}. Scores compare eligible options under the demonstration policy; unknown condition is retained as unknown.")
                st.caption("Lower travel/coverage score wins among eligible drones. Task priority is evaluated separately from drone-selection score.")


def render_twin():
    if "tw_sim" not in st.session_state or not hasattr(st.session_state["tw_sim"],"assessment_history"):
        reset_twin(st.session_state)
    sim=st.session_state["tw_sim"]
    st.markdown("""<style>
    .block-container {max-width:1550px;padding-top:1.4rem;}
    div[data-testid="stMetric"]{background:#101e30;border:1px solid #263b50;border-radius:12px;padding:12px;}
    .tw-device{background:#101e30;border:1px solid #263b50;border-radius:12px;padding:12px;min-height:165px;}
    .tw-device small{color:#adbed4;} .tw-device strong{font-size:16px;} .tw-device p{font-size:12px;margin:8px 0;}
    .tw-eyebrow{font-size:11px;letter-spacing:2px;color:#59dec7;margin-bottom:6px;}
    @media(max-width:950px){div[data-testid="stMetricValue"]{font-size:24px;}button p{font-size:12px!important;}.tw-device{min-height:160px;padding:10px 8px;}.tw-device strong{font-size:14px;}.tw-device small{font-size:11px;}}
    @media(max-width:1100px){div[data-testid="stHorizontalBlock"]:has(.tw-device){flex-wrap:wrap;}div[data-testid="stHorizontalBlock"]:has(.tw-device)>div[data-testid="stColumn"]{min-width:130px;flex:1 1 130px;}}
    </style>""",unsafe_allow_html=True)
    st.markdown('<div class="tw-eyebrow">NOMADIC CHALLENGE / BAVARIA</div>',unsafe_allow_html=True)
    st.title("GridScout · Mission control")
    st.caption("SYNTHETIC EXERCISE · Observe → replan → inspect → update the decision")
    with st.sidebar:
        st.subheader("Mission control")
        st.session_state.setdefault("tw_auto",sim.autonomous)
        autonomous=st.toggle("Automatic dispatch & inspection",key="tw_auto")
        if autonomous!=sim.autonomous:
            sim.set_autonomous(autonomous)
        st.caption("Automatic mode chooses targets, executes simulated inspections and raises human requests. When switched off, flights and inspections underway finish; queued tasks wait.")
        st.session_state.setdefault("tw_follow",True)
        follow=st.checkbox("Follow priority asset",key="tw_follow")
        st.subheader("Scenario controls")
        scenario=st.selectbox("Synthetic scenario",list(SCENARIOS),format_func=lambda x:SCENARIOS[x],
                              index=list(SCENARIOS).index(sim.scenario),key="tw_scenario")
        st.session_state.setdefault("tw_seed",sim.seed)
        seed=st.number_input("Scenario seed",0,100000,value=None,key="tw_seed")
        st.button("Apply scenario & reset",use_container_width=True,on_click=lambda:
            reset_twin(st.session_state,st.session_state["tw_scenario"],int(st.session_state["tw_seed"] or 0)))
        if "dynamic" in SCENARIOS:
            st.button("Load dynamic mission",use_container_width=True,on_click=lambda:
                reset_twin(st.session_state,"dynamic",int(st.session_state["tw_seed"] or 0)))
        if st.button("Advance to next decision",use_container_width=True,disabled=sim.minute>=240):
            for _ in range(min(30,240-sim.minute)):
                count=len(getattr(sim,"replans",[]))
                before=[(o['id'],o['status']) for o in _operations(sim)]
                sim.step()
                if before!=[(o['id'],o['status']) for o in _operations(sim)]:break
                if len(getattr(sim,"replans",[]))>count and sim.replans[-1].get("decisions"):break
            st.rerun()
        st.caption("Next decision advances at most 30 exercise minutes and stops at a task or assignment change.")
        st.caption("30 min flight limit · 180 min recharge after each flight · 240 min exercise. Charging and perched observation overlap.")
        st.caption("Maximum flight speed 60 m/s (216 km/h), provided by sponsor. Cruise speed is selected by the demo policy; high-speed transit reduces sensing quality. Line diagnosis uses stationary observations.")
        st.caption("Accelerated playback: one 60-second feature window every 2 seconds. All four streams are simulated.")
        assets=sorted(sim.dataset.segments)
        selected_asset=st.selectbox("Inspect asset",assets,index=assets.index(sim.drones[0].asset_id),key="tw_asset",
            on_change=lambda:st.session_state.update(tw_follow=False))
        if follow:st.caption("Main view follows an open alert or active inspection. Turn off Follow priority asset to explore a selected line.")
        with st.expander("Payload assumptions"):
            st.write("Current platform: 3.8 kg. Additional integrated payload budget ≤250 g: 200 g allocated, 50 g reserve.")
            st.write("Optional ambient temperature/humidity and RGB, thermal or combined inspection. Tilt measures relative orientation; voltage is an energization proxy. Charging power is a separate site assumption.")
    cols=st.columns([1,1,1,1,1.3])
    if cols[0].button("Pause stream" if st.session_state["tw_playing"] else "Play stream",use_container_width=True):
        st.session_state["tw_playing"]=not st.session_state["tw_playing"];st.rerun()
    if cols[1].button("Advance 1 min",use_container_width=True,disabled=sim.minute>=240):
        sim.step();st.rerun()
    if cols[2].button("Advance 5 min",use_container_width=True,disabled=sim.minute>=240):
        sim.step(5);st.rerun()
    if cols[3].button("Jump to 55 min",use_container_width=True,disabled=sim.minute>=55):
        sim.advance_to(55);st.rerun()
    cols[4].button("Reset stream",use_container_width=True,on_click=lambda:
        reset_twin(st.session_state,sim.scenario,sim.seed))

    @st.fragment(run_every="2s" if st.session_state["tw_playing"] else None)
    def live_fragment():
        if st.session_state["tw_playing"] and sim.minute<240:
            sim.step()
        selected=_focus_asset(sim,selected_asset,follow)
        live,evidence,network,weather,audit=st.tabs(["Live operations","Evidence & baseline","Decision network","Weather & provenance","Audit & comparison"])
        info=_assessment(sim,selected)
        with live:
            metrics=st.columns(4)
            metrics[0].metric("Exercise clock",f"T+{sim.minute:03d} min")
            metrics[1].metric("Human requests",sum(a.get("status")=="open" for a in sim.human_alerts))
            fresh=sum("unknown" not in str(_assessment(sim,d.asset_id).get("status","Unknown")).lower() and d.status!="flying" for d in sim.drones)
            metrics[2].metric("Fresh observed sites",f"{fresh} / {len(sim.dataset.segments)}")
            metrics[3].metric("Active tasks",len(_active_operations(sim)))
            st.caption(f"{'AUTOMATIC' if sim.autonomous else 'MANUAL'} · {'Replay running' if st.session_state['tw_playing'] else 'Replay paused — Play stream starts the clock'} · {len(sim.dataset.segments)-fresh} sites lack fresh direct evidence")
            _human_attention(sim)
            outlook=getattr(sim,"weather_decision",{})
            if outlook:
                st.caption(f"Gust {sim.weather.get('gust_mps',0):.1f} m/s · {len(sim.weather.get('warnings',[]))} weather warning(s) · "+str(outlook.get("reason","")))
            _fleet_cards(sim)
            _latest_replan(sim)
            mapcol,actioncol=st.columns([2.5,1])
            with mapcol:
                st.plotly_chart(twin_map(sim,selected),use_container_width=True,key="tw_map")
                st.caption("Dashed arrow = planned flight · cyan path = travelled · ring = queued / inspecting · gray = unknown · squares = assumed charging sites. © OpenStreetMap contributors · ODbL 1.0. Map lines show geographic geometry; electrical connectivity is unknown.")
            with actioncol:
                _selected_summary(sim,selected)
            _explain_assignment(sim)
            active=_active_operations(sim)
            st.subheader("Inspection progress")
            if active:
                for start in range(0,len(active),3):
                    for col,op in zip(st.columns(3),active[start:start+3]):
                        with col:_task_card(op,sim.minute)
            elif sim.minute==0 and sim.autonomous:
                st.info("Press Play stream or Advance 1 min. The scheduler will assess report coverage and begin feasible tasks.")
            else:
                st.info("No inspection currently in progress. Monitoring continues; completed checks are recorded below.")
            if _operations(sim):
                with st.expander("Mission history · flights, inspection results and decisions",expanded=True):
                    st.plotly_chart(mission_timeline(sim),use_container_width=True,key="tw_timeline")
                    completed=sorted((o for o in _operations(sim) if o.get("status")=="completed"),key=lambda o:o.get("completed_at",0))
                    for op in completed[-5:][::-1]:
                        st.write(f"**T+{op.get('completed_at',0)} · {op['asset_id']} · {op.get('sensor_id','')}** — {op.get('result','Completed')}")
                        st.caption(str(op.get("outcome") or op.get("reason","")))
            with st.expander("Manual controls · pause automatic mode before overriding"):
                st.caption("Manual controls select a synthetic inspection outcome. RGB, thermal and combined inspection are optional demo capabilities.")
                visual=st.selectbox("Synthetic inspection result",["supports","clear","inconclusive"],key="tw_visual")
                modality=st.selectbox("Optional inspection modality",["rgb","thermal","combined"],key="tw_inspection_modality")
                visibility=st.selectbox("Inspection visibility",["clear","limited","poor","obscured"],key="tw_inspection_visibility")
                quality=st.selectbox("Inspection quality",["valid","suspect"],key="tw_inspection_quality")
                stationed=any(d.asset_id==selected and d.status!="flying" for d in sim.drones)
                if st.button("Collect synthetic inspection",disabled=sim.autonomous or not stationed):
                    sim.verify(selected,visual,modality=modality,visibility=visibility,quality=quality);st.rerun()
                c1,c2=st.columns(2)
                drone_id=c1.selectbox("Drone",[d.sensor_id for d in sim.drones],key="tw_move_drone")
                targets=sim.available_targets(drone_id)
                target=c2.selectbox("Eligible destination",targets or ["No feasible destination"],key="tw_destination")
                speed=st.slider("Transit speed · m/s",5,60,20,5,key="tw_manual_speed")
                if st.button("Dispatch relocation",disabled=sim.autonomous or not targets):
                    try:sim.relocate(drone_id,target,speed_mps=speed)
                    except ValueError as exc:st.error(str(exc))
                    else:st.rerun()
                st.caption("Eligible destinations have assumed energized lines and sufficient charging power. LINE_024 is de-energized. Flight feasibility uses the scenario wind envelope.")
        with evidence:
            st.subheader(f"{selected} · observations against normal conditions")
            st.caption(f"Frozen baseline {sim.baseline.version} · healthy synthetic fit · band: conditional healthy reference. Unknown operation uses the envelope of both state intervals.")
            if selected in sim.latest:
                st.plotly_chart(signal_chart(sim,selected),use_container_width=True,key="tw_signals")
                if info.get("evidence"):st.dataframe(pd.DataFrame(info["evidence"]),use_container_width=True,hide_index=True)
                if info.get("missing"):st.warning("Missing or unusable evidence: "+", ".join(map(str,info["missing"])))
            else:st.info("This asset has no direct observation. Relocate a device to an eligible site to collect evidence.")
        with network:
            render_probability_explanation(sim,selected)
            st.divider()
            costs=dict(DEFAULT_COSTS)
            st.write("**Cost sensitivity preview · relative loss units**")
            st.caption("Evaluation scope: the table uses the costs and inspection assumptions selected below. Automatic dispatch uses default costs, RGB / clear / valid inspection assumptions and scheduling rules.")
            if "field_check" in costs:
                costs["field_check"]=st.slider("Field verification cost",1.0,100.0,float(costs["field_check"]),key="tw_field_cost")
            if "false_positive" in costs:
                costs["false_positive"]=st.slider("Unnecessary field escalation cost",0.0,200.0,float(costs["false_positive"]),key="tw_fp_cost")
            modality_col,visibility_col,quality_col=st.columns(3)
            inspection={
                "modality":modality_col.selectbox("Review modality",["rgb","thermal","combined"],key="tw_cost_review_modality"),
                "visibility":visibility_col.selectbox("Review visibility",["clear","limited","poor","obscured"],key="tw_cost_review_visibility"),
                "quality":quality_col.selectbox("Review quality",["valid","suspect","invalid"],key="tw_cost_review_quality")}
            actions=recommend_actions(info,costs=costs,inspection=inspection) if info.get("anomaly") is not None else []
            st.dataframe(pd.DataFrame(actions),use_container_width=True,hide_index=True)
            with st.expander("Joint hypotheses and model assumptions"):
                st.dataframe(pd.DataFrame(info.get("joint_states",[])),use_container_width=True,hide_index=True)
                st.write("BN variable dependencies are specified manually. Healthy synthetic records fit the normal baseline. Failure priors, abnormal likelihoods, inspection accuracy, costs and the weather envelope are scenario assumptions. Temperature conditions on weather and uncertain load; voltage depends on energization and sensor health. Known energization is fixed; unknown energization is marginalized. Sensor issues may coexist with asset faults.")
        with weather:
            st.subheader("Weather observation, forecast and warning lifecycle")
            st.caption("Synthetic weather observations, forecasts and warnings follow the exercise clock and use DWD-compatible fields.")
            forecast=sim.weather.get("forecast",{})
            wc=st.columns(3)
            wc[0].metric("Ambient temperature",f"{sim.weather.get('ambient_c',0):.1f} °C")
            wc[1].metric("Forecast gust",f"{forecast.get('gust_mps',0):.1f} m/s")
            wc[2].metric("Load information","Unknown" if sim.weather.get("load_pu") is None else f"{sim.weather['load_pu']:.2f} p.u.")
            st.write("**Active warnings**")
            if sim.weather.get("warnings"):st.dataframe(pd.DataFrame(sim.weather["warnings"]),use_container_width=True,hide_index=True)
            else:st.info("No active weather warning at this exercise time.")
            st.write("**Received messages · including updates and cancellations**")
            st.dataframe(pd.DataFrame(sim.weather.get("messages",[])),use_container_width=True,hide_index=True)
            st.json(forecast,expanded=False)
            st.caption("Messages become available on receipt. Same-event forecasts and warnings share weather context. Warning cancellation updates weather status; sensor observations retain their own evidence.")
        with audit:
            st.subheader("Every observation and action leaves a trace")
            st.download_button("Export twin evidence JSON",json.dumps(sim.export(),ensure_ascii=False,indent=2),
                               "gridscout_twin_evidence.json","application/json",key="tw_export")
            st.dataframe(pd.DataFrame(sim.audit[-100:]),use_container_width=True,hide_index=True)
            with st.expander("Replanning history · received triggers and changed assignments"):
                for plan in list(getattr(sim,"replans",[]))[-15:][::-1]:
                    st.write(f"**T+{plan['minute']} · {plan.get('trigger','Update')}**")
                    st.caption(plan.get("summary",""))
                    for decision in plan.get("decisions",[]):st.write(str(decision.get("reason") or decision))
            if st.button("Compare synthetic scenarios",key="tw_compare"):
                rows=[]
                for code,label in SCENARIOS.items():
                    other=TwinSimulation(scenario=code,seed=sim.seed);other.advance_to(55)
                    for drone in other.drones:
                        outcome=other.current(drone.asset_id)
                        choices=other.recommendations.get(drone.asset_id,[])
                        rows.append({"Scenario":label,"Drone":drone.sensor_id,"Status":outcome.get("status"),
                            "Model anomaly":outcome.get("anomaly"),"Sensor issue":outcome.get("sensor_fault"),
                            "Recommended action":choices[0]["action"] if choices else "Await data"})
                st.session_state["tw_comparison"]=rows
            if st.session_state.get("tw_comparison"):
                st.dataframe(pd.DataFrame(st.session_state["tw_comparison"]),use_container_width=True,hide_index=True)
            st.caption("Comparison measures model behavior on synthetic scenarios at the same seed and exercise time.")
    live_fragment()
