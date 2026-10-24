"""Default delivery and mutable dashboard isolation through the Streamlit shell."""
from pathlib import Path

from streamlit.testing.v1 import AppTest

from gridscout import showcase_ui


def app():
    return AppTest.from_file(str(Path(__file__).parents[1] / "app.py"), default_timeout=60).run()


def test_showcase_is_default_and_does_not_start_the_simulation():
    a = app()
    assert not a.exception
    assert a.radio(key="app_view").value == "Judge showcase"
    assert "tw_sim" not in a.session_state
    assert not a.selectbox
    assert not a.tabs


def test_showcase_missing_build_keeps_the_dashboard_accessible(monkeypatch, tmp_path):
    monkeypatch.setattr(showcase_ui, "SHOWCASE_DOCUMENT", tmp_path / "missing.html")
    a = app()
    assert not a.exception
    assert any("has not been built yet" in item.value for item in a.info)
    a.radio(key="app_view").set_value("Interactive dashboard").run()
    assert not a.exception
    assert len(a.tabs) == 5


def test_return_to_showcase_pauses_and_preserves_interactive_state():
    a = app()
    a.radio(key="app_view").set_value("Interactive dashboard").run()
    a.toggle(key="tw_auto").set_value(False)
    a.checkbox(key="tw_follow").uncheck().run()
    simulation = a.session_state["tw_sim"]
    target = next(asset for asset in simulation.dataset.segments if asset not in simulation.latest)
    a.selectbox(key="tw_asset").select(target).run()
    next(button for button in a.button if button.label == "Play stream").click().run()
    minute = simulation.minute
    assert a.session_state["tw_playing"]

    a.radio(key="app_view").set_value("Judge showcase").run()
    assert not a.exception
    assert not a.session_state["tw_playing"]
    assert a.session_state["tw_sim"] is simulation
    assert simulation.minute == minute
    a.run()
    assert simulation.minute == minute

    a.radio(key="app_view").set_value("Interactive dashboard").run()
    assert not a.exception
    assert len(a.tabs) == 5
    assert simulation.minute == minute
    assert not a.toggle(key="tw_auto").value
    assert not a.checkbox(key="tw_follow").value
    assert a.selectbox(key="tw_asset").value == target


def test_workspace_selection_survives_showcase_visit():
    a = app()
    a.radio(key="app_view").set_value("Interactive dashboard").run()
    a.selectbox(key="app_workspace").select("Official challenge · Bavaria").run()
    state = a.session_state["oc_state"]
    a.radio(key="app_view").set_value("Judge showcase").run()
    a.radio(key="app_view").set_value("Interactive dashboard").run()
    assert not a.exception
    assert a.selectbox(key="app_workspace").value == "Official challenge · Bavaria"
    assert a.session_state["oc_state"] is state
