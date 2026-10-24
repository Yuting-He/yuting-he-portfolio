"""Node explanations use the selected calculation and its recorded evidence."""
from copy import deepcopy
import json

import pytest

from gridscout.asset_inference import infer_asset
from gridscout.bn_node_details import node_details
from gridscout.bn_structure import model_structure
from gridscout.conditional_baseline import fit_normal_baseline
from gridscout.inspection_model import inspection_positive_probability, inspection_spec


@pytest.fixture
def snapshot():
    context = {"ambient_c": 21., "wind_mps": 4., "gust_mps": 18., "solar_wm2": 320.,
               "load_pu": None, "energized": True}
    baseline = fit_normal_baseline().predict(context)
    reading = {channel: baseline[channel]["mean"] for channel in
               ("temperature_c", "vibration_rms", "tilt_deg", "voltage_pu")}
    reading.update(quality="valid", mode="perched", baseline_version="snapshot-baseline")
    reading["temperature_c"] += 5
    visual = {"result": "supports", "modality": "combined", "quality": "suspect", "visibility": "limited"}
    calculation = infer_asset(reading, baseline, context, visual)["calculation"]
    return calculation, reading, context


def test_all_nodes_have_direct_definitions_and_actual_neighbors(snapshot):
    calculation, reading, context = snapshot
    before = deepcopy(snapshot)
    structure = model_structure()
    for node in structure["nodes"]:
        details = node_details(calculation, node["id"], reading, context)
        assert details["title"] == node["label"]
        assert details["definition"] and details["basis"]
        assert details["parents"] == [a for a, b in structure["edges"] if b == node["id"]]
        assert details["children"] == [b for a, b in structure["edges"] if a == node["id"]]
        assert "not " not in details["definition"].lower()
        json.dumps(details, allow_nan=False)
    assert snapshot == before


@pytest.mark.parametrize("node,name", [("M", "mechanical"), ("T", "thermal"), ("S", "sensor_fault")])
def test_latent_probabilities_equal_selected_posterior(snapshot, node, name):
    calculation, reading, context = snapshot
    details = node_details(calculation, node, reading, context)
    assert details["probability"] == calculation["summaries"]["with_visual"][name]
    assert details["probability"] == pytest.approx(sum(row["posterior_probability"]
        for row in calculation["states"] if row[name]))
    assert "current evidence" in details["probability_label"]


def test_fault_family_weights_are_conditional_priors(snapshot):
    details = node_details(snapshot[0], "F")
    assert details["probability"] is None
    assert details["value"] == "Marginalized"
    assert details["distribution"] == {"temperature": .4, "mechanical": .4, "voltage": .1, "all": .1}
    assert details["probability_label"] == "Conditional prior P(F | S = true)"
    historical = deepcopy(snapshot[0])
    historical["likelihood_groups"][-1]["weights"] = {"mechanical": .8, "all": .2}
    assert node_details(historical, "F")["distribution"] == {"mechanical": .8, "all": .2}


@pytest.mark.parametrize("node,channel", [("ZM", "vibration_rms"), ("ZT", "temperature_c"), ("ZV", "voltage_pu")])
def test_continuous_nodes_show_recorded_measurements_and_residuals(snapshot, node, channel):
    calculation, reading, context = snapshot
    original = reading[channel]
    altered_reading = {**reading, channel: 9999.}
    details = node_details(calculation, node, altered_reading, context)
    measurement = next(row for row in details["channel_values"] if row["channel"] == channel)
    assert details["probability"] is None
    assert measurement["observed"] == original
    assert measurement["used_z"] == calculation["evidence_state"]["residuals"][channel]["used_z"]
    assert measurement["used"]


def test_inspection_prediction_uses_sensor_only_state_weights(snapshot):
    calculation, _, _ = snapshot
    details = node_details(calculation, "R")
    spec = inspection_spec(calculation["visual"]["spec"])
    expected = sum(row["posterior_without_visual"] * inspection_positive_probability(
        row["mechanical"], row["thermal"], spec) for row in calculation["states"])
    assert details["value"] == "supports"
    assert details["probability"] == pytest.approx(expected)
    assert "sensor evidence" in details["probability_label"]
    # Historical likelihoods retain the original camera model.
    historical = deepcopy(calculation)
    for row in historical["states"]:
        row["visual_likelihood"] = .42
    assert node_details(historical, "R")["probability"] == pytest.approx(.42)
    historical["visual"]["result"] = "clear"
    assert node_details(historical, "R")["probability"] == pytest.approx(.58)


def test_invalid_inspection_has_no_predictive_probability(snapshot):
    calculation = deepcopy(snapshot[0])
    calculation["visual"]["spec"]["quality"] = "invalid"
    calculation["visual"]["used"] = False
    details = node_details(calculation, "R")
    assert details["probability"] is None
    assert "Inspection evidence: unusable view." in details["basis"]


def test_unknown_asset_and_operating_prior_scopes(snapshot):
    _, reading, context = snapshot
    context = {**context, "energized": None, "energized_prior": .67}
    baseline = fit_normal_baseline().predict(context)
    unusable = {**reading, "quality": "invalid"}
    calculation = infer_asset(unusable, baseline, context)["calculation"]
    for node in ("M", "T", "S"):
        details = node_details(calculation, node, unusable, context)
        assert details["probability"] is None
        assert details["value"] == "Unassessed"
    energized = node_details(calculation, "E")
    assert energized["probability"] == pytest.approx(.67)
    assert energized["probability_label"] == "Declared P(E = energized)"
    context["energized"] = False
    calculation = infer_asset(unusable, fit_normal_baseline().predict(context), context)["calculation"]
    assert node_details(calculation, "E")["probability"] == 0.
    assert "operating record" in node_details(calculation, "E")["probability_label"]


def test_unknown_operation_shows_each_likelihood_branch(snapshot):
    _, reading, context = snapshot
    context = {**context, "energized": None}
    calculation = infer_asset(reading, fit_normal_baseline().predict(context), context)["calculation"]
    details = node_details(calculation, "ZT", reading, context)
    for key, label in (("on", "Energized"), ("off", "De-energized")):
        residual = calculation["evidence_state"]["operating_residuals"][key]["temperature_c"]
        assert f"{label} branch: Temperature z = {residual:+.2f}." in details["basis"]
    assert node_details(calculation, "E")["probability"] == calculation["summaries"]["with_visual"]["energized"]


def test_unknown_node_is_rejected():
    with pytest.raises(ValueError, match="Unknown BN node"):
        node_details({}, "posterior")
