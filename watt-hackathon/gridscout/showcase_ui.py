"""Host the same self-contained judge experience used by the public website."""
from pathlib import Path

import streamlit as st
import streamlit.components.v1 as components


SHOWCASE_DOCUMENT = Path(__file__).resolve().parents[1] / "dist" / "index.html"
SCHEDULE_DOCUMENT = Path(__file__).resolve().parents[1] / "dist" / "schedule.html"

# Keep exploration choices while their widgets are hidden. Button and chart state
# must not be reassigned through Session State, so only input keys are detached.
_PERSISTENT_INPUTS = {
    "app_workspace", "tw_auto", "tw_follow", "tw_scenario", "tw_seed", "tw_asset",
    "tw_explain", "tw_visual", "tw_inspection_modality", "tw_inspection_visibility",
    "tw_inspection_quality", "tw_move_drone", "tw_destination", "tw_manual_speed",
    "tw_field_cost", "tw_fp_cost", "tw_cost_review_modality", "tw_cost_review_visibility",
    "tw_cost_review_quality", "ui_policy", "ui_mode", "benchmark_seeds",
}
_PERSISTENT_PREFIXES = (
    "cfg_", "of_", "tw_bn_selected_node_", "tw_bn_operation_", "tw_bn_scope_",
    "tw_bn_preview_",
)


def pause_interactive_dashboard(session):
    """Pause the mutable stream without creating or resetting its simulation."""
    if "tw_playing" in session:
        session["tw_playing"] = False
    for key in list(session):
        if key in _PERSISTENT_INPUTS or str(key).startswith(_PERSISTENT_PREFIXES):
            session[key] = session[key]


def render_showcase():
    """Embed the offline-capable build; a missing build leaves exploration usable."""
    if not SHOWCASE_DOCUMENT.is_file():
        st.info("The showcase preview has not been built yet. Build the self-contained website, then reload this page.")
        st.code("python web/build.py", language="bash")
        st.caption(f"Expected preview: {SHOWCASE_DOCUMENT}")
        st.caption("Choose Interactive dashboard above to explore the full simulation.")
        return

    components.html(SHOWCASE_DOCUMENT.read_text(encoding="utf-8"), height=980, scrolling=True)


def render_schedule_showcase():
    """Show the teammate's route using the same offline document as the website."""
    if not SCHEDULE_DOCUMENT.is_file():
        st.info("The route showcase has not been built yet. Build it, then reload this page.")
        st.code("python web/build.py", language="bash")
        return
    components.html(SCHEDULE_DOCUMENT.read_text(encoding="utf-8"), height=1150, scrolling=True)
