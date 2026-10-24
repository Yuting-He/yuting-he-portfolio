"""Streamlit integration for official data, charging configuration and resets."""
from pathlib import Path

from gridscout.challenge_ui import reset_official
from gridscout.challenge import ChallengeConfig


def _app():
    from streamlit.testing.v1 import AppTest
    app = AppTest.from_file(str(Path(__file__).parents[1]/"app.py"),default_timeout=40).run()
    app.radio(key="app_view").set_value("Interactive dashboard").run()
    return app.selectbox(key="app_workspace").select("Official challenge · Bavaria").run()


def test_official_default_initial_reports_and_unclear_evidence():
    app=_app()
    assert not app.exception
    assert len(app.tabs)==5
    state=app.session_state["oc_state"]
    assert len(state.sensors)==5 and len(state.dataset.reports)==6
    assert app.selectbox(key="app_workspace").value=="Official challenge · Bavaria"
    assert all(m.label!="Expected customers out" for m in app.metric)
    app.selectbox(key="of_reading").select("Inconclusive")
    next(b for b in app.button if b.label=="Execute Inspection").click().run()
    assert not app.exception
    evidence=app.session_state["oc_state"].evidence
    assert evidence[0]["reading"].result=="Inconclusive"
    assert evidence[0]["before_probabilities"]==evidence[0]["after_probabilities"]
    app.selectbox(key="of_site_line").select("LINE_024").run()
    assert next(b for b in app.button if b.label=="Apply Site Assumption").disabled


def test_official_full_mission_then_reset_and_workspace_isolation():
    app=_app()
    next(b for b in app.button if b.label=="Auto-Run Mission").click().run()
    assert not app.exception
    state=app.session_state["oc_state"]
    assert state.finished and state.time<=240
    assert any(e["type"]=="charge_complete" for e in state.history)
    assert any(e["type"]=="flight_start" for e in state.history)
    readings=len(state.readings)
    app.selectbox(key="app_workspace").select("Synthetic laboratory").run()
    assert not app.exception and "gs_simulation" in app.session_state
    app.selectbox(key="app_workspace").select("Official challenge · Bavaria").run()
    assert not app.exception
    assert len(app.session_state["oc_state"].readings)==readings
    next(b for b in app.button if b.label=="Reset Scenario").click().run()
    assert not app.exception
    state=app.session_state["oc_state"]
    assert state.time==0 and not state.evidence and not state.readings and not state.pending
    assert len(state.history)==1 and len(state.history[0]["reports"])==6


def test_conservative_ui_blocks_unverified_charging_and_relocations():
    app=_app()
    app.checkbox(key="of_conservative").check()
    next(b for b in app.button if b.label=="Apply Official Configuration & Reset").click().run()
    assert not app.exception
    assert not any(s.can_charge for s in app.session_state["oc_state"].sites.values())
    next(b for b in app.button if b.label=="Auto-Run Mission").click().run()
    assert not app.exception
    state=app.session_state["oc_state"]
    assert state.finished and state.readings
    assert not any(e["type"] in ("flight_start","charge_start") for e in state.history)


def test_failed_official_reset_preserves_working_session():
    state={"unrelated":7}
    reset_official(state)
    original=state["oc_state"]
    import pytest
    with pytest.raises(ValueError):
        reset_official(state,ChallengeConfig(start_lines=("bad1","bad2","bad3","bad4","bad5")))
    assert state["oc_state"] is original and state["unrelated"]==7
