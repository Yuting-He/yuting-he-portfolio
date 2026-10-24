"""Node selection preserves the DAG and highlights only direct dependencies."""
from copy import deepcopy

import pytest

from gridscout.bn_structure import model_structure
from gridscout.bn_ui import dependency_chart, selected_node_from_event


def test_selection_highlights_direct_neighbors_and_keeps_every_dependency():
    calculation={"structure":model_structure(),"available":True,
                 "summaries":{"with_visual":{"mechanical":.4,"thermal":.1,"sensor_fault":.2,"energized":.8}}}
    frozen=deepcopy(calculation)
    chart=dependency_chart(calculation,"S")
    assert chart.layout.meta["parents"]==["Q"]
    assert chart.layout.meta["children"]==["F"]
    assert {tuple(edge) for edge in chart.layout.meta["highlighted_edges"]}=={("Q","S"),("S","F")}
    assert chart.layout.meta["edges"]==calculation["structure"]["edges"]
    shapes={shape.name:shape for shape in chart.layout.shapes if shape.name}
    assert shapes["edge:Q:S"].opacity==shapes["edge:S:F"].opacity==1
    assert shapes["edge:M:R"].opacity<.2
    assert shapes["node:S"].line.width>shapes["node:Q"].line.width>shapes["node:M"].line.width
    assert shapes["node:Q"].line.color!=shapes["node:F"].line.color
    assert calculation==frozen
    assert dependency_chart(calculation,"unknown").layout.meta["selected_node"] is None


def test_card_click_targets_include_padding_and_carry_stable_variable_ids():
    chart=dependency_chart({"structure":model_structure()})
    targets=next(trace for trace in chart.data if trace.name=="Node selection")
    node_ids={node["id"] for node in model_structure()["nodes"]}
    assert set(targets.customdata)==node_ids
    assert all(list(targets.customdata).count(node)>=15 for node in node_ids)
    assert chart.layout.clickmode=="event+select"
    for node in node_ids:
        # The event's node ID controls selection; point/curve indexes are incidental.
        assert selected_node_from_event({"selection":{"points":[{"customdata":node,"point_number":999}]}},node_ids)==node


@pytest.mark.parametrize("event",[None,{}, {"selection":None}, {"selection":{"points":"M"}},
    {"selection":{"points":[None,{"customdata":"invalid"}]}},
    {"selection":{"points":[{"point_number":0}]}}])
def test_invalid_events_leave_overview_selected(event):
    assert selected_node_from_event(event,{"M","T"}) is None


def test_event_parser_accepts_serialized_single_value_customdata():
    assert selected_node_from_event({"selection":{"points":[{"customdata":["T"]}]}},{"T"})=="T"
