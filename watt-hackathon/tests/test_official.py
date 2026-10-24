"""Official dataset and operational rules, independent of Streamlit."""
from copy import deepcopy
from dataclasses import asdict, replace

import pytest

from gridscout.challenge import (ChallengeConfig, POLICIES, advance_challenge, create_challenge,
    feasible_challenge_actions, recommend_challenge, run_challenge, set_charging_site)
from gridscout.official_data import load_official_dataset, line_intersects_polygon


@pytest.fixture(scope="module")
def dataset():
    return load_official_dataset()


def test_original_package_ids_parallel_edges_and_provenance(dataset):
    assert len(dataset.segments)==64
    assert len(dataset.nodes)==59
    assert dataset.mapped_graph.number_of_edges()==64
    assert len({tuple(sorted((r["from_node"],r["to_node"]))) for r in dataset.segments.values()})==56
    assert len({r["component_id"] for r in dataset.segments.values()})==7
    assert "LINE_024" in dataset.segments
    assert len(dataset.manifest["archive_sha256"])==64
    assert "electrical connectivity unknown" in dataset.mapped_graph.name


def test_full_polyline_report_overlap_not_midpoint_only():
    ring=[[0,0],[1,0],[1,1],[0,1],[0,0]]
    assert line_intersects_polygon([[-2,.5],[2,.5]],ring)
    assert line_intersects_polygon([[.5,.5],[4,4]],ring)
    assert not line_intersects_polygon([[-2,2],[2,2]],ring)


def test_all_six_reports_are_initial_and_not_replayed(dataset):
    state=create_challenge(dataset=dataset)
    assert len(state.dataset.reports)==6
    assert len({r["information_id"] for r in state.dataset.reports})==6
    assert len(state.history[0]["reports"])==6
    assert state.time==0 and not state.beliefs.observations
    advance_challenge(state)
    assert sum(e["type"]=="initial_information" for e in state.history)==1
    assert len(state.dataset.reports)==6


def test_five_starting_ids_and_known_deenergization_are_separate_from_damage(dataset):
    state=create_challenge(ChallengeConfig(assumed_charging_lines=()),dataset)
    assert len(state.sensors)==5
    assert len({s.line_id for s in state.sensors})==5
    assert all(s.line_id in dataset.segments and not s.needs_charge for s in state.sensors)
    assert state.sites["LINE_024"].energized is False
    assert not state.sites["LINE_024"].can_charge
    assert 0<state.beliefs.line_probabilities["LINE_024"]<1
    # Even a 380-kV tag is not live/charging evidence.
    assert dataset.segments["LINE_001"]["voltage_kv"]==380
    assert state.sites["LINE_001"].energized is None
    assert not state.sites["LINE_001"].can_charge
    with pytest.raises(ValueError,match="de-energized"):
        set_charging_site(state,"LINE_024",True,True)


@pytest.mark.parametrize("kwargs",[{"sensor_count":2},{"max_flight_minutes":31},{"charge_minutes":179},
    {"start_lines":("LINE_001",)*5},{"mission_minutes":float("nan")},{"speed_km_per_minute":0}])
def test_official_config_enforces_rules(kwargs):
    with pytest.raises(ValueError):
        ChallengeConfig(**kwargs)


def test_reading_is_hypothetical_and_inconclusive_is_not_negative(dataset):
    state=create_challenge(dataset=dataset)
    sites=deepcopy(state.sites)
    advance_challenge(state,reading_override="Inconclusive")
    event=state.evidence[0]
    assert event["reading"].result=="Inconclusive"
    assert event["before_probabilities"]==event["after_probabilities"]
    assert event["reading"].line_id not in state.beliefs.observations
    assert state.sites==sites
    assert recommend_challenge(state)[0].action.flight_minutes==0  # One local follow-up.
    assert not hasattr(state,"environment") and not hasattr(state,"failures")


@pytest.mark.parametrize("kind,comparison",[("Positive",lambda a,b:b>a),("Negative",lambda a,b:b<a)])
def test_hypothetical_evidence_updates_beliefs_without_changing_power(dataset,kind,comparison):
    state=create_challenge(dataset=dataset)
    sites=deepcopy(state.sites)
    advance_challenge(state,reading_override=kind)
    event=state.evidence[0]
    assert comparison(event["prior_probability"],event["posterior_probability"])
    assert state.sites==sites


def test_recommendation_is_pure_for_all_policies(dataset):
    state=create_challenge(dataset=dataset)
    before=(deepcopy(asdict(state.beliefs)),deepcopy(state.history),deepcopy(state.sensors),deepcopy(state.sites))
    for policy in POLICIES:
        assert recommend_challenge(state,policy)==recommend_challenge(state,policy)
    assert before==(asdict(state.beliefs),state.history,state.sensors,state.sites)


def _single_flight(dataset):
    state=create_challenge(ChallengeConfig(assumed_charging_lines=(),allow_terminal_visits=True,
                                          inconclusive_probability=0,mission_minutes=600),dataset)
    advance_challenge(state)
    for sensor in state.sensors[1:]:
        sensor.needs_charge=True
        sensor.status="awaiting_power"
    # Select an ordinary site, not the deliberately immutable official LINE_024.
    target=next(a.line_id for a in feasible_challenge_actions(state,state.sensors[0]) if a.line_id!="LINE_024")
    set_charging_site(state,target,True,True)
    state.config=replace(state.config,allow_terminal_visits=False)
    advance_challenge(state)
    sensor=state.sensors[0]
    assert sensor.needs_charge and sensor.status=="observing"
    return state,sensor


@pytest.mark.parametrize("live,power",[(None,None),(True,None),(None,True),(False,True),(True,False)])
def test_both_live_and_sufficient_power_required(dataset,live,power):
    state,sensor=_single_flight(dataset)
    set_charging_site(state,sensor.line_id,live,power)
    assert sensor.charge_ready_at is None
    advance_challenge(state)  # Finish observation, still unable to depart.
    assert sensor.needs_charge
    assert not feasible_challenge_actions(state,sensor)
    assert sensor.status=="awaiting_power"


def test_short_flight_requires_full_charge_before_departure(dataset):
    state,sensor=_single_flight(dataset)
    assert state.history[-1]["flight_minutes"]<30
    arrival=state.time
    set_charging_site(state,sensor.line_id,True,True)
    assert sensor.charge_ready_at==pytest.approx(arrival+180)
    state.config=replace(state.config,allow_terminal_visits=True)
    advance_challenge(state)  # Perched observation is allowed during charging.
    assert sensor.status=="charging"
    assert not feasible_challenge_actions(state,sensor)
    ready=sensor.charge_ready_at
    state.time=ready-.001
    assert not feasible_challenge_actions(state,sensor)
    advance_challenge(state)
    assert state.time==pytest.approx(ready)
    assert not sensor.needs_charge
    assert feasible_challenge_actions(state,sensor)


def test_power_loss_cancels_charge_and_restoration_of_assumption_restarts_180_minutes(dataset):
    state,sensor=_single_flight(dataset)
    set_charging_site(state,sensor.line_id,True,True)
    advance_challenge(state)
    old_ready=sensor.charge_ready_at
    state.time+=60
    set_charging_site(state,sensor.line_id,False,True)
    assert sensor.charge_ready_at is None and sensor.needs_charge
    state.time+=20
    set_charging_site(state,sensor.line_id,True,True)
    assert sensor.charge_ready_at==state.time+180
    assert sensor.charge_ready_at>old_ready
    assert not feasible_challenge_actions(state,sensor)


def test_exact_30_minute_boundary_and_no_simultaneous_duplicates(dataset):
    state=create_challenge(ChallengeConfig(allow_terminal_visits=True,inconclusive_probability=0),dataset)
    advance_challenge(state)
    sensor=state.sensors[0]
    candidate=feasible_challenge_actions(state,sensor)[0]
    distance=candidate.flight_minutes*state.config.speed_km_per_minute
    state.config=replace(state.config,speed_km_per_minute=distance/30)
    assert any(a.line_id==candidate.line_id for a in feasible_challenge_actions(state,sensor))
    state.config=replace(state.config,speed_km_per_minute=distance/30.001)
    assert all(a.line_id!=candidate.line_id for a in feasible_challenge_actions(state,sensor))
    state.config=replace(state.config,speed_km_per_minute=.6)
    advance_challenge(state)
    targets=[a.line_id for a in state.pending.values()]
    assert len(targets)==len(set(targets))==5


@pytest.mark.parametrize("policy",POLICIES)
def test_complete_official_mission_audits_every_flight_and_charge(dataset,policy):
    state=run_challenge(create_challenge(dataset=dataset),policy)
    assert state.finished and state.time<=240
    assert state.readings and all("Hypothetical" in r.source for r in state.readings)
    assert len(state.dataset.reports)==6
    for sensor in state.sensors:
        flights=[e for e in state.history if e["type"]=="flight_start" and e["sensor_id"]==sensor.sensor_id]
        assert len(flights)<=2  # Four-hour mission, full recharge after each flight.
        for i,flight in enumerate(flights):
            assert flight["flight_minutes"]<=30+1e-9
            if i:
                previous=flights[i-1]
                assert flight["time"]>=previous["arrival"]+180-1e-9
                assert any(e["type"]=="charge_complete" and e["sensor_id"]==sensor.sensor_id
                           and previous["arrival"]<=e["time"]<=flight["time"] for e in state.history)
    for event in state.history:
        if event["type"]=="charge_start":
            assert event["energized"] is True and event["sufficient_power"] is True
            assert event["line_id"]!="LINE_024"
            assert event["finish_time"]-event["time"]==pytest.approx(180)


def test_reproducible_official_mission_and_conservative_mode(dataset):
    first=run_challenge(create_challenge(dataset=dataset))
    second=run_challenge(create_challenge(dataset=dataset))
    assert first.history==second.history
    assert first.readings==second.readings
    conservative=run_challenge(create_challenge(ChallengeConfig(assumed_charging_lines=()),dataset))
    assert conservative.readings
    assert not any(e["type"]=="flight_start" for e in conservative.history)
    assert not any(e["type"]=="charge_start" for e in conservative.history)


def test_new_operator_power_assumption_can_resume_before_horizon(dataset):
    state=run_challenge(create_challenge(ChallengeConfig(assumed_charging_lines=(),
                                       inconclusive_probability=0),dataset))
    assert state.finished and state.time<240
    state.config=replace(state.config,allow_terminal_visits=True)
    state.finished=False
    target=next(a.line_id for a in feasible_challenge_actions(state,state.sensors[0]) if a.line_id!="LINE_024")
    state.finished=True
    state.config=replace(state.config,allow_terminal_visits=False)
    set_charging_site(state,target,True,True)
    assert not state.finished
    advance_challenge(state)
    assert any(e["type"]=="flight_start" for e in state.history)
