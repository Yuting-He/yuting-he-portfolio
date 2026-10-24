"""Explicit operating records and a declared, uncalibrated unknown-state prior."""
import math


def operating_context(context):
    state = context.get("energized")
    known = type(state) is bool
    try:
        prior = float(context.get("energized_prior", .9))
        if not math.isfinite(prior):
            prior = .9
    except (TypeError, ValueError, OverflowError):
        prior = .9
    # Unknown means both branches remain possible. Known records clamp E.
    unknown_prior = min(.999999, max(.000001, prior))
    prior = float(state) if known else unknown_prior
    return {"status": "known_on" if known and state else "known_off" if known else "unknown",
            "known": known, "energized": state if known else None,
            "prior_energized": prior,
            "unknown_prior_energized": unknown_prior,
            "source": context.get("operating_source") or (
                "Provided operating record" if known else "No reliable record; stated demo prior"),
            "assumptions": "Unknown-state prior: manually specified demonstration parameter. Charging uses explicit powered-site records."}
