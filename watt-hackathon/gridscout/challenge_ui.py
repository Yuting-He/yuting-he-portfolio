"""Official challenge dashboard, separate from the synthetic service laboratory."""
from dataclasses import asdict
import json

import pandas as pd
import streamlit as st

from .challenge import (ChallengeConfig, POLICIES, action_advice, advance_challenge,
                        create_challenge, export_challenge, recommend_challenge, run_challenge, set_charging_site)
from .challenge_visualization import official_map, mission_timeline
from .official_data import CHALLENGE_URL, DATA_DIRECTORY, choose_sites, load_official_dataset
from .visualization import severity_figure, probability_change_figure


def reset_official(session, config=None, dataset=None):
    """Construct first, then atomically remove derived mission/evidence/export state."""
    fresh=create_challenge(config,dataset)
    for key in list(session):
        if str(key).startswith("oc_"):
            del session[key]
    session["oc_state"]=fresh
    session["oc_version"]=1


@st.cache_resource
def _dataset():
    return load_official_dataset()


def _site_label(site):
    return "Eligible" if site.can_charge else "Unavailable" if (
        site.energized is False or site.sufficient_power is False) else "Unknown"


def render_official():
    dataset=_dataset()
    if "oc_state" not in st.session_state or st.session_state.get("oc_version")!=1:
        reset_official(st.session_state,dataset=dataset)
    state=st.session_state["oc_state"]
    st.markdown("""<style>
    .block-container {max-width:1500px; padding-top:2.5rem;}
    h1 {letter-spacing:-.04em;} [data-testid="stMetric"] {background:#142438; padding:14px; border-radius:10px;}
    [data-testid="stMetricLabel"] p {white-space:normal; overflow:visible;}
    [data-testid="stButton"] p {white-space:normal;}
    </style>""",unsafe_allow_html=True)
    st.title("GridScout · Bavaria Operations")
    st.caption("OFFICIAL CHALLENGE MAP · FICTIONAL STORM REPORTS · HYPOTHETICAL SENSOR READINGS · OFFLINE")
    st.write("Deploy five mobile sensors, collect better evidence, and preserve the ability to move again.")
    with st.sidebar:
        st.subheader("Official mission control")
        policy=st.selectbox("Planning policy",POLICIES,key="of_policy")
        st.write("**5 sensors · ≤30 min per flight**")
        st.write("**180 min charge after every flight**")
        st.caption("Charging requires both an energized line and sufficient power. A short flight still requires the full charging interval.")
        st.progress(min(1,state.time/state.config.mission_minutes),
                    text=f"{state.time:.1f} / {state.config.mission_minutes:.0f} mission minutes")
        st.caption("Sensors start fully charged and already perched at their declared starting sites. Perched measurement may overlap charging.")
        st.caption("Map lines show geographic geometry. Electrical connectivity, customer supply and outage totals are unknown.")
    live,reports,decision,audit,settings=st.tabs([
        "Live Operations","Initial Reports","Decision & Evidence","Mission Audit","Scenario Configuration"])
    recommendations=recommend_challenge(state,policy)
    target=recommendations[0] if recommendations else None
    with live:
        cols=st.columns(4)
        ask=cols[0].button("Recommend Next Inspection",use_container_width=True)
        execute=cols[1].button("Execute Inspection",disabled=state.finished,use_container_width=True)
        auto=cols[2].button("Auto-Run Mission",disabled=state.finished,use_container_width=True)
        reset=cols[3].button("Reset Scenario",use_container_width=True)
        if reset:
            reset_official(st.session_state,state.config,dataset); st.rerun()
        override=st.selectbox("Hypothetical next report",["Seeded demonstration","Positive","Negative","Inconclusive"],key="of_reading")
        st.caption("Manual selection sets the first report of the next observation event. All other reports and Auto-Run use seeded hypothetical examples.")
        if execute:
            for _ in range(1000):
                events=advance_challenge(state,policy,None if override=="Seeded demonstration" else override)
                if state.finished or any(e["type"]=="hypothetical_reading" for e in events):
                    break
            else:
                raise RuntimeError("No observation event within mission bound")
            st.rerun()
        if auto:
            with st.spinner("Simulating flight, measurements and charging events…"):
                run_challenge(state,policy)
            st.rerun()
        if ask:
            st.success(f"Next target: {target.action.line_id} · {target.action.sensor_id}" if target else
                       "No immediately feasible inspection; advance to the next flight or charging event.")
        cards=st.columns(4)
        cards[0].metric("Official mapped lines",len(dataset.segments))
        cards[1].metric("Initial reports available",len(dataset.reports))
        cards[2].metric("Lines with example readings",len({r.line_id for r in state.readings}))
        cards[3].metric("Completed flights",sum(s.flight_count for s in state.sensors))
        mapcol,side=st.columns([3,1.15])
        with mapcol:
            show=st.checkbox("Show approximate report areas",value=True,key="of_report_areas")
            st.plotly_chart(official_map(state,target.action.line_id if target else None,show),
                            use_container_width=True,key="official_map",
                            config={"displayModeBar":True,"scrollZoom":True})
            st.caption("© OpenStreetMap contributors · adapted organizer dataset, ODbL 1.0. Offline WGS84 map. Color = illustrative anomaly belief; squares = assumed charging sites; × = known de-energized LINE_024.")
        with side:
            st.subheader("Next evidence")
            if target:
                st.write(f"**{target.action.sensor_id} → {target.action.line_id}**")
                st.write(f"Modeled anomaly probability: {target.probability:.1%}")
                st.write(f"Flight {target.action.flight_minutes:.1f} min · measurement {state.config.inspection_minutes:g} min")
                st.caption("Current site measurement" if not target.action.is_flight else (
                    "Charging possible at destination under a demo assumption" if target.can_charge else
                    "Terminal visit: departure requires charging eligibility and a completed 180 min charge"))
            elif state.finished:
                st.info("Mission ended. Inspect the event audit or reset.")
            else:
                st.info("No sensor ready to move. Advance the next event to resolve arrival or charging.")
            for sensor in state.sensors:
                st.write(f"**{sensor.sensor_id}** · {sensor.line_id}")
                st.caption(sensor.status.replace("_"," ") + (
                    f" · charge ready at {sensor.charge_ready_at:.1f} min" if sensor.charge_ready_at is not None else ""))
        if st.button("Advance Next Event",disabled=state.finished):
            advance_challenge(state,policy); st.rerun()
        if state.readings:
            st.dataframe(pd.DataFrame(asdict(r) for r in state.readings),hide_index=True,use_container_width=True)
        st.info("LINE_024 is officially reported de-energized; its damage state is unknown. Other energization and charging-power states are explicit assumptions or unknown.")

    with reports:
        st.subheader("Six organizer reports · all available at mission start")
        st.write("The line map comes from real mapping data. This windstorm and every initial report are fictional exercise material. Approximate areas can intersect several lines.")
        st.dataframe(pd.DataFrame(dataset.reports)[["information_id","information_type","timestamp_relative_to_storm","confidence","source"]],
                     hide_index=True,use_container_width=True)
        for report in dataset.reports:
            key=report["information_id"]
            with st.expander(f"{key} · {report['information_type']}"):
                st.write(report["description"])
                st.caption(f"Source: {report['source']} · original relative timestamp {report['timestamp_relative_to_storm']}")
                matches=[key2 for key2,row in dataset.segments.items() if key in row["report_ids"]]
                st.write(f"Geographically intersecting segments ({len(matches)}): "+", ".join(matches))
                st.caption("Spatial overlap selects candidate lines for investigation.")
        st.markdown("[Official challenge document]("+CHALLENGE_URL+")")
        with st.expander("Organizer map overview and original README"):
            st.image(str(DATA_DIRECTORY/"network_map.png"),caption="Organizer's original overview map")
            st.markdown((DATA_DIRECTORY/"README.md").read_text(encoding="utf-8"))

    with decision:
        st.subheader("Why inspect here, and what would change the plan?")
        st.caption("A report-informed heuristic ranks inspections by modeled anomaly probability, information gain and collection time.")
        if target:
            st.write(f"**{target.action.sensor_id} → {target.action.line_id}** · {target.probability:.1%} modeled anomaly probability")
            st.write(f"Relevant initial reports: {', '.join(target.report_ids) or 'Broad weather context only'}. Expected shared-zone information gain: {target.information_gain:.4f} bits.")
            st.write(f"Travel {target.action.flight_minutes:.1f} minutes; observation completes at {target.action.finish:.1f}. "+(
                f"After flight, earliest next departure is {target.action.arrival+180:.1f} minutes if charging power remains available."
                if target.action.is_flight else "This is a perched measurement at the sensor's current site."))
            st.dataframe(pd.DataFrame([{"Rank":i+1,"Line":r.action.line_id,"Sensor":r.action.sensor_id,
                "Model P(anomaly)":r.probability,"Zone information (bits)":r.information_gain,
                "Flight (min)":r.action.flight_minutes,"Charging eligible":r.can_charge,"Score":r.score}
                for i,r in enumerate(recommendations[:5])]),hide_index=True,use_container_width=True)
        else:
            st.info("No immediately feasible candidate. Sensors may be charging, flying, or unable to find an eligible landing site.")
        st.latex(r"\mathrm{score}=\frac{\widehat{P(\mathrm{anomaly})}+\beta\widehat{IG(\mathrm{zone})}}{t_{\mathrm{flight}}+t_{\mathrm{measurement}}}")
        st.caption("The denominator is collection time, with charging enforced as a scheduling constraint. Risk-only uses anomaly probability. Random uses reproducible keyed draws. Geographic severity bands define the assumed correlations between lines.")
        with st.expander("Initial prior assumptions and report interpretation"):
            st.write("Weather report 01 sets a pedagogical Low/Medium/High severity prior (0.10, 0.35, 0.55). Reports 02–06 contribute weak log-odds offsets 0.35, 0.20, 0.10, 0.30, 0.25 to spatially intersecting lines, once at reset. Conditional anomaly probability is sigmoid(−3.4 + 1.1 × severity index + offsets). These coefficients and the sensor accuracy are demonstration assumptions.")
            st.write("Energization and physical anomaly are separate states. Inconclusive reports retain the prior beliefs. One local follow-up is allowed, including during charging.")
        if state.evidence:
            index=st.selectbox("Hypothetical evidence event",range(len(state.evidence)),index=len(state.evidence)-1,
                format_func=lambda i:f"{i+1}. {state.evidence[i]['reading'].line_id} · {state.evidence[i]['reading'].result}")
            event=state.evidence[index]; reading=event["reading"]
            st.info(f"{reading.source}: {reading.result} on {reading.line_id} at {reading.time:.1f} min.")
            st.write(f"Model probability: {event['prior_probability']:.1%} → {event['posterior_probability']:.1%}")
            cols=st.columns(2)
            cols[0].plotly_chart(severity_figure(event["prior_zone"],event["posterior_zone"],event["zone"]+" geographic severity"),use_container_width=True)
            changes=pd.DataFrame([{"Line":key,"Before":event["before_probabilities"][key],"After":event["after_probabilities"][key]}
                for key,zone in state.beliefs.line_zones.items() if zone==event["zone"]])
            cols[1].plotly_chart(probability_change_figure(changes),use_container_width=True)
            label,reason=action_advice(state,reading.line_id)
            st.write(f"**Operator decision: {label}.** {reason}")
        else:
            st.info("Collect a hypothetical report to show Bayesian evidence and operator advice.")

    with audit:
        st.subheader("Flight and charging audit")
        st.plotly_chart(mission_timeline(state),use_container_width=True)
        st.caption("Bars show elapsed time up to the current mission minute. Charging requires a powered perch and may overlap measurement. A full charging interval must finish within the mission to count as completed.")
        flights=[e for e in state.history if e["type"]=="flight_start"]
        st.write(f"{len(flights)} flight assignments · maximum scheduled flight {max((e['flight_minutes'] for e in flights),default=0):.2f} minutes · flight limit 30 minutes.")
        st.dataframe(pd.DataFrame(state.history),hide_index=True,use_container_width=True)
        st.write("**Official-case evaluation:** completed investigations, flight feasibility and evidence trace. The Synthetic laboratory provides paired strategy benchmarks against simulated ground truth.")
        payload=export_challenge(state)
        st.download_button("Download mission evidence JSON",json.dumps(payload,indent=2,ensure_ascii=False),
                           "gridscout_official_mission.json","application/json")

    with settings:
        st.subheader("Scenario and operational assumptions")
        st.write("Five packages, 30-minute flight limit and 180-minute charging are fixed challenge rules. Default duration is the organizer's four-hour scenario window.")
        with st.form("official_configuration"):
            left,right=st.columns(2)
            with left:
                seed=st.number_input("Demonstration seed",0,2**31-1,state.config.seed,step=1,key="of_seed")
                speed=st.number_input("Assumed flight speed (km/min)",.1,2.0,state.config.speed_km_per_minute,step=.1,key="of_speed")
                starts=st.multiselect("Five initial line IDs",list(dataset.segments),
                    default=list(state.history[0]["initial_sites"].values()),max_selections=5,key="of_starts")
                conservative=st.checkbox("Conservative charging: initial site power unknown",value=state.config.assumed_charging_lines==(),key="of_conservative")
            with right:
                hubs=st.multiselect("Explicitly assumed live + sufficient-power sites",[k for k in dataset.segments if k!="LINE_024"],
                    default=list(choose_sites(dataset,12) if state.config.assumed_charging_lines is None else state.config.assumed_charging_lines),key="of_hubs")
                terminal=st.checkbox("Allow terminal visits to noncharging / unknown sites",value=state.config.allow_terminal_visits,key="of_terminal")
                sensitivity=st.slider("Assumed sensitivity",.5,1.0,state.config.sensitivity,.01,key="of_sensitivity")
                specificity=st.slider("Assumed specificity",.5,1.0,state.config.specificity,.01,key="of_specificity")
                beta=st.slider("Information weight",0.,2.,state.config.information_weight,.05,key="of_beta")
            apply=st.form_submit_button("Apply Official Configuration & Reset",type="primary")
        if apply:
            try:
                if len(starts)!=5:
                    raise ValueError("Choose exactly five distinct initial line IDs")
                config=ChallengeConfig(seed=int(seed),start_lines=tuple(starts),assumed_charging_lines=() if conservative else tuple(hubs),
                    speed_km_per_minute=speed,allow_terminal_visits=terminal,sensitivity=sensitivity,specificity=specificity,information_weight=beta)
                reset_official(st.session_state,config,dataset)
            except ValueError as error:
                st.error(str(error))
            else:
                st.rerun()
        st.caption("Demo charging statuses are explicit site assumptions. Conservative mode permits initial full-battery in-place readings. Relocation requires charging eligibility or an enabled terminal visit.")
        st.markdown("**Update one site's operational assumption**")
        line=st.selectbox("Line status to inspect",list(dataset.segments),key="of_site_line")
        site=state.sites[line]
        st.caption(site.source)
        values=["Unknown","Yes","No"]; convert={"Unknown":None,"Yes":True,"No":False}
        with st.form("official_site_status"):
            energized=st.selectbox("Energized",values,index=0 if site.energized is None else 1 if site.energized else 2,key="of_live_"+line)
            enough=st.selectbox("Sufficient charging power",values,index=0 if site.sufficient_power is None else 1 if site.sufficient_power else 2,key="of_power_"+line)
            update=st.form_submit_button("Apply Site Assumption",disabled=line=="LINE_024" or state.time>=state.config.mission_minutes)
        if update:
            set_charging_site(state,line,convert[energized],convert[enough]); st.rerun()
        st.caption("Interrupted charging restarts from zero once energization and sufficient power are re-established. LINE_024 remains de-energized throughout the scenario.")
        statuses=pd.DataFrame([{"Line":key,"Energized":str(value.energized),"Sufficient power":str(value.sufficient_power),
                               "Charging":_site_label(value),"Provenance":value.source} for key,value in state.sites.items()])
        st.dataframe(statuses,hide_index=True,use_container_width=True)
        with st.expander("Model definitions and assumptions",expanded=True):
            st.markdown("""
            - Official geometry: 64 mapped segments, 59 nodes; real OSM-derived locations. Parallel mapped segments are retained. Substation bus connections, actual supply paths and customer loads are unknown.
            - All six reports and their uncertainty are available at mission start.
            - Full batteries and initial deployment at selected line midpoints are assumptions. Deployment itself is outside the four-hour window; instruments can measure for this window while perched, including during recharge.
            - Each relocation is one direct great-circle flight. Safe landing/attachment, constant speed, acceptable weather and flight authorization are assumptions.
            - Charging requires energized=True AND sufficient_power=True. Each flight requires an uninterrupted 180-minute charge before the next departure.
            - Positive, negative and inconclusive sensor examples are hypothetical. Probability parameters and geographic severity bands are uncalibrated demonstration assumptions, independent of charging status.
            - The default policy visits charge-eligible sites. Optional terminal visits end at sites with unavailable or unknown charging. Heuristics choose initial placement and inspection order.
            - Mission outputs are inspection reports, anomaly beliefs and flight/charging audit records.
            """)
    st.divider()
    st.caption("GridScout · Official challenge mode · Public data and explicit assumptions · See Synthetic laboratory for service-impact experiments")
