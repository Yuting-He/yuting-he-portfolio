"""Physical-density checks for the hand-specified latent operating state."""
import math

import pytest

from gridscout.asset_inference import infer_asset


@pytest.mark.parametrize("voltage, prior, quality", [(.15, .7, "valid"), (.95, .4, "valid"),
                                                   (.3, .7, "suspect")])
def test_unknown_operating_state_matches_independent_physical_density(voltage, prior, quality):
    # Different physical standard deviations expose a missing change-of-variable
    # factor: mixing standardized densities alone gives a different posterior.
    channels = ("temperature_c", "vibration_rms", "voltage_pu", "tilt_deg")
    reference = {channel: {"mean": 0., "sd": 1.} for channel in channels}
    on = {**reference, "voltage_pu": {"mean": 1., "sd": .1}}
    off = {**reference, "voltage_pu": {"mean": 0., "sd": .2}}
    baseline = {**reference, "operating_components": {"on": on, "off": off}}
    observed = infer_asset({"voltage_pu": voltage, "quality": quality}, baseline,
                           {"energized": None, "energized_prior": prior})
    fault_prior = .35 if quality == "suspect" else .045
    scale = 1.5 if quality == "suspect" else 1.

    def normal(value, mean, sd):
        return math.exp(-.5*((value-mean)/sd)**2)/(sd*math.sqrt(2*math.pi))

    def physical_likelihood(mean, sd):
        healthy = normal(voltage, mean, sd*scale)
        broad = normal(voltage, mean, sd*scale*8)
        # F=temperature/mechanical (80%) leaves voltage healthy; the remaining
        # voltage/all families (20%) broaden this channel when S=True.
        return (1-fault_prior)*healthy+fault_prior*(.8*healthy+.2*broad)

    on_weight = prior*physical_likelihood(1., .1)
    off_weight = (1-prior)*physical_likelihood(0., .2)
    assert observed["energized"] == pytest.approx(on_weight/(on_weight+off_weight))
    assert sum(row["probability"] for row in observed["joint_states"]) == pytest.approx(1)
