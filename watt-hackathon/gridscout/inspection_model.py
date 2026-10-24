"""Hand-specified, synthetic inspection likelihoods shared by all model users.

These assumptions are deliberately modality-specific and are not calibrated to
real cameras. A usable RGB view detects mechanical evidence; it cannot rule out
a thermal-only defect. Coverage describes the probability of obtaining a usable
view before collection, not a second likelihood on an already usable result.
"""
from __future__ import annotations

import math

MODEL_ID = "synthetic-inspection-v2; hand-specified, uncalibrated"
MODALITIES = ("rgb", "thermal", "combined")
QUALITY_FACTORS = {"valid": 1.0, "suspect": .5}
VISIBILITY_FACTORS = {"clear": 1.0, "limited": .6, "poor": .25, "obscured": 0.0}
DEFAULT_COVERAGE = .88


def _probability(value, default):
    try:
        value = float(value)
    except (ValueError, TypeError, OverflowError):
        return default
    return min(1.0, max(0.0, value)) if math.isfinite(value) else default


def inspection_spec(visual=None) -> dict:
    """Normalize view metadata; legacy result strings use RGB defaults.

    Missing metadata has explicit demo defaults. Unknown or invalid metadata is
    unusable, giving neutral evidence. Optional mechanical_sensitivity and
    false_positive_probability are explicit synthetic calibration overrides;
    they never make RGB sensitive to thermal-only damage.
    """
    visual = visual if isinstance(visual, dict) else {}
    modality = str(visual.get("modality", "rgb")).lower()
    quality = str(visual.get("quality", "valid")).lower()
    visibility = str(visual.get("visibility", "clear")).lower()
    usable = (modality in MODALITIES and quality in QUALITY_FACTORS
              and visibility in VISIBILITY_FACTORS and VISIBILITY_FACTORS.get(visibility, 0) > 0)
    discrimination = QUALITY_FACTORS.get(quality, 0) * VISIBILITY_FACTORS.get(visibility, 0) if usable else 0.0
    return {"modality": modality, "quality": quality, "visibility": visibility,
            "usable": usable, "coverage": DEFAULT_COVERAGE * discrimination,
            "discrimination": discrimination,
            "mechanical_sensitivity": _probability(visual.get("mechanical_sensitivity"), .85),
            "thermal_sensitivity": .90,
            "false_positive_probability": _probability(visual.get("false_positive_probability"), .08),
            "model": MODEL_ID, "synthetic": True, "calibrated": False}


def inspection_positive_probability(mechanical, thermal, spec) -> float:
    """P(supports | M,T, usable view and view metadata).

    A shared false-positive channel plus independent detectable-defect channels
    forms a noisy-OR. Normalization preserves the stated single-defect
    sensitivities (.85 mechanical, .90 thermal) rather than adding FP twice.
    Degraded views shrink discrimination toward the healthy FP probability.
    """
    spec = inspection_spec(spec)
    fp = spec["false_positive_probability"]
    if not spec["usable"]:
        return fp
    sensitivities = []
    if mechanical and spec["modality"] in ("rgb", "combined"):
        sensitivities.append(spec["mechanical_sensitivity"])
    if thermal and spec["modality"] in ("thermal", "combined"):
        sensitivities.append(spec["thermal_sensitivity"])
    if not sensitivities:
        return fp
    # The normal table is a noisy-OR with nonnegative detection probabilities.
    # A legacy override below FP is retained as an explicit anti-informative
    # mechanical test; combine deviations multiplicatively for that edge case.
    if len(sensitivities) == 1:
        positive = sensitivities[0]
    else:
        no_support = math.prod(1.0-sensitivity for sensitivity in sensitivities)
        no_support /= (1.0-fp) ** (len(sensitivities)-1) if fp < 1.0 else 1.0
        positive = min(1.0, max(0.0, 1.0 - no_support))
    return fp + spec["discrimination"] * (positive - fp)


def inspection_likelihood(mechanical, thermal, result, spec) -> float:
    """Conditional likelihood of a received view; inconclusive is neutral."""
    spec = inspection_spec(spec)
    if not spec["usable"] or result not in ("supports", "clear"):
        return 1.0
    positive = inspection_positive_probability(mechanical, thermal, spec)
    return positive if result == "supports" else 1.0 - positive
