"""Independent checks for modality-specific received and planned inspections."""
import hashlib
import itertools
import random

import pytest

from gridscout.action_policy import DEFAULT_COSTS, recommend_actions
from gridscout.inspection_model import (
    inspection_likelihood, inspection_positive_probability, inspection_spec,
)
from gridscout.synthetic_inspection import generate_inspection


def test_modality_likelihood_table_and_noisy_or():
    expected = {"rgb": (.08, .85, .08, .85),
                "thermal": (.08, .08, .90, .90),
                "combined": (.08, .85, .90, 1-.15*.10/.92)}
    for modality, probabilities in expected.items():
        spec = inspection_spec({"modality": modality})
        for (m, t), positive in zip(((False, False), (True, False), (False, True), (True, True)), probabilities):
            assert inspection_positive_probability(m, t, spec) == pytest.approx(positive)
            assert inspection_likelihood(m, t, "supports", spec) == pytest.approx(positive)
            assert inspection_likelihood(m, t, "clear", spec) == pytest.approx(1-positive)


def test_normalization_is_explicit_idempotent_and_uncalibrated():
    default = inspection_spec()
    assert default == inspection_spec(default)
    assert default["modality"] == "rgb"
    assert default["quality"] == "valid" and default["visibility"] == "clear"
    assert default["coverage"] == .88 and default["usable"]
    assert default["synthetic"] and not default["calibrated"]
    assert "uncalibrated" in default["model"]


@pytest.mark.parametrize("metadata", [{"modality": "xray"}, {"quality": "stale"},
                                      {"quality": "missing"}, {"visibility": "unknown"},
                                      {"visibility": "obscured"}])
def test_unknown_or_unusable_metadata_provides_no_evidence(metadata):
    spec = inspection_spec(metadata)
    assert not spec["usable"] and spec["coverage"] == 0
    for m, t in itertools.product((False, True), repeat=2):
        for result in ("supports", "clear", "inconclusive", "invalid"):
            assert inspection_likelihood(m, t, result, spec) == 1


def test_quality_and_visibility_weaken_discrimination_and_coverage():
    good = inspection_spec()
    limited = inspection_spec({"visibility": "limited"})
    poor = inspection_spec({"visibility": "poor", "quality": "suspect"})
    assert good["coverage"] > limited["coverage"] > poor["coverage"] > 0
    assert .08 < inspection_positive_probability(True, False, poor) < inspection_positive_probability(True, False, limited) < .85
    assert inspection_positive_probability(False, False, poor) == .08
    assert inspection_likelihood(True, True, "inconclusive", poor) == 1


def _inference(states):
    return {"status": "Investigate", "joint_states": [
        {"mechanical": m, "thermal": t, "sensor_fault": s, "probability": p}
        for m, t, s, p in states]}


def _remote(inference, **kwargs):
    return next(a for a in recommend_actions(inference, **kwargs) if a["action"] == "remote_review")


def test_three_outcome_evsi_matches_analytic_correlated_state_enumeration():
    # M and T are negatively associated; inspection must retain their joint
    # identities rather than reducing them to one damage bit before review.
    states = [(False, False, False, .65), (True, False, False, .15),
              (False, True, False, .18), (True, True, False, .02)]
    inference = _inference(states)
    remote = _remote(inference, minutes_to_review=5)
    c = DEFAULT_COSTS
    p = .35
    terminal = lambda a: min(a*c["missed_event"], c["field_check"]+(1-a)*c["false_positive"]+a*c["residual_event"])
    downstream = 0
    for outcome, probabilities in (("supports", [.88*(.85 if m else .08) for m,t,s,w in states]),
                                   ("clear", [.88*(.15 if m else .92) for m,t,s,w in states]),
                                   ("inconclusive", [.12]*4)):
        predictive = sum(state[3]*likelihood for state, likelihood in zip(states, probabilities))
        anomaly = sum(state[3]*likelihood for state, likelihood in zip(states, probabilities) if state[0] or state[1])/predictive
        downstream += predictive*terminal(anomaly)
        actual = next(row for row in remote["outcomes"] if row["result"] == outcome)
        assert actual["probability"] == pytest.approx(predictive)
        assert actual["anomaly"] == pytest.approx(anomaly)
    assert remote["evsi"] == pytest.approx(terminal(p)-downstream)
    assert remote["expected_loss"] == pytest.approx(c["remote_review"]+p*c["waiting_per_minute"]*5+downstream)


def test_rgb_clear_does_not_resolve_thermal_only_damage_or_create_evsi():
    inference = _inference([(False, False, False, .8), (False, True, False, .2)])
    rgb = _remote(inference)
    assert {row["result"] for row in rgb["outcomes"]} == {"supports", "clear", "inconclusive"}
    assert all(row["thermal"] == pytest.approx(.2) for row in rgb["outcomes"])
    assert rgb["evsi"] == pytest.approx(0)
    thermal = _remote(inference, inspection={"modality": "thermal"})
    assert thermal["evsi"] > 0
    assert next(row for row in thermal["outcomes"] if row["result"] == "clear")["thermal"] < .2


def test_unusable_review_is_neutral_and_legacy_overrides_do_not_change_modality():
    inference = _inference([(False, False, False, .8), (False, True, False, .2)])
    unusable = _remote(inference, inspection={"visibility": "obscured"})
    assert len(unusable["outcomes"]) == 1
    assert unusable["outcomes"][0]["result"] == "inconclusive"
    assert unusable["outcomes"][0]["probability"] == 1
    assert unusable["evsi"] == 0
    overrides = _remote(inference, costs={"remote_sensitivity": 1, "remote_specificity": 1})
    assert overrides["evsi"] == pytest.approx(0)
    assert overrides["inspection_spec"]["thermal_sensitivity"] == .90
    assert all(row["thermal"] == pytest.approx(.2) for row in overrides["outcomes"])


def test_generator_default_preserves_mechanical_demo_rng_and_is_reproducible():
    kwargs = dict(scenario="mechanical", seed=42, anomaly_asset_id="LINE_026")
    for i in range(30):
        operation = f"preserve-{i}"
        digest = hashlib.sha256(repr((42, operation, "inspection-camera-v1")).encode()).digest()
        rng = random.Random(int.from_bytes(digest[:8], "little"))
        expected = "inconclusive" if rng.random() < .12 else "supports" if rng.random() < .85 else "clear"
        observation = generate_inspection("Drone 1", "LINE_026", 59, operation, **kwargs)
        assert observation["result"] == expected
        assert observation == generate_inspection("Drone 1", "LINE_026", 59, operation, **kwargs)
        assert observation["modality"] == "rgb" and not observation["calibrated"]
        assert not {"mechanical_anomaly", "thermal_anomaly", "scenario", "damaged"} & observation.keys()


def test_generator_thermal_only_rgb_matches_healthy_but_thermal_camera_detects():
    rgb, thermal, poor = [], [], []
    kwargs = dict(scenario="thermal", seed=42, anomaly_asset_id="LINE_026")
    for i in range(600):
        args = ("Drone 1", "LINE_026", 59, f"thermal-{i}")
        rgb.append(generate_inspection(*args, **kwargs)["result"])
        thermal.append(generate_inspection(*args, **kwargs, modality="thermal")["result"])
        poor.append(generate_inspection(*args, **kwargs, modality="thermal", visibility="poor")["result"])
    assert .04 < rgb.count("supports")/600 < .11
    assert .72 < thermal.count("supports")/600 < .86
    assert poor.count("inconclusive") > thermal.count("inconclusive")
    assert 0 < rgb.count("inconclusive") < 140


def test_generator_missing_communication_and_unknown_modality_are_inconclusive():
    kwargs = dict(scenario="dropout", seed=42, anomaly_asset_id="LINE_026")
    missing = generate_inspection("Drone 5", "LINE_026", 59, "missing", **kwargs)
    assert missing["result"] == "inconclusive" and missing["quality"] == "missing"
    invalid = generate_inspection("Drone 1", "LINE_026", 59, "invalid", **kwargs, modality="unknown")
    assert invalid["result"] == "inconclusive"
