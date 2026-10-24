"""Small, Streamlit-independent lifecycle helpers for safe scenario reset."""
from __future__ import annotations

from collections.abc import MutableMapping
from typing import Any, Callable

from .models import ScenarioConfig


SESSION_PREFIX = "gs_"


def reset_session(
    state: MutableMapping[str, Any],
    config: ScenarioConfig,
    factory: Callable | None = None,
) -> None:
    """Replace the simulation and derived results, preserving unrelated UI state.

    Construct first so an invalid configuration cannot destroy a working session.
    No hidden truth or generator is reused across resets.
    """
    if factory is None:
        from .simulation import create_simulation

        factory = create_simulation
    simulation = factory(config)
    for key in list(state):
        if str(key).startswith(SESSION_PREFIX):
            del state[key]
    state["gs_config"] = config
    state["gs_simulation"] = simulation
    state["gs_recommendations"] = []
    state["gs_benchmark"] = None
    state["gs_previous_target"] = None


def ensure_session(state: MutableMapping[str, Any]) -> None:
    if "gs_simulation" not in state:
        reset_session(state, ScenarioConfig())
