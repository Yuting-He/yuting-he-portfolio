"""GridScout operations dashboard. Launch: python -m streamlit run app.py."""
from __future__ import annotations

from dataclasses import asdict
import math

import pandas as pd
import plotly.express as px
import streamlit as st

from gridscout.evaluation import run_benchmark
from gridscout.decisions import DECISION_VALUE_IMPLEMENTED
from gridscout.impact import expected_service, restoration_opportunities
from gridscout.models import ScenarioConfig
from gridscout.network import lines
from gridscout.session import ensure_session, reset_session
from gridscout.simulation import auto_run, recommend, step
from gridscout.visualization import network_figure, probability_change_figure, severity_figure




def render_lab():
    st.markdown("""<style>
    .block-container {max-width: 1500px; padding-top: 3rem; padding-bottom: 3rem;}
    h1 {letter-spacing: -.045em; font-weight: 750 !important;}
    h2, h3 {letter-spacing: -.025em;}
    [data-testid="stMetric"] {background: #142438; border: 1px solid #263b51; border-radius: 10px; padding: 16px;}
    [data-testid="stMetricLabel"] {color: #a9bbcf; white-space: normal;}
    [data-testid="stMetricLabel"] p {white-space: normal; overflow: visible;}
    [data-testid="stButton"] button p {white-space: normal; overflow-wrap: anywhere;}
    [data-testid="stMetricValue"] {font-size: 1.85rem;}
    [data-testid="stTabs"] button {font-weight: 600;}
    .eyebrow {font-size: .73rem; letter-spacing: .16em; color: #62d6b7; font-weight: 700;}
    .subhead {color: #9eb1c8; font-size: 1.05rem; margin-top: -.6rem; margin-bottom: 1.2rem;}
    .status-pill {display: inline-block; white-space: normal; color: #74ddc0; border: 1px solid #31594e; background: #17372f; border-radius: 18px; padding: 6px 12px; font-size: .8rem;}
    </style>""", unsafe_allow_html=True)


    def invalidate_recommendation():
        st.session_state["gs_recommendations"] = []


    def reset_current():
        reset_session(st.session_state, st.session_state["gs_config"])


    def severe_storm_preset():
        for key in list(st.session_state):
            if str(key).startswith("cfg_"):
                del st.session_state[key]
        reset_session(st.session_state, ScenarioConfig())


    def candidate_frame(recommendations):
        return pd.DataFrame([{
            "Rank": i + 1, "Line": r.action.line_id, "Sensor": r.action.sensor_id,
            "P(failure)": r.probability, "Customers if failed": r.impact.customers,
            "Demand if failed (kW)": r.impact.demand_kw, "Critical sites": r.impact.critical_sites,
            "Expected fault impact": r.expected_fault_impact, "Information gain (bits)": r.information_gain,
            "Decision value": r.decision_value, "Travel (min)": r.action.travel_minutes,
            "Inspect (min)": r.action.inspection_minutes, "Policy score": r.score,
        } for i, r in enumerate(recommendations[:5])])


    ensure_session(st.session_state)
    sim = st.session_state["gs_simulation"]
    config = st.session_state["gs_config"]

    head, status = st.columns([3, 1])
    with head:
        st.markdown('<div class="eyebrow">ADAPTIVE GRID INSPECTION & RESTORATION INTELLIGENCE</div>', unsafe_allow_html=True)
        st.title("GridScout")
        st.markdown('<div class="subhead">Collect the right evidence. Make better restoration decisions.</div>', unsafe_allow_html=True)
    with status:
        st.markdown('<div style="height: 24px"></div><span class="status-pill">OFFLINE · SYNTHETIC DIGITAL TWIN</span>', unsafe_allow_html=True)
        st.caption(f"{config.hazard} / {config.severity} severity prior · seed {config.seed}")

    with st.sidebar:
        st.subheader("Mission control")
        policy = st.selectbox("Inspection policy", ["GridScout Advanced", "Adaptive Risk", "Static Risk", "Random"],
                              key="ui_policy", on_change=invalidate_recommendation)
        mode = st.selectbox("GridScout ablation", ["Restoration-aware", "Risk + Information Gain", "Risk-only"],
                            key="ui_mode", disabled=policy != "GridScout Advanced", on_change=invalidate_recommendation)
        if policy == "GridScout Advanced" and mode == "Restoration-aware":
            st.caption("Risk + zone information gain + one-step repair-support value for the next inspection." if DECISION_VALUE_IMPLEMENTED else "Risk + zone information gain.")
        st.divider()
        st.write(f"**{len(sim.mission.completed)} / {sim.grid.graph.number_of_edges()} lines inspected**")
        st.progress(min(sim.mission.time / config.mission_minutes, 1.0),
                    text=f"{sim.mission.time:.1f} / {config.mission_minutes:.0f} mission minutes")
        st.caption("Mission clock advances to the next inspection event. Transit positions are shown at their last completed stop.")
        st.divider()
        st.caption("Observe → Update beliefs → Estimate impact → Recommend → Replan")
        st.caption("A positive sensor report is evidence that updates the failure probability.")

    live, explanation, evidence, benchmark, settings = st.tabs([
        "Live Operations", "Decision Explanation", "Bayesian Evidence", "Strategy Benchmark", "Scenario Configuration"
    ])

    with live:
        controls = st.columns(4)
        with controls[0]:
            ask = st.button("Recommend Next Inspection", type="primary", use_container_width=True)
        with controls[1]:
            execute = st.button("Execute Inspection", disabled=sim.mission.finished, use_container_width=True)
        with controls[2]:
            run_all = st.button("Auto-Run Mission", disabled=sim.mission.finished, use_container_width=True)
        with controls[3]:
            st.button("Reset Scenario", on_click=reset_current, use_container_width=True)

        if ask:
            st.session_state["gs_recommendations"] = recommend(sim, policy, mode)
        if execute or run_all:
            old = st.session_state.get("gs_recommendations") or recommend(sim, policy, mode)
            st.session_state["gs_previous_target"] = old[0].action.line_id if old else None
            with st.spinner("Updating evidence and replanning…"):
                if run_all:
                    auto_run(sim, policy, mode)
                else:
                    step(sim, policy, mode)
                st.session_state["gs_recommendations"] = recommend(sim, policy, mode)
            st.rerun()

        recommendations = st.session_state.get("gs_recommendations") or recommend(sim, policy, mode)
        st.session_state["gs_recommendations"] = recommendations
        target = recommendations[0] if recommendations else None
        cache_key = tuple((k, o.positive) for k, o in sorted(sim.beliefs.observations.items()))
        if st.session_state.get("gs_service_key") != cache_key or "gs_opportunities" not in st.session_state:
            st.session_state["gs_service"] = expected_service(
                sim.grid, sim.beliefs, samples=256, seed=2026,
                sensitivity=config.sensitivity, specificity=config.specificity)
            st.session_state["gs_opportunities"] = restoration_opportunities(
                sim.grid, sim.beliefs, config, samples=128, seed=2026)
            st.session_state["gs_service_key"] = cache_key
        service = st.session_state["gs_service"]
        metrics = st.columns(4)
        metrics[0].metric("Expected customers out", f"{service['disconnected_customers']:,.0f}")
        metrics[1].metric("Expected unserved kW", f"{service['unserved_kw']:,.0f}")
        metrics[2].metric("Critical sites at risk", f"{service['critical_disconnected']:.2f}")
        metrics[3].metric("Sensor reports", f"{len(sim.mission.completed)}")
        st.caption("Expected service exposure from 256 correlated failure samples. Fractional critical-site counts are averages across samples.")

        map_col, next_col = st.columns([3, 1.25])
        with map_col:
            st.plotly_chart(network_figure(sim.grid, sim.beliefs, sim.mission,
                                          target.action.line_id if target else None),
                            use_container_width=True, config={"displayModeBar": False, "scrollZoom": True}, key="network")
            st.caption("Line color = posterior failure probability · dotted = inspected · wide = recommended · ★ critical facility · ◆ sensor. Synthetic local coordinates, km.")
        with next_col:
            st.subheader("Next best evidence")
            if target:
                st.markdown(f"### {target.action.line_id}")
                st.write(f"**{target.action.sensor_id}** · {target.probability:.0%} failure probability")
                st.write(f"{target.impact.customers:,.0f} customers and {target.impact.demand_kw:,.0f} kW potentially exposed")
                st.write(f"{target.action.duration:.1f} min travel + inspection")
                st.caption("Service exposure is the consequence of this line failing while all other lines are healthy.")
            elif sim.mission.pending:
                st.info("Sensors are in transit or inspecting. Execute to advance to the next observation.")
            else:
                st.info("No further feasible inspections. The mission is complete or the remaining travel exceeds its time or endurance budget.")
            st.divider()
            for sensor in sim.mission.sensors:
                st.write(f"**{sensor.sensor_id}** · {sensor.status}")
                st.caption(f"{sensor.remaining_endurance:.1f} min endurance remaining" +
                           (f" · target {sensor.target_line}" if sensor.target_line else ""))
                if sensor.status == "returning":
                    st.caption(f"Base arrival: mission minute {sensor.available_at:.1f}")

        with st.expander("Mission event log", expanded=bool(sim.mission.completed)):
            if sim.mission.completed:
                st.dataframe(pd.DataFrame([{
                    "Time (min)": round(o.time, 2), "Sensor": o.sensor_id, "Line": o.line_id,
                    "Sensor report": "Positive" if o.positive else "Negative",
                    "Current P(failure)": sim.beliefs.line_probabilities[o.line_id],
                } for o in sim.mission.completed]), hide_index=True, use_container_width=True)
            else:
                st.caption("No observations yet. Execute an inspection to collect evidence.")

    with explanation:
        st.subheader("Why inspect this line?")
        st.caption("Candidate ranking uses the displayed heuristic score and feasibility constraints.")
        previous = st.session_state.get("gs_previous_target")
        if target:
            st.markdown(f"**Recommended: {target.action.line_id} using {target.action.sensor_id}**")
            if previous:
                st.info(f"Before the latest action: {previous}. Next feasible target after evidence and scheduling: {target.action.line_id}. Changes can reflect both beliefs and sensor availability.")
            st.write(
                f"The current model assigns a {target.probability:.1%} probability of failure. "
                f"A failure on this line can disconnect {target.impact.customers:,.0f} customers, "
                f"{target.impact.demand_kw:,.0f} kW of demand, and {target.impact.critical_sites:g} critical facilities "
                "when the rest of the grid is available. "
                f"Its expected zone information gain is {target.information_gain:.3f} bits. "
                f"Travel takes {target.action.travel_minutes:.1f} minutes and inspection takes {target.action.inspection_minutes:.1f} minutes."
            )
            c1, c2, c3, c4 = st.columns(4)
            c1.metric("Normalized risk", f"{target.normalized_risk:.3f}")
            c2.metric("Normalized information", f"{target.normalized_information:.3f}")
            c3.metric("Normalized decision value", f"{target.normalized_decision:.3f}")
            c4.metric("Policy score", f"{target.score:.4f}")
            st.caption(f"One-step next-inspection repair-support value: {target.decision_value:.6f} impact/min. This averages possible positive and negative reports using temporary belief copies, then compares the best feasible next inspection on the same action set.")
            st.write("Feasibility reserves endurance and mission time for return to base and assigns each line to one sensor at a time.")
            st.caption(f"Projected completion: {target.action.finish_time:.1f} min · return reserve: {target.action.return_minutes:.1f} min.")
            st.dataframe(candidate_frame(recommendations), hide_index=True, use_container_width=True,
                         column_config={"P(failure)": st.column_config.NumberColumn(format="%.3f"),
                                        "Policy score": st.column_config.NumberColumn(format="%.4f")})
            if sim.mission.evidence:
                last_evidence = sim.mission.evidence[-1]
                before_scores = {r.action.line_id: last_evidence["prior_probabilities"][r.action.line_id] * r.impact.weighted for r in recommendations}
                after_scores = {r.action.line_id: last_evidence["posterior_probabilities"][r.action.line_id] * r.impact.weighted for r in recommendations}
                before_order = sorted(before_scores, key=lambda line: (-before_scores[line], line))
                after_order = sorted(after_scores, key=lambda line: (-after_scores[line], line))
                with st.expander("Belief-only reranking on the same remaining candidate set"):
                    st.caption("Both columns rank the same feasible targets by probability × service impact, using beliefs immediately before and after the latest evidence.")
                    st.dataframe(pd.DataFrame([{"Line": line, "Risk rank before": before_order.index(line) + 1,
                                               "Risk rank after": after_order.index(line) + 1,
                                               "Expected fault impact before": before_scores[line],
                                               "Expected fault impact after": after_scores[line]} for line in after_order[:5]]),
                                 hide_index=True, use_container_width=True)
        else:
            st.info("No feasible candidate is currently available. Advance pending inspections or reset the scenario.")
        st.markdown("**Impact model**")
        st.latex(r"I = w_d\frac{\mathrm{unserved\ demand}}{\mathrm{total\ demand}} + w_c\frac{\mathrm{disconnected\ customers}}{\mathrm{total\ customers}} + w_k\frac{\mathrm{critical\ sites\ disconnected}}{\mathrm{total\ critical\ sites}}")
        st.caption(f"Configured weights: demand {config.demand_weight:g}, customers {config.customer_weight:g}, critical infrastructure {config.critical_weight:g}; normalized to sum to one. Service impact follows connectivity from energized sources to loads.")
        st.markdown("**Policy components**")
        st.latex(r"\mathrm{score} = \frac{\alpha\,\widehat{p I} + \beta\,\widehat{\mathrm{information\ gain}} + \gamma\,\widehat{\mathrm{decision\ value}}}{\mathrm{travel\ time} + \mathrm{inspection\ time}}")
        st.caption("GridScout terms are normalized over feasible candidates. Static Risk and Adaptive Risk rank by expected impact. Random uses a seeded draw. Risk-only uses the impact and time terms. Risk + Information Gain adds information gain. Advanced also evaluates the same sensor's next inspection under travel, mission and return-endurance constraints.")
        st.markdown("**Estimated restoration opportunities**")
        st.caption("Estimated service gain from an instantaneous repair of one chosen line, averaged across 128 joint posterior samples while retaining other sampled faults.")
        opportunities = st.session_state.get("gs_opportunities", [])
        if opportunities:
            opportunity_frame = pd.DataFrame(opportunities[:5]).rename(columns={
                "line_id": "Line", "probability": "P(failure)",
                "expected_customers_reconnected": "Expected customers reconnected",
                "expected_kw_reconnected": "Expected kW reconnected",
                "expected_critical_reconnected": "Expected critical sites reconnected",
                "weighted_opportunity": "Weighted opportunity"})
            st.dataframe(opportunity_frame, hide_index=True, use_container_width=True)

    with evidence:
        st.subheader("Evidence changes a shared hazard model")
        st.write("Lines in the same zone share uncertain hazard severity. An observation updates that zone and the failure probabilities of its neighboring lines. Each observed line contributes evidence once.")
        if sim.mission.evidence:
            evidence_index = st.selectbox("Observation event", range(len(sim.mission.evidence)),
                                          index=len(sim.mission.evidence) - 1,
                                          format_func=lambda i: f"{i + 1}. {sim.mission.evidence[i]['line_id']} · " +
                                          ("positive report" if sim.mission.evidence[i]['positive'] else "negative report"))
            event = sim.mission.evidence[evidence_index]
            zone = event["zone"]
            st.info(f"{event['line_id']} returned a {'positive' if event['positive'] else 'negative'} sensor report in {zone}. Sensitivity: {config.sensitivity:.0%}; specificity: {config.specificity:.0%}.")
            a, b = st.columns(2)
            with a:
                st.plotly_chart(severity_figure(event["prior_zone"], event["posterior_zone"], f"{zone} severity: before → after event"), use_container_width=True)
            with b:
                zone_lines = [line_id for line_id, z in sim.beliefs.line_zones.items() if z == zone]
                changes = pd.DataFrame([{"Line": line_id, "Before": event["prior_probabilities"][line_id],
                                         "After": event["posterior_probabilities"][line_id]} for line_id in zone_lines])
                st.plotly_chart(probability_change_figure(changes), use_container_width=True)
            changes["Change (pp)"] = 100 * (changes["After"] - changes["Before"])
            st.dataframe(changes, hide_index=True, use_container_width=True)
            st.caption("Before is the belief immediately preceding this observation. Observed neighbors retain their own evidence while sharing the updated zone posterior.")
        else:
            st.info("Execute an inspection in Live Operations to see the Bayesian update.")
        with st.expander("Initial prior versus current zone severity", expanded=not sim.mission.evidence):
            columns = st.columns(len(sim.beliefs.zone_severity))
            for column, (zone, posterior) in zip(columns, sim.beliefs.zone_severity.items()):
                with column:
                    st.plotly_chart(severity_figure(sim.beliefs.prior_severity[zone], posterior, zone), use_container_width=True, key=f"zone_{zone}")

    with benchmark:
        st.subheader("Paired policy benchmark")
        st.write("Each policy receives the same seeded hidden faults and per-line sensor noise. Evaluation compares its inspection results with simulated ground truth.")
        st.caption("Weighted fault detection sums isolated line-failure impact scores for true faults with a positive sensor report.")
        sample_count = st.select_slider("Paired scenario seeds", options=[3, 5, 10, 20, 30], value=5, key="benchmark_seeds")
        st.caption(f"Seeds {config.seed}–{config.seed + sample_count - 1}. All methods use the configured fleet, mission budget, and sensor accuracy.")
        if st.button("Run Paired Benchmark", type="primary"):
            with st.spinner("Running paired missions across six policies…"):
                results = run_benchmark(config, seeds=list(range(config.seed, config.seed + sample_count)))
                st.session_state["gs_benchmark"] = [asdict(result) for result in results]
        results = st.session_state.get("gs_benchmark")
        if results:
            frame = pd.DataFrame(results)
            metric = st.selectbox("Compare metric", ["weighted_faults_detected", "inspection_coverage", "remaining_undetected_impact", "runtime_seconds"],
                                  format_func=lambda value: {
                                      "weighted_faults_detected": "Criticality-weighted true faults detected ↑",
                                      "inspection_coverage": "Inspection coverage ↑",
                                      "remaining_undetected_impact": "Remaining undetected fault impact ↓",
                                      "runtime_seconds": "Computation time (seconds) ↓",
                                  }[value])
            summary = frame.groupby("policy", sort=False)[metric].agg(["mean", "std", "count"]).reset_index()
            summary["95% interval half-width"] = 1.96 * summary["std"].fillna(0) / summary["count"].map(math.sqrt)
            chart = px.bar(summary, x="policy", y="mean", error_y="95% interval half-width", color="policy",
                           color_discrete_sequence=["#6e829c", "#89a4c6", "#6badd6", "#aac982", "#70c2b0", "#39cda7"],
                           labels={"policy": "", "mean": metric.replace("_", " ")})
            chart.update_layout(showlegend=False, height=380)
            st.plotly_chart(chart, use_container_width=True)
            st.caption("Error bars show descriptive mean ± 1.96 × standard error across seeds. Seed-level results support paired comparisons.")
            aggregate = frame.groupby("policy", sort=False).agg(
                scenarios=("seed", "count"), weighted_faults=("weighted_faults_detected", "mean"),
                coverage=("inspection_coverage", "mean"), remaining_impact=("remaining_undetected_impact", "mean"),
                runtime_seconds=("runtime_seconds", "mean"),
                critical_detection_observed=("first_critical_detection_minutes", "count"),
                first_critical_minutes_observed_only=("first_critical_detection_minutes", "mean"),
            ).reset_index()
            aggregate["critical_detection_rate"] = aggregate["critical_detection_observed"] / aggregate["scenarios"]
            st.dataframe(aggregate, hide_index=True, use_container_width=True)
            st.caption("First critical detection time averages missions that detected a true fault affecting a critical site. A missing time records a mission with no such detection.")
            paired = frame.pivot(index="seed", columns="policy", values="weighted_faults_detected")
            ablation_rows = []
            for label, baseline, treatment in [
                ("Bayesian adaptation", "Static Risk", "Adaptive Risk"),
                ("Information gain", "GridScout Risk-only", "GridScout + IG"),
                ("One-step decision value", "GridScout + IG", "GridScout Advanced"),
            ]:
                if baseline in paired and treatment in paired:
                    differences = (paired[treatment] - paired[baseline]).dropna()
                    mean_delta = differences.mean()
                    width = 1.96 * differences.std(ddof=1) / math.sqrt(len(differences)) if len(differences) > 1 else 0
                    ablation_rows.append({"Component": label, "Comparison": f"{treatment} − {baseline}",
                                          "Mean paired change": mean_delta, "95% lower": mean_delta - width,
                                          "95% upper": mean_delta + width, "Paired seeds": len(differences)})
            if ablation_rows:
                st.markdown("**Paired ablation: weighted true faults detected**")
                st.dataframe(pd.DataFrame(ablation_rows), hide_index=True, use_container_width=True)
                st.caption("Positive changes favor the added component; negative changes favor the baseline. Intervals are descriptive normal approximations of paired differences across these seeds.")
            with st.expander("Raw paired results and reproducibility fingerprints"):
                st.dataframe(frame, hide_index=True, use_container_width=True)
            st.download_button("Download seed-level CSV", frame.to_csv(index=False), "gridscout_paired_benchmark.csv", "text/csv")
        else:
            st.info("Run the benchmark to generate results on this computer.")
        st.markdown("**Ablation reading guide**")
        st.write("Static Risk versus Adaptive Risk measures Bayesian adaptation. GridScout Risk-only versus GridScout + IG measures information gain using the same travel-time denominator. GridScout + IG versus Advanced measures one-step next-inspection decision value.")

    with settings:
        st.subheader("Scenario configuration")
        st.button("Demo Scenario: Severe Storm", on_click=severe_storm_preset)
        st.caption("Reproducible preset: Storm, High severity prior, two sensors, 90-minute mission, seed 42. Scenario truth is sampled once at reset and remains fixed.")
        with st.form("scenario_configuration"):
            a, b, c = st.columns(3)
            with a:
                hazard = st.selectbox("Hazard type", ["Storm", "Wildfire", "Heatwave"], index=["Storm", "Wildfire", "Heatwave"].index(config.hazard), key="cfg_hazard")
                severity = st.selectbox("Hazard severity prior", ["Low", "Medium", "High"], index=["Low", "Medium", "High"].index(config.severity), key="cfg_severity")
                count = st.slider("Sensor count", 1, 5, config.sensor_count, key="cfg_sensors")
                minutes = st.slider("Mission budget (minutes)", 20, 180, int(config.mission_minutes), step=5, key="cfg_budget")
            with b:
                sensitivity = st.slider("Sensor sensitivity", 0.5, 1.0, config.sensitivity, step=0.01, key="cfg_sensitivity")
                specificity = st.slider("Sensor specificity", 0.5, 1.0, config.specificity, step=0.01, key="cfg_specificity")
                endurance = st.slider("Initial endurance (minutes)", 30, 240, int(config.endurance_minutes), step=10, key="cfg_endurance")
                seed = st.number_input("Random seed", 0, 2**31 - 1, config.seed, step=1, key="cfg_seed")
            with c:
                ig_weight = st.slider("Information-gain weight β", 0.0, 2.0, config.information_weight, step=0.05, key="cfg_ig")
                decision_weight = st.slider("Decision-value weight γ", 0.0, 2.0, config.decision_weight, step=0.05, key="cfg_decision", disabled=not DECISION_VALUE_IMPLEMENTED)
                demand_weight = st.number_input("Unserved-demand weight", 0.0, 10.0, config.demand_weight, step=0.1, key="cfg_demand")
                customer_weight = st.number_input("Disconnected-customer weight", 0.0, 10.0, config.customer_weight, step=0.1, key="cfg_customers")
                critical_weight = st.number_input("Critical-infrastructure weight", 0.0, 10.0, config.critical_weight, step=0.1, key="cfg_critical")
            submit = st.form_submit_button("Apply Configuration & Reset", type="primary")
        if submit:
            try:
                new_config = ScenarioConfig(
                    hazard=hazard, severity=severity, sensor_count=count, mission_minutes=float(minutes),
                    sensitivity=sensitivity, specificity=specificity, endurance_minutes=float(endurance),
                    information_weight=ig_weight, decision_weight=decision_weight, seed=int(seed),
                    demand_weight=demand_weight, customer_weight=customer_weight, critical_weight=critical_weight)
            except ValueError as error:
                st.error(str(error))
            else:
                reset_session(st.session_state, new_config)
                st.rerun()

        with st.expander("Model definitions and assumptions", expanded=True):
            st.markdown("""
            - **Synthetic network and hazards.** Network data and logistic failure parameters are demonstration assumptions.
            - **Connectivity model.** A load is supplied when a path connects it to an energized source.
            - **Observation model.** Fixed sensitivity and specificity determine the likelihood of each sensor report. A three-state latent hazard severity links failures within a zone.
            - **Inspection outcome.** Each inspection collects a report and updates failure beliefs. Service exposure supports repair prioritization.
            - **Mission model.** Constant-speed travel follows straight-line local distances. Every assignment reserves a return to base within initial battery endurance.
            - **Flight assumptions.** Travel assumes acceptable weather, visibility, permissions and flight conditions.
            - **Planning policy.** A heuristic score ranks feasible candidates by expected impact, information gain and next-inspection value.
            """)

    st.divider()
    st.caption("GridScout V2 · Hackathon prototype · Offline and reproducible · Inspections update estimated failure probabilities.")
