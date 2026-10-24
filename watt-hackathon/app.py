"""GridScout: a self-guided showcase and the full interactive workspaces."""
import streamlit as st

from gridscout.showcase_ui import pause_interactive_dashboard, render_showcase

st.set_page_config(page_title="GridScout | Showcase", page_icon="⚡", layout="wide")
view = st.radio(
    "Experience", ["Judge showcase", "Interactive dashboard"], horizontal=True,
    key="app_view", label_visibility="collapsed",
)

if view == "Judge showcase":
    pause_interactive_dashboard(st.session_state)
    render_showcase()
else:
    workspace = st.sidebar.selectbox(
        "Workspace", ["Digital twin · Live simulation", "Official challenge · Bavaria", "Synthetic laboratory"], key="app_workspace")

    if workspace == "Digital twin · Live simulation":
        from gridscout.twin_ui import render_twin
        render_twin()
    elif workspace == "Official challenge · Bavaria":
        from gridscout.challenge_ui import render_official
        render_official()
    else:
        from gridscout.lab_ui import render_lab
        render_lab()
