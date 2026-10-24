"""Selection updates only the node explorer and preserves mission evidence."""
from copy import deepcopy
from pathlib import Path

from streamlit.testing.v1 import AppTest


def test_node_selection_and_clear_preserve_the_simulation():
    app=AppTest.from_file(str(Path(__file__).parents[1]/"app.py"),default_timeout=60).run()
    app.radio(key="app_view").set_value("Interactive dashboard").run()
    assert not app.exception
    simulation=app.session_state["tw_sim"]
    asset=simulation.drones[0].asset_id
    snapshot=deepcopy(simulation.export())
    key=f"tw_bn_selected_node_{asset}_Current window"
    app.selectbox(key=key).select("M").run()
    assert not app.exception
    assert simulation.export()==snapshot
    assert any(metric.label=="P(M = true | current evidence)" for metric in app.metric)
    assert any("Parents: W" in caption.value for caption in app.caption)
    app.selectbox(key=key).select("ZT").run()
    assert not app.exception
    assert simulation.export()==snapshot
    assert any("Continuous observation:" in text.value for text in app.markdown)
    next(button for button in app.button if button.label=="Show all").click().run()
    assert not app.exception
    assert app.selectbox(key=key).value=="__all__"
    assert simulation.export()==snapshot
