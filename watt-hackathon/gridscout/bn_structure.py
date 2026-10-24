"""Hand-specified conditional BN; shared graph metadata, never learned at runtime.

W includes current weather and known/unknown load. Q includes observation mode,
quality and baseline calibration. F is marginalized in the likelihood; E is
clamped by an explicit operation record or enumerated when that record is unknown.
"""


def model_structure():
    nodes = [
        ("W", "Current weather / load context", "condition"),
        ("Q", "Sensor quality / mode / calibration", "condition"),
        ("O", "Operating record / stated prior", "condition"),
        ("E", "E · Energized state", "latent"),
        ("M", "M · Mechanical anomaly", "latent"),
        ("T", "T · Thermal anomaly", "latent"),
        ("S", "S · Sensor / installation fault", "latent"),
        ("F", "F · Affected channel family", "latent"),
        ("ZM", "Vibration + tilt · joint observation", "observed"),
        ("ZT", "Temperature observation", "observed"),
        ("ZV", "Voltage proxy observation", "observed"),
        ("I", "Inspection modality / quality / visibility", "condition"),
        ("R", "Inspection result", "observed"),
    ]
    edges = [("O", "E"), ("W", "M"), ("E", "T"), ("Q", "S"), ("S", "F"),
             ("M", "ZM"), ("F", "ZM"), ("T", "ZT"), ("F", "ZT"),
             ("F", "ZV"), ("E", "ZT"), ("E", "ZV"),
             ("W", "ZM"), ("W", "ZT"), ("Q", "ZM"), ("Q", "ZT"), ("Q", "ZV"),
             ("M", "R"), ("T", "R"), ("I", "R")]
    return {"specified_by": "manual", "learned": False, "version": "asset-bn-2",
            "nodes": [{"id": key, "label": label, "kind": kind} for key, label, kind in nodes],
            "edges": [list(edge) for edge in edges],
            "factorization": "P(E|O) P(M|W) P(T|E) P(S|Q) P(F|S) "
                             "P(ZM|M,F,W,Q) P(ZT|T,F,E,W,Q) P(ZV|F,E,Q) P(R|M,T,I)"}
