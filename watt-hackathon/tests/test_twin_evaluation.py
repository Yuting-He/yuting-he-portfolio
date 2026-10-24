"""Denominator and provenance checks for synthetic snapshot validation."""
import json

import pytest

from gridscout.synthetic_telemetry import SCENARIOS
from gridscout.twin_evaluation import main, run_twin_evaluation, EVALUATION_SCENARIOS


@pytest.fixture(scope="module")
def report():
    return run_twin_evaluation([42], minute=55)


def test_snapshot_evaluation_reproducible_and_no_executed_actions(report):
    assert run_twin_evaluation([42], minute=55) == report
    assert report["metadata"]["executed_optional_actions"] == 0
    assert len(report["cases"]) == len(EVALUATION_SCENARIOS) == 6
    for case in report["cases"]:
        assert len(case["rows"]) == 5
        assert all(row["asset_id"] == row["original_asset_id"] for row in case["rows"])
        assert not any(event["type"] in {"relocation", "arrival", "visual_review"} for event in case["audit"])


def test_positive_negative_missing_denominators_are_explicit(report):
    counts = report["overall"]["counts"]
    assert counts["stationed_samples"] == 30
    assert counts["observed"] == 29
    assert counts["missing"] == 1
    assert counts["asset_positive_all_samples"] == 2
    assert counts["asset_negative_all_samples"] == 28
    assert counts["asset_positive_missing"] == 0
    assert counts["asset_negative_missing"] == 1
    assert counts["drift_positive_all_samples"] == 1
    for key in ("asset_detection", "high_cost_recommendations", "sensor_drift_detection"):
        score = report["overall"][key]
        assert score["denominator_observed"] == 29
        assert sum(score["confusion"].values()) == 29
    missing = [row for case in report["cases"] for row in case["rows"] if not row["observed"]]
    assert len(missing) == 1 and missing[0]["truth"]["communication_loss"]
    assert missing[0]["inference"]["status"] == "Unknown"
    assert all(case["unobserved_mapped_assets_not_scored"] == 59 for case in report["cases"])


def test_report_records_raw_audit_and_no_calibration_claim(report):
    assert json.loads(json.dumps(report, allow_nan=False)) == report
    assert report["metadata"]["seeds"] == [42]
    assert report["metadata"]["anomaly_threshold"] == .65
    assert any("calibration" in text for text in report["metadata"]["assumptions"])
    for case in report["cases"]:
        assert case["audit"]
        for row in case["rows"]:
            assert row["reading"]["received_at"] <= case["minute"]
            assert "baseline" in row["reading"]
            assert row["recommendations"][0]["recommended"]
            assert not (set(row["truth"]) & set(row["reading"]))


def test_snapshot_before_injection_does_not_invent_positive_labels():
    result = run_twin_evaluation([7], minute=0)
    assert result["overall"]["counts"]["asset_positive_all_samples"] == 0
    assert result["overall"]["counts"]["missing"] == 0
    assert result["overall"]["counts"]["drift_positive_all_samples"] == 0


def test_cli_writes_finite_report(tmp_path):
    output = tmp_path / "nested" / "validation.json"
    expected = main(["--seeds", "1", "--start-seed", "7", "--minute", "0", "--output", str(output)])
    assert json.loads(output.read_text(encoding="utf-8")) == expected


@pytest.mark.parametrize("kwargs", [{"seeds": 0}, {"seeds": []}, {"seeds": [2, 2]},
                                    {"seeds": [True]}, {"minute": 241}, {"minute": -1},
                                    {"minute": 2.5}, {"anomaly_threshold": float("nan")},
                                    {"sensor_threshold": 1.1}])
def test_bad_configuration_rejected(kwargs):
    with pytest.raises(ValueError):
        run_twin_evaluation(**kwargs)
