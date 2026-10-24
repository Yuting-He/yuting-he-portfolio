"""Probability previews reweight real states and never modify mission evidence."""
from copy import deepcopy

import pytest

from gridscout.bn_ui import (outcome_preview, evidence_table, temporal_chart,
                            dependency_chart, route_chart, probability_chart,
                            operating_residual_table)
from gridscout.bn_structure import model_structure
from gridscout.inspection_model import inspection_spec, inspection_likelihood
from gridscout.twin_engine import TwinSimulation


def test_visual_preview_matches_bayes_and_preserves_actual_mission():
    sim=TwinSimulation("dynamic",42,autonomous=True).advance_to(60)
    view=sim.explain_asset("LINE_058")
    calc=view["calculation"]
    prior=calc["summaries"]["telemetry_only"]["anomaly"]
    before=deepcopy(sim.export())
    spec=inspection_spec(calc.get("visual",{}).get("spec"))
    for outcome in ("supports","clear"):
        weights=[(row,row["posterior_without_visual"]*inspection_likelihood(
            row["mechanical"],row["thermal"],outcome,spec)) for row in calc["states"]]
        expected=sum(weight for row,weight in weights if row["mechanical"] or row["thermal"])/sum(weight for _,weight in weights)
        assert outcome_preview(calc,outcome)==pytest.approx(expected)
    assert outcome_preview(calc,"inconclusive")==pytest.approx(prior)
    assert sim.export()==before
    assert evidence_table(calc,view["reading"])["Used"].sum()==4


def test_unknown_preview_has_no_prior_as_a_health_assessment():
    sim=TwinSimulation("dropout",42).advance_to(35)
    view=sim.explain_asset(sim.drones[4].asset_id)
    assert not view["calculation"]["available"]
    assert outcome_preview(view["calculation"],"clear") is None
    chart=temporal_chart(view["history"],view["inspection_history"])
    actual=next(trace for trace in chart.data if trace.name=="Actual window P")
    assert actual.y[-1] is None


def test_rgb_clear_does_not_exclude_thermal_only_states():
    calc={"available":True,"states":[
        {"mechanical":False,"thermal":False,"posterior_without_visual":.6},
        {"mechanical":False,"thermal":True,"posterior_without_visual":.4}]}
    assert outcome_preview(calc,"clear",modality="rgb")==pytest.approx(.4)
    assert outcome_preview(calc,"supports",modality="rgb")==pytest.approx(.4)
    thermal_clear=outcome_preview(calc,"clear",modality="thermal")
    assert thermal_clear<.4
    assert thermal_clear<outcome_preview(calc,"clear",modality="thermal",visibility="poor")<.4
    assert outcome_preview(calc,"clear",modality="combined",visibility="obscured")==pytest.approx(.4)
    assert outcome_preview(calc,"clear",modality="combined",quality="invalid")==pytest.approx(.4)


def test_declared_dependencies_are_rendered_separately_from_action_workflow():
    structure=model_structure()
    calc={"structure":structure,"available":True,
          "summaries":{"with_visual":{"mechanical":.3,"thermal":.4,"sensor_fault":.2,"energized":.7}}}
    graph=dependency_chart(calc)
    edges={tuple(edge) for edge in graph.layout.meta["edges"]}
    assert edges=={tuple(edge) for edge in structure["edges"]}
    assert {("S","F"),("F","ZV"),("E","ZV"),("T","R"),("I","R")}<=edges
    assert sum(bool(annotation.showarrow) for annotation in graph.layout.annotations)==len(edges)
    assert graph.layout.meta["structure_source"]=="manually_specified"
    labels=" ".join(label for trace in graph.data if trace.text for label in trace.text)
    assert "70.0%" in labels
    assert "Inferred" in labels
    assert "Posterior" not in labels and "Prior" not in labels
    flow=route_chart(calc)
    assert flow.layout.meta["diagram"]=="decision_workflow"
    assert not set(flow.layout.meta["nodes"])&set(graph.layout.meta["nodes"])
    fixed=dependency_chart({**calc,"operation":{"known":True}})
    assert any("Fixed by record" in label for trace in fixed.data if trace.text for label in trace.text)
    assert "Observation variable" in [trace.name for trace in fixed.data]


def test_legacy_snapshots_without_structure_are_explicit():
    graph=dependency_chart({"states":[]})
    assert "Variable-dependency metadata is unavailable" in graph.layout.annotations[0].text
    assert not graph.data


def test_unknown_operation_displays_reference_and_branch_residuals():
    calc={"evidence_state":{"residual_scope":"operating-state mixture reference; likelihood uses branch residuals",
                            "residuals":{"voltage_pu":{"raw_z":.2,"used_z":.2}}},
          "states":[{"energized":True,"residuals":{"voltage_pu":-4.}},
                    {"energized":False,"residuals":{"voltage_pu":.1}},
                    {"energized":True,"residuals":{"voltage_pu":-4.}}],
          "summaries":{"prior":{"energized":.9},"with_visual":{"energized":.25}}}
    table=evidence_table(calc,{"voltage_pu":0.})
    assert "Used z" not in table.columns
    assert "Reference scaled z" in table.columns
    branches=operating_residual_table(calc)
    assert len(branches)==2
    assert set(branches["Voltage proxy · p.u."])=={"-4.00","+0.10"}
    assert "Operating state · energized" in probability_chart(calc).data[0].y
