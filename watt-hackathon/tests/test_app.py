from dataclasses import replace
from pathlib import Path

from gridscout.models import ScenarioConfig
from gridscout.session import ensure_session, reset_session


def _laboratory_app():
    from streamlit.testing.v1 import AppTest
    app = AppTest.from_file(str(Path(__file__).parents[1] / "app.py"), default_timeout=30).run()
    app.radio(key="app_view").set_value("Interactive dashboard").run()
    app.selectbox(key="app_workspace").select("Synthetic laboratory").run()
    return app


def test_reset_discards_derived_results_and_uses_new_configuration():
    state = {"gs_simulation": object(), "gs_recommendations": ["old"],
             "gs_benchmark": ["old"], "gs_service": "old", "gs_previous_target": "L01", "unrelated": 7}
    config = replace(ScenarioConfig(), seed=19, sensor_count=3)
    reset_session(state, config)
    assert state["gs_simulation"].config == config
    assert state["gs_simulation"].mission.completed == []
    assert len(state["gs_simulation"].mission.sensors) == 3
    assert state["gs_recommendations"] == []
    assert state["gs_benchmark"] is None
    assert state["gs_previous_target"] is None
    assert "gs_service" not in state
    assert state["unrelated"] == 7


def test_failed_reset_preserves_existing_state():
    state = {"gs_simulation": "working", "gs_benchmark": [1]}
    def broken_factory(config):
        raise RuntimeError("Could not build scenario")
    import pytest
    with pytest.raises(RuntimeError):
        reset_session(state, ScenarioConfig(), factory=broken_factory)
    assert state == {"gs_simulation": "working", "gs_benchmark": [1]}


def test_ensure_session_is_idempotent():
    state = {}
    ensure_session(state)
    first = state["gs_simulation"]
    ensure_session(state)
    assert state["gs_simulation"] is first


def test_streamlit_launch_inspect_and_reset():
    from streamlit.testing.v1 import AppTest
    app = _laboratory_app()
    assert not app.exception
    assert len(app.tabs) == 5
    next(button for button in app.button if button.label == "Execute Inspection").click().run()
    assert not app.exception
    assert app.session_state["gs_simulation"].mission.completed
    next(button for button in app.button if button.label == "Reset Scenario").click().run()
    assert not app.exception
    assert app.session_state["gs_simulation"].mission.completed == []
    assert app.session_state["gs_benchmark"] is None


def test_streamlit_configuration_and_demo_preset():
    from streamlit.testing.v1 import AppTest
    app = _laboratory_app()
    app.selectbox(key="cfg_hazard").select("Wildfire")
    app.number_input(key="cfg_seed").set_value(7)
    next(button for button in app.button if button.label == "Apply Configuration & Reset").click().run()
    assert not app.exception
    assert app.session_state["gs_simulation"].config.hazard == "Wildfire"
    assert app.session_state["gs_simulation"].config.seed == 7
    next(button for button in app.button if button.label == "Demo Scenario: Severe Storm").click().run()
    assert not app.exception
    assert app.session_state["gs_simulation"].config == ScenarioConfig()


def test_streamlit_advanced_benchmark_and_complete_mission():
    from streamlit.testing.v1 import AppTest
    app = _laboratory_app()
    assert not app.exception
    assert not app.slider(key="cfg_decision").disabled
    assert app.session_state["gs_opportunities"]
    app.select_slider(key="benchmark_seeds").set_value(3)
    next(button for button in app.button if button.label == "Run Paired Benchmark").click().run()
    assert not app.exception
    rows = app.session_state["gs_benchmark"]
    assert len(rows) == 18
    assert len({row["policy"] for row in rows}) == 6
    for seed in {row["seed"] for row in rows}:
        assert len({row["environment_fingerprint"] for row in rows if row["seed"] == seed}) == 1
    next(button for button in app.button if button.label == "Auto-Run Mission").click().run()
    assert not app.exception
    assert app.session_state["gs_simulation"].mission.finished
    next(button for button in app.button if button.label == "Reset Scenario").click().run()
    assert not app.exception
    assert app.session_state["gs_benchmark"] is None
    assert not app.session_state["gs_simulation"].mission.completed
