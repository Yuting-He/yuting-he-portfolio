"""Integration checks at the exposed configuration boundaries."""
from dataclasses import asdict
from copy import deepcopy

import pytest

from gridscout.impact import expected_service, actual_service
from gridscout.models import ScenarioConfig
from gridscout.simulation import auto_run, create_simulation


@pytest.mark.parametrize("hazard", ["Storm", "Wildfire", "Heatwave"])
@pytest.mark.parametrize("sensors,accuracy,budget", [(1, 0.5, 20), (4, 1.0, 180)])
def test_hazard_fleet_and_accuracy_extremes(hazard, sensors, accuracy, budget):
    config = ScenarioConfig(hazard=hazard, severity="Low" if sensors == 1 else "High",
                            sensor_count=sensors, sensitivity=accuracy, specificity=accuracy,
                            mission_minutes=budget, endurance_minutes=30, seed=99)
    sim = create_simulation(config)
    original_truth = deepcopy(asdict(sim.environment))
    original_outage = actual_service(sim.grid, sim.environment)
    auto_run(sim)
    assert sim.mission.finished
    assert sim.mission.time <= config.mission_minutes + 1e-8
    assert asdict(sim.environment) == original_truth  # Inspecting cannot repair.
    assert actual_service(sim.grid, sim.environment) == original_outage
    assert all(abs(sum(p) - 1) < 1e-10 for p in sim.beliefs.zone_severity.values())
    assert all(0 <= p <= 1 for p in sim.beliefs.line_probabilities.values())
    estimate = expected_service(sim.grid, sim.beliefs, samples=128,
                                sensitivity=accuracy, specificity=accuracy)
    assert estimate["disconnected_customers"] + estimate["supplied_customers"] == pytest.approx(1829)
    assert estimate["unserved_kw"] + estimate["supplied_kw"] == pytest.approx(8640)
    assert 0 <= estimate["critical_disconnected"] <= 4
