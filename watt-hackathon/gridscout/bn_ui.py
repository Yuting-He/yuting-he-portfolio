"""Line-specific, auditable explanation of the current-window Bayesian model."""
from __future__ import annotations

from textwrap import wrap

import pandas as pd
import plotly.graph_objects as go
import streamlit as st

from .inspection_model import inspection_spec, inspection_likelihood
from .bn_node_details import node_details

BG = "#101e30"
TEAL = "#59dec7"
BLUE = "#7eafff"
PINK = "#ff8192"
LABELS = {"mechanical":"Mechanical anomaly", "thermal":"Thermal anomaly",
          "sensor_fault":"Sensor / installation issue", "anomaly":"Any asset anomaly · M or T",
          "energized":"Operating state · energized"}
CHANNELS = {"temperature_c":"Temperature · °C", "vibration_rms":"Vibration · RMS",
            "voltage_pu":"Voltage proxy · p.u.", "tilt_deg":"Relative tilt · °"}


def _style(fig, height):
    fig.update_layout(height=height, paper_bgcolor=BG, plot_bgcolor=BG,
        font=dict(color="#e2ecf8"), margin=dict(l=12,r=20,t=25,b=20),
        legend=dict(orientation="h",y=1.16,font=dict(size=11)))
    return fig


def probability_stages(calculation):
    """Expose real model stages, with no invented channel importance values."""
    summaries=calculation.get("summaries",{})
    return [("Window prior",summaries.get("prior",{}),"#8b9eb6"),
            ("After sensors",summaries.get("telemetry_only",{}),BLUE),
            ("After inspection",summaries.get("with_visual",{}),TEAL)]


def outcome_preview(calculation, result, *, modality=None, visibility=None, quality=None):
    """Reweight frozen sensor states with the shared state-specific review model."""
    rows=calculation.get("states",[])
    if not calculation.get("available") or not rows:
        return None
    visual=calculation.get("visual",{})
    settings=dict(visual.get("spec") or visual)
    settings.update({key:value for key,value in {
        "modality":modality,"visibility":visibility,"quality":quality}.items() if value is not None})
    spec=inspection_spec(settings)
    weights=[]
    for row in rows:
        likelihood=inspection_likelihood(row["mechanical"],row["thermal"],result,spec)
        weights.append((row,float(row["posterior_without_visual"])*likelihood))
    total=sum(w for _,w in weights)
    if not total:return None
    return sum(w for row,w in weights if row["mechanical"] or row["thermal"])/total


def probability_chart(calculation):
    fig=go.Figure()
    keys=["anomaly","mechanical","thermal","sensor_fault"]
    if "energized" in calculation.get("summaries",{}).get("prior",{}):
        keys.append("energized")
    for name,values,color in probability_stages(calculation):
        fig.add_trace(go.Bar(name=name,y=[LABELS[k] for k in keys],
            x=[100*values.get(k,0) for k in keys],orientation="h",marker_color=color,
            text=[f"{values.get(k,0):.1%}" for k in keys],textposition="auto",
            hovertemplate="%{y}<br>%{x:.2f}%<extra>%{fullData.name}</extra>"))
    fig.update_layout(barmode="group",xaxis=dict(range=[0,105],title="Model probability · %"),
                      yaxis=dict(autorange="reversed"))
    return _style(fig,410 if len(keys)==5 else 360)


def _rounded_route(points, radius=.12):
    """Round Manhattan connector corners in data coordinates."""
    path=f"M {points[0][0]},{points[0][1]}"
    for before,corner,after in zip(points,points[1:],points[2:]):
        incoming=(corner[0]-before[0],corner[1]-before[1])
        outgoing=(after[0]-corner[0],after[1]-corner[1])
        first=max(abs(incoming[0]),abs(incoming[1]))
        second=max(abs(outgoing[0]),abs(outgoing[1]))
        r=min(radius,first/2,second/2)
        entry=(corner[0]-incoming[0]*r/first,corner[1]-incoming[1]*r/first)
        leave=(corner[0]+outgoing[0]*r/second,corner[1]+outgoing[1]*r/second)
        path+=f" L {entry[0]},{entry[1]} Q {corner[0]},{corner[1]} {leave[0]},{leave[1]}"
    return path+f" L {points[-1][0]},{points[-1][1]}"


def dependency_chart(calculation, selected_node=None):
    """Three semantic columns, internal labels and externally routed conditions."""
    structure=calculation.get("structure",{})
    nodes=structure.get("nodes",[])
    fig=go.Figure()
    if not nodes:
        fig.add_annotation(text="Variable-dependency metadata is unavailable for this snapshot.",
                           x=.5,y=.5,xref="paper",yref="paper",showarrow=False)
        fig.update_layout(xaxis=dict(visible=False),yaxis=dict(visible=False))
        return _style(fig,180)
    positions={"Q":(2.4,10),"O":(2.4,7.5),"I":(2.4,5),"W":(2.4,2.5),
               "S":(6.9,10),"F":(6.9,7.95),"E":(6.9,5.9),"T":(6.9,3.85),"M":(6.9,1.8),
               "ZV":(11.4,9.65),"ZT":(11.4,7),"ZM":(11.4,4.35),"R":(11.4,1.7)}
    half_width,half_height=1.7,.68
    lookup={node["id"]:node for node in nodes}
    selected_node=selected_node if selected_node in lookup else None
    parents={source for source,target in structure.get("edges",[]) if target==selected_node}
    children={target for source,target in structure.get("edges",[]) if source==selected_node}
    groups={"condition":("Background conditions","Known condition",2.4,"#9baec6","#172536","#24364b"),
            "latent":("Hidden states","Latent state",6.9,TEAL,"#122c30","#194342"),
            "observed":("Observations","Observation variable",11.4,BLUE,"#14283e","#1b3654")}
    for kind,(heading,_,x,color,panel,_) in groups.items():
        fig.add_shape(type="rect",x0=x-1.96,x1=x+1.96,y0=.6,y1=12.05,
                      line=dict(width=0),fillcolor=panel,layer="below")
        fig.add_annotation(name=f"group:{kind}",x=x,y=11.55,text=f"<b>{heading}</b>",
                           showarrow=False,font=dict(size=16,color=color))

    # The two within-column state dependencies have adjacent cards. All other
    # core arrows run in the open gap between the state and observation columns.
    # Long condition arrows bypass the entire state column via exterior rails.
    external={ ("Q","ZV"):(12.35,.12,13.48,.18),
               ("Q","ZT"):(12.60,.28,13.64,.18),
               ("Q","ZM"):(12.85,.44,13.80,.18),
               ("W","ZT"):(.05,.12,13.40,-.18),
               ("W","ZM"):(.30,.28,13.56,-.18),
               ("I","R"):(-.20,.44,13.72,0.) }
    incoming={key:sorted([source for source,target in structure.get("edges",[])
                          if target==key and (source,target) not in external],
                         key=lambda source:-positions[source][1]) for key in lookup}
    routes=[]
    for source,target in structure.get("edges",[]):
        x,y=positions[source];xx,yy=positions[target]
        context=lookup[source].get("kind")=="condition"
        color="#8395ac" if context else "#79d8c7"
        width=1.35 if context else 1.9
        opacity=.72 if context else .9
        if selected_node:
            color=BLUE if target==selected_node else TEAL if source==selected_node else "#526074"
            width=3.2 if selected_node in (source,target) else 1.
            opacity=1. if selected_node in (source,target) else .15
        if (source,target) in external:
            rail,left,right,offset=external[source,target]
            start=(x-half_width,y+offset)
            end=(xx+half_width,yy+offset)
            points=[start,(left,start[1]),(left,rail),(right,rail),(right,end[1]),end]
            path=_rounded_route(points)
            arrow_from=(end[0]+.28,end[1])
            routing="exterior"
        elif x==xx:
            start=(x,y-half_height);end=(xx,yy+half_height)
            path=f"M {start[0]},{start[1]} L {end[0]},{end[1]}"
            arrow_from=(end[0],end[1]+.28)
            routing="vertical"
        else:
            target_parents=incoming[target]
            offset=(target_parents.index(source)-(len(target_parents)-1)/2)*.17
            start=(x+half_width,y)
            end=(xx-half_width,yy+offset)
            gap=end[0]-start[0]
            path=f"M {start[0]},{start[1]} C {start[0]+gap*.47},{start[1]} {end[0]-gap*.47},{end[1]} {end[0]},{end[1]}"
            arrow_from=(end[0]-.28,end[1])
            routing="gap"
        fig.add_shape(name=f"edge:{source}:{target}",type="path",path=path,
                      line=dict(color=color,width=width,dash="dot" if context else "solid"),
                      opacity=opacity,layer="below")
        fig.add_annotation(name=f"edge:{source}:{target}",x=end[0],y=end[1],ax=arrow_from[0],ay=arrow_from[1],
            xref="x",yref="y",axref="x",ayref="y",showarrow=True,arrowhead=2,
            arrowwidth=width,arrowcolor=color,opacity=opacity,standoff=0,startstandoff=0,text="")
        routes.append({"source":source,"target":target,"routing":routing})

    posterior=calculation.get("summaries",{}).get("with_visual",{})
    probability_keys={"M":"mechanical","T":"thermal","S":"sensor_fault","E":"energized"}
    titles={"Q":"Q · Sensor quality","O":"O · Operating record","I":"I · Inspection setup",
            "W":"W · Weather & load","S":"S · Sensor fault","F":"F · Fault family",
            "E":"E · Energized state","T":"T · Thermal anomaly","M":"M · Mechanical<br>anomaly",
            "ZV":"Voltage proxy","ZT":"Temperature","ZM":"Vibration + tilt","R":"Inspection result"}
    details={"Q":"Mode · calibration","O":"State · stated prior","I":"Modality · quality · view",
             "W":"Current context","F":"Marginalized","ZM":"Joint observation"}
    for kind,(_,legend,_,color,_,fill) in groups.items():
        selected=[node for node in nodes if node.get("kind","condition")==kind]
        if not selected:continue
        labels,hover,text_colors=[],[],[]
        for node in selected:
            key=node["id"];x,y=positions[key]
            border,card_fill,text_color,border_width=color,fill,"#edf5fc",1.4
            if selected_node:
                if key==selected_node:
                    border,card_fill,border_width="#ffd27d","#493c25",3.4
                elif key in parents:
                    border,card_fill,border_width=BLUE,"#203b59",2.4
                elif key in children:
                    border,card_fill,border_width=TEAL,"#17403d",2.4
                else:
                    border,card_fill,text_color="#354357","#182330","#8190a3"
            fig.add_shape(name=f"node:{key}",type="rect",x0=x-half_width,x1=x+half_width,
                          y0=y-half_height,y1=y+half_height,
                          line=dict(color=border,width=border_width),fillcolor=card_fill,layer="below")
            title=titles.get(key,"<br>".join(wrap(node["label"],width=20)))
            lines=[f"<b>{title}</b>"]
            if key in details:lines.append(details[key])
            probability=posterior.get(probability_keys.get(key))
            if key in probability_keys:
                lines.append(f"P = {probability:.1%}" if probability is not None and (calculation.get("available") or key=="E") else "Unassessed")
            if key=="E":lines.append("Fixed by record" if calculation.get("operation",{}).get("known") else "Inferred")
            if key=="R":lines.append(calculation.get("visual",{}).get("result") or "Unobserved")
            labels.append("<br>".join(lines))
            parent_labels=[lookup[source]["label"] for source,target in structure.get("edges",[]) if target==key]
            hover.append(f"{node['label']}<br>Parents: {', '.join(parent_labels) or 'None'}<br>Click to inspect")
            text_colors.append(text_color)
        fig.add_trace(go.Scatter(name=legend,x=[positions[n["id"]][0] for n in selected],
            y=[positions[n["id"]][1] for n in selected],mode="text",text=labels,
            customdata=[n["id"] for n in selected],
            textposition="middle center",textfont=dict(size=15,color=text_colors),
            hovertext=hover,hoverinfo="text",showlegend=False))
    # An invisible point grid covers each card, including its padding. Every
    # event carries the variable ID, independently of trace/point ordering.
    hit_x,hit_y,hit_ids=[],[],[]
    for node in nodes:
        x,y=positions[node["id"]]
        for dx in (index*.2 for index in range(-8,9)):
            for dy in (-.5,-.25,0,.25,.5):
                hit_x.append(x+dx);hit_y.append(y+dy);hit_ids.append(node["id"])
    fig.add_trace(go.Scatter(name="Node selection",x=hit_x,y=hit_y,customdata=hit_ids,mode="markers",
        marker=dict(symbol="square",size=36,color="rgba(0,0,0,0.003)"),
        selected=dict(marker=dict(opacity=1)),unselected=dict(marker=dict(opacity=1)),
        hovertemplate="%{customdata} · click to inspect<extra></extra>",showlegend=False))
    _style(fig,940)
    fig.update_layout(xaxis=dict(visible=False,range=[-.1,14.1],fixedrange=True),
        yaxis=dict(visible=False,range=[-.55,13.25],fixedrange=True),showlegend=False,
        margin=dict(l=5,r=5,t=5,b=25),hoverlabel=dict(font_size=14),clickmode="event+select",dragmode=False,
        meta={"diagram":"variable_dependencies","nodes":[n["id"] for n in nodes],
              "edges":structure.get("edges",[]),"structure_source":"manually_specified",
              "node_positions":positions,"edge_routes":routes,"layout":"semantic_columns",
              "selected_node":selected_node,"parents":sorted(parents),"children":sorted(children),
              "highlighted_edges":[[a,b] for a,b in structure.get("edges",[]) if selected_node and selected_node in (a,b)]})
    fig.add_annotation(name="edge_legend",x=.5,y=-.015,xref="paper",yref="paper",showarrow=False,
                       text="Selected · amber     Parents · blue     Children · teal" if selected_node else
                            "Solid · state dependencies     Dotted · background conditions",
                       font=dict(size=12,color="#a8b9ce"))
    return fig


def selected_node_from_event(event, allowed_nodes):
    """Resolve a clicked variable from event IDs, validating against this DAG."""
    if not isinstance(event,dict):return None
    selection=event.get("selection",{})
    if not isinstance(selection,dict):return None
    points=selection.get("points",[])
    if not isinstance(points,list):return None
    for point in reversed(points):
        if not isinstance(point,dict):continue
        value=point.get("customdata")
        if isinstance(value,(list,tuple)) and len(value)==1:value=value[0]
        if isinstance(value,str) and value in allowed_nodes:return value
    return None


def _remember_node_selection(chart_key,node_key,allowed_nodes):
    st.session_state[node_key]=selected_node_from_event(st.session_state.get(chart_key,{}),allowed_nodes) or "__all__"


def _clear_node_selection(node_key):
    st.session_state[node_key]="__all__"


@st.fragment
def render_dependency_network(calculation,asset,scope,reading=None,context=None):
    """Selection reruns this read-only fragment with its captured evidence snapshot."""
    nodes=calculation.get("structure",{}).get("nodes",[])
    if not nodes:
        st.plotly_chart(dependency_chart(calculation),use_container_width=True,key=f"tw_bn_dependencies_{asset}")
        return
    lookup={node["id"]:node["label"] for node in nodes}
    node_key=f"tw_bn_selected_node_{asset}_{scope}"
    chart_key=f"tw_bn_dependencies_{asset}_{scope}"
    if st.session_state.get(node_key) not in lookup:st.session_state[node_key]="__all__"
    st.caption("Click a card to inspect its direct parents, children and calculation. Amber: selected · blue: parents · teal: children.")
    choose,clear=st.columns([4,1],vertical_alignment="bottom")
    with choose:
        choice=st.selectbox("Selected BN node",["__all__",*lookup],key=node_key,
                            format_func=lambda node:lookup.get(node,"All nodes"))
        selected=None if choice=="__all__" else choice
    with clear:
        st.button("Show all",key=f"tw_bn_clear_node_{asset}_{scope}",
                  on_click=_clear_node_selection,args=(node_key,),use_container_width=True)
    def on_selection():
        _remember_node_selection(chart_key,node_key,tuple(lookup))
    st.plotly_chart(dependency_chart(calculation,selected),use_container_width=True,key=chart_key,
                    on_select=on_selection,selection_mode="points",
                    config={"displaylogo":False,"doubleClick":False})
    if selected:
        details=node_details(calculation,selected,reading=reading,context=context)
        with st.container(border=True):
            st.markdown(f"**{details['title']}**")
            st.write(details["definition"])
            if details["probability"] is not None:
                st.metric(details["probability_label"],f"{details['probability']:.1%}")
                if selected=="R":st.write(f"Recorded result: {details['value']}")
            elif selected=="F":
                st.write("State handling: marginalized over fault families.")
            else:
                st.write(f"{details['probability_label']}: {details['value']}")
            st.markdown("**Calculation basis**")
            for line in details["basis"]:st.caption(line)
            parents=" · ".join(details["parents"]) or "None"
            children=" · ".join(details["children"]) or "None"
            st.caption(f"Parents: {parents} · Children: {children}")


def route_chart(calculation):
    nodes={"beliefs":("BN state probabilities",(0,2)),
           "reviews":("Inspection modality + outcomes",(2,2)),
           "loss":("Compare expected loss",(0,1)),
           "constraints":("Costs + fleet constraints",(2,1)),
           "action":("Choose feasible action",(0,0)),
           "replan":("Dispatch / replan + receive evidence",(2,0))}
    edges=[("beliefs","loss"),("reviews","loss"),("constraints","loss"),
           ("loss","action"),("action","replan")]
    fig=go.Figure()
    for a,b in edges:
        x,y=nodes[a][1];xx,yy=nodes[b][1]
        fig.add_annotation(x=xx,y=yy,ax=x,ay=y,xref="x",yref="y",axref="x",ayref="y",
            showarrow=True,arrowhead=2,arrowwidth=1.7,arrowcolor="#6985a4",standoff=23,startstandoff=23)
    fig.add_trace(go.Scatter(x=[v[1][0] for v in nodes.values()],y=[v[1][1] for v in nodes.values()],
        mode="markers+text",marker=dict(size=25,color=[BLUE,BLUE,TEAL,"#9baec6",TEAL,TEAL],symbol="square"),
        text=[v[0].replace(" + "," +<br>") for v in nodes.values()],
        textposition="bottom center",hovertext=[v[0] for v in nodes.values()],hoverinfo="text",showlegend=False))
    fig.update_layout(xaxis=dict(visible=False,range=[-.9,3]),yaxis=dict(visible=False,range=[-.6,2.5]),
        meta={"diagram":"decision_workflow","nodes":list(nodes),"edges":edges})
    return _style(fig,320)


def evidence_table(calculation, reading):
    state=calculation.get("evidence_state",{})
    baselines=state.get("baseline",{})
    residuals=state.get("residuals",{})
    mixed="mixture" in state.get("residual_scope","")
    rows=[]
    for channel,label in CHANNELS.items():
        spec=baselines.get(channel,{})
        residue=residuals.get(channel,{})
        value=(reading or {}).get(channel)
        low,high=spec.get("low"),spec.get("high")
        rows.append({"Input":label,"Observed":"—" if value is None else f"{value:.3f}",
            "Normal mean":"—" if spec.get("mean") is None else f"{spec['mean']:.3f}",
            "Operating-state reference envelope" if mixed else "Normal 95% interval":"—" if low is None or high is None else f"{low:.3f} … {high:.3f}",
            "Reference raw z" if mixed else "Raw z":"—" if residue.get("raw_z") is None else f"{residue['raw_z']:+.2f}",
            "Reference scaled z" if mixed else "Used z":"—" if residue.get("used_z") is None else f"{residue['used_z']:+.2f}",
            "Used":channel in state.get("eligible_channels",[])})
    return pd.DataFrame(rows)


def operating_residual_table(calculation):
    """Show each operating branch once, rather than a mixture z as likelihood."""
    branches={}
    for row in calculation.get("states",[]):
        if "energized" not in row or row["energized"] in branches:continue
        residuals=row.get("residuals",{})
        if not residuals:continue
        values={"Operating branch":"Energized" if row["energized"] else "De-energized"}
        for channel,label in CHANNELS.items():
            residual=residuals.get(channel)
            if isinstance(residual,dict):residual=residual.get("used_z")
            values[label]="—" if residual is None else f"{residual:+.2f}"
        branches[row["energized"]]=values
    return pd.DataFrame(branches.values())


def _render_operation_controls(sim, asset, calculation, context):
    operation=calculation.get("operation",{})
    if not operation:return
    probability=operation.get("posterior_energized")
    label="Unknown" if probability is None else f"{probability:.1%}"
    st.caption(f"Operating record: {operation.get('status','unknown')} · source: {operation.get('source','unspecified')} · model P(energized): {label}.")
    if asset=="LINE_024":
        st.caption("Official operating record: LINE_024 is de-energized. This site has a fixed operating state.")
        return
    if not hasattr(sim,"set_operating_state"):return
    with st.expander("Operating record · synthetic demo assumption"):
        st.caption("Set the received operating record for this line. An unknown state is inferred jointly with asset and sensor faults. Charging authorization uses the charging-site operations record.")
        options=["Known energized","Known de-energized","Unknown"]
        known=context.get("energized")
        default=2 if known is None else (0 if known else 1)
        prior=operation.get("unknown_prior_energized",.9)
        with st.form(f"tw_bn_operation_form_{asset}"):
            choice=st.selectbox("Received operating state",options,index=default,key=f"tw_bn_operation_{asset}")
            assumed=st.slider("P(energized) when the operating record is unknown",.01,.99,
                min(.99,max(.01,float(prior))),.01,key=f"tw_bn_operation_prior_{asset}")
            if st.form_submit_button("Apply operating record"):
                energized=None if choice=="Unknown" else choice=="Known energized"
                sim.set_operating_state(asset,energized,source="Operator demo input",prior_energized=assumed)
                st.rerun()


def temporal_chart(history, inspections):
    fig=go.Figure()
    for field,label,color,dash in [("prior_anomaly","Context prior","#8b9eb6","dot"),
            ("telemetry_only_anomaly","Sensors only",BLUE,"dash"),("anomaly","Actual window P",TEAL,"solid")]:
        fig.add_trace(go.Scatter(x=[r["minute"] for r in history],
            y=[None if r.get(field) is None else 100*r[field] for r in history],name=label,
            mode="lines+markers",connectgaps=False,line=dict(color=color,dash=dash,width=2),marker=dict(size=3)))
    for record in inspections:
        minute=record.get("minute",record.get("observed_at"))
        if minute is not None:
            fig.add_vline(x=minute,line_dash="dot",line_color="#f1bf6a")
    fig.update_xaxes(title="Exercise minute")
    fig.update_yaxes(title="Probability · %",range=[0,105])
    return _style(fig,300)


def render_probability_explanation(sim, asset):
    view=sim.explain_asset(asset)
    current=view.get("assessment",sim.current(asset))
    st.subheader(f"{asset} · Why this probability?")
    st.caption("Exact model evidence for this line. P means P(mechanical OR thermal anomaly), including states with a sensor fault.")
    latest=view.get("last_reading") or {}
    st.caption(f"Current exercise time T+{sim.minute} · latest source {latest.get('sensor_id','No observation')} · current status {current.get('status','Unknown')}")
    records=view.get("inspection_history",[])
    labels={r["id"]:f"Inspection T+{r['minute']} · {r.get('result','inconclusive')}" for r in records}
    options=["Current window"]+list(labels)[::-1]
    scope=st.selectbox("Evidence snapshot",options,format_func=lambda x:labels.get(x,x),key=f"tw_bn_scope_{asset}")
    if scope=="Current window":
        calculation=view.get("calculation") or current.get("calculation",{})
        reading=view.get("reading") or {}
        context=view.get("context") or {}
        st.caption("CURRENT WINDOW · Context prior → same-window sensor evidence → one eligible inspection likelihood.")
        visual=view.get("visual",{})
        if visual.get("status")=="stale":
            st.warning("The previous inspection has expired. It is excluded from the current probability; choose its historical snapshot to see the original update.")
    else:
        record=next(r for r in records if r["id"]==scope)
        calculation=record.get("calculation",{})
        reading=record.get("reading",{})
        context=record.get("context",{})
        st.info(f"HISTORICAL INSPECTION · T+{record['minute']} · {record.get('sensor_id','')} · {record.get('result')} · scope: frozen evidence and probability at receipt.")
    if reading:
        st.caption(f"Sensor window observed T+{reading.get('observed_at',0):.2f}, received T+{reading.get('received_at',0):.2f} · frozen baseline {reading.get('baseline_version',sim.baseline.version)}")
    if scope=="Current window":
        _render_operation_controls(sim,asset,calculation,context)
    if not calculation.get("available"):
        st.info("Evidence availability: no fresh, usable asset observations. Current line condition: Unknown. Health assessment requires an eligible asset observation.")
        for col,label in zip(st.columns(3),list(LABELS.values())[:3]):col.metric(label,"Unknown")
    else:
        metrics=st.columns(3)
        for col,(name,values,_) in zip(metrics,probability_stages(calculation)):
            col.metric(name,f"{values['anomaly']:.1%}")
        st.plotly_chart(probability_chart(calculation),use_container_width=True,key=f"tw_bn_prob_{asset}")
        st.caption("M and T can coexist. P(M or T) = P(M) + P(T) − P(M and T); sensor-fault probability is shown separately.")
    st.markdown("**Bayesian network · manually specified variable dependencies**")
    render_dependency_network(calculation,asset,scope,reading=reading,context=context)
    st.caption("Arrows show conditional dependencies in the implemented probability model. M = mechanical anomaly; T = thermal anomaly; S = sensor / installation issue; E = energized state. F is the fault family, marginalized inside the observation likelihood. Vibration and tilt share one correlated observation node.")
    st.caption("Structure: manually specified. Fit data: healthy synthetic samples for normal-baseline parameters. Calibration: synthetic assumptions for priors, fault distributions and inspection reliability. Prior and posterior probabilities annotate the same variables.")
    st.markdown("**Decision workflow · probabilities → expected loss → feasible action**")
    st.plotly_chart(route_chart(calculation),use_container_width=True,key=f"tw_bn_route_{asset}")
    st.caption("This separate workflow compares actions, including the state-specific outcomes of another inspection. Costs and fleet constraints enter action selection. Current measured weather conditions the BN baseline and priors; forecasts and official-style warnings constrain future dispatch.")
    st.markdown("**Input evidence · compared with the normal baseline**")
    if context:
        st.caption(f"Ambient {context.get('ambient_c',0):.1f} °C · wind {context.get('wind_mps',0):.1f} m/s · gust {context.get('gust_mps',0):.1f} m/s · solar {context.get('solar_wm2',0):.0f} W/m² · load unknown · data quality {reading.get('quality','unknown')}")
    st.dataframe(evidence_table(calculation,reading),use_container_width=True,hide_index=True)
    state=calculation.get("evidence_state",{})
    for channel,reason in state.get("excluded",{}).items():st.caption(f"{CHANNELS.get(channel,channel)}: {reason}")
    st.caption("z = (observed − expected) / normal standard deviation. Vibration and tilt form one correlated likelihood. Suspect data use enlarged uncertainty. Unobserved channels are marginalized.")
    if "mixture" in state.get("residual_scope",""):
        st.caption("The table's z values refer to the operating-state mixture for display. The likelihood uses a separate baseline and residual for each energized / de-energized branch, then marginalizes E.")
        branch_table=operating_residual_table(calculation)
        if not branch_table.empty:
            with st.expander("Residuals actually used in each operating branch"):
                st.dataframe(branch_table,use_container_width=True,hide_index=True)
    if calculation.get("available"):
        visual=calculation.get("visual",{})
        st.markdown("**How the inspection changes P**")
        result=visual.get("result") or "No eligible result"
        st.write(f"**{result}** · {visual.get('reason','')}")
        before=visual.get("before",calculation.get("summaries",{}).get("telemetry_only",{}).get("anomaly",0))
        after=visual.get("after",calculation.get("summaries",{}).get("with_visual",{}).get("anomaly",0))
        st.write(f"Sensors only **{before:.1%}** → with eligible inspection **{after:.1%}** · **{100*(after-before):+.1f} percentage points**")
        spec=inspection_spec(visual.get("spec") or visual)
        st.caption(f"Inspection modality: {spec['modality']} · quality: {spec['quality']} · visibility: {spec['visibility']}. Each M/T combination has its own inspection likelihood. RGB covers visible mechanical evidence; thermal imaging covers thermal evidence.")
        if visual.get("used") and visual.get("likelihood_ratio") is not None:
            st.caption(f"Effective anomaly / no-anomaly likelihood ratio for this sensor-state mixture: {visual['likelihood_ratio']:.3f}. Definition: ratio of the state-weighted inspection likelihoods in the anomaly and normal groups.")
        st.latex(r"P(h\mid z,R,C)\propto P(h\mid z,C)\,P(R\mid M,T,I)")
        with st.expander("Try another inspection result · preview only"):
            choice=st.radio("Hypothetical inspection",["supports","clear","inconclusive"],horizontal=True,key=f"tw_bn_preview_{asset}")
            modalities=["rgb","thermal","combined"]
            visibilities=["clear","limited","poor","obscured"]
            qualities=["valid","suspect","invalid"]
            modality=st.selectbox("Hypothetical inspection modality",modalities,index=modalities.index(spec["modality"]) if spec["modality"] in modalities else 0,key=f"tw_bn_preview_modality_{asset}")
            visibility=st.selectbox("Hypothetical visibility",visibilities,index=visibilities.index(spec["visibility"]) if spec["visibility"] in visibilities else 0,key=f"tw_bn_preview_visibility_{asset}")
            quality=st.selectbox("Hypothetical inspection quality",qualities,index=qualities.index(spec["quality"]) if spec["quality"] in qualities else 0,key=f"tw_bn_preview_quality_{asset}")
            p=outcome_preview(calculation,choice,modality=modality,visibility=visibility,quality=quality)
            st.metric("Preview P(anomaly)","Unknown" if p is None else f"{p:.1%}")
            st.caption("Preview scope: the frozen sensor evidence and current inspection model with a hypothetical outcome, modality, quality and visibility. Historical recorded calculations retain their original assumptions.")
        count=len(calculation.get("states",[]))
        with st.expander(f"Inspect the exact {count} joint states and calculation"):
            st.latex(r"P(h\mid z,R,C)=\frac{P(h\mid C)L(z\mid h,C)L(R\mid M,T,I)}{\sum_{h'}P(h'\mid C)L(z\mid h',C)L(R\mid M',T',I)}")
            rows=[]
            for s in calculation.get("states",[]):
                row={"M":s["mechanical"],"T":s["thermal"],"Sensor fault":s["sensor_fault"],
                    "Prior":s["prior_probability"],"Log sensor likelihood":s["log_sensor_likelihood"],
                    "Inspection likelihood":s["visual_likelihood"],"After sensors":s["posterior_without_visual"],
                    "Posterior":s["posterior_probability"]}
                if "energized" in s:row={"Energized":s["energized"],**row}
                rows.append(row)
            st.dataframe(pd.DataFrame(rows),use_container_width=True,hide_index=True)
            st.caption(f"These {count} mutually exclusive joint states sum to 100%. A known operating record fixes E; an unknown record adds its two possible values. F is marginalized within each state. The marginal probability bars above can overlap.")
            st.write("Normal parameters are fitted from 3,600 healthy synthetic samples. Fault priors, abnormal distributions and inspection reliability use synthetic demonstration assumptions.")
            st.caption("Sensor faults mix temperature 40%, mechanical/installation 40%, voltage 10% and common faults 10%. These alternatives are marginalized inside each joint state.")
    st.markdown("**Across time · current-window probability history**")
    history=view.get("history",[])
    if history:
        st.plotly_chart(temporal_chart(history,records),use_container_width=True,key=f"tw_bn_time_{asset}")
        st.caption("Gaps indicate missing, stale or departed observations. Gold event lines mark inspections. Each point is recomputed from its own window.")
    else:st.caption("No observation history for this line yet.")
    with st.expander("Temporal model scope and calibration prerequisites"):
        st.write("A temporal model could estimate fault persistence and recovery. It needs calibrated state-transition rates and a model of correlated observation noise. Adjacent exercise windows are strongly correlated; reusing them as independent evidence would inflate confidence.")
        st.write("Current implementation: per-window BN, event-time history, three fresh suspicious windows before routine follow-up, five normal windows to rearm, and immediate severe-observation human escalation. Persistence gates determine scheduling; the BN computes each displayed probability from the current window.")
        st.caption("DBN calibration prerequisites: labelled sequences, transition/dwell-time estimation, a correlated observation model or independent innovations, once-only inspection updates, and probability-calibration, false-positive and delay checks.")
