"""User workflows through the default synthetic streaming dashboard."""
from pathlib import Path

from streamlit.testing.v1 import AppTest


def app():
    a = AppTest.from_file(str(Path(__file__).parents[1] / "app.py"),default_timeout=60).run()
    return a.radio(key="app_view").set_value("Interactive dashboard").run()


def button(a,label):
    return next(b for b in a.button if b.label==label)


def manual(a):
    a.toggle(key="tw_auto").set_value(False)
    a.checkbox(key="tw_follow").uncheck().run()
    return a


def test_default_live_twin_and_unobserved_asset():
    a=app()
    assert not a.exception
    assert a.selectbox(key="app_workspace").value=="Digital twin · Live simulation"
    assert len(a.tabs)==5
    s=a.session_state["tw_sim"]
    assert len(s.drones)==5 and len(s.history)==5
    assert s.autonomous
    unseen=next(asset for asset in s.dataset.segments if asset not in s.latest)
    a.checkbox(key="tw_follow").uncheck()
    a.selectbox(key="tw_asset").select(unseen).run()
    assert not a.exception
    assert button(a,"Collect synthetic inspection").disabled
    assert any(m.value=="Unknown" for m in a.metric)


def test_anomaly_verification_cost_controls_and_reset():
    a=manual(app())
    button(a,"Jump to 55 min").click().run()
    assert not a.exception
    s=a.session_state["tw_sim"]
    asset=s.drones[0].asset_id
    assert s.current(asset)["anomaly"]>.65
    before=s.current(asset)["anomaly"]
    button(a,"Collect synthetic inspection").click().run()
    assert not a.exception
    assert s.current(asset)["anomaly"]>before
    a.slider(key="tw_fp_cost").set_value(100.0).run()
    assert not a.exception
    button(a,"Reset stream").click().run()
    assert not a.exception
    assert a.session_state["tw_sim"].minute==0
    assert not a.session_state["tw_sim"].visual_evidence


def test_missing_signal_is_unknown_in_all_panels():
    a=app()
    a.selectbox(key="tw_scenario").select("dropout")
    button(a,"Apply scenario & reset").click().run()
    button(a,"Jump to 55 min").click().run()
    s=a.session_state["tw_sim"]
    lost=s.drones[4].asset_id
    a.checkbox(key="tw_follow").uncheck()
    a.selectbox(key="tw_asset").select(lost).run()
    assert not a.exception
    assert s.current(lost)["status"]=="Unknown"
    assert any(m.label=="Mechanical anomaly" and m.value=="Unknown" for m in a.metric)
    assert any("No fresh direct measurement" in item.value for item in a.info)
    assert not any("Model anomaly probability" in item.value for item in a.caption)


def test_relocation_old_asset_becomes_unknown_without_ui_error():
    a=manual(app())
    s=a.session_state["tw_sim"]
    origin=s.drones[0].asset_id
    assert s.available_targets(s.drones[0].sensor_id)
    button(a,"Dispatch relocation").click().run()
    assert not a.exception
    assert s.drones[0].status=="flying"
    assert s.current(origin)["status"]=="Unknown"
    assert button(a,"Collect synthetic inspection").disabled
    button(a,"Advance 5 min").click().run()
    assert not a.exception


def test_play_pause_and_workspace_state_isolation():
    a=app()
    button(a,"Play stream").click().run()
    assert not a.exception
    assert a.session_state["tw_playing"] and a.session_state["tw_sim"].minute>=1
    button(a,"Pause stream").click().run()
    assert not a.exception and not a.session_state["tw_playing"]
    minute=a.session_state["tw_sim"].minute
    a.selectbox(key="app_workspace").select("Official challenge · Bavaria").run()
    assert not a.exception
    a.selectbox(key="app_workspace").select("Digital twin · Live simulation").run()
    assert not a.exception and a.session_state["tw_sim"].minute==minute


def test_automatic_mission_shows_progress_then_human_request_without_manual_result():
    a=app()
    assert button(a,"Dispatch relocation").disabled
    assert button(a,"Collect synthetic inspection").disabled
    button(a,"Advance 1 min").click().run()
    assert not a.exception
    s=a.session_state["tw_sim"]
    assert s.operations
    assert any(o["status"] in {"queued","flying","inspecting","deferred"} for o in s.operations)
    button(a,"Advance 1 min").click().run()
    assert not a.exception
    assert any(o["status"]=="flying" for o in s.operations)
    button(a,"Jump to 55 min").click().run()
    assert not a.exception
    assert any(o["status"]=="completed" for o in s.operations)
    alerts=[item for item in s.human_alerts if item["status"]=="open"]
    assert alerts
    assert any("HUMAN ACTION REQUIRED" in item.value for item in a.error)
    first=alerts[0]
    a.button(key=f"tw_ack_{first['id']}").click().run()
    assert not a.exception
    assert next(item for item in s.human_alerts if item["id"]==first["id"])["status"]=="acknowledged"
    assert any("Awaiting human follow-up" in item.value for item in a.caption)
    button(a,"Reset stream").click().run()
    assert not a.exception
    assert not a.session_state["tw_sim"].human_alerts
    assert not a.session_state["tw_sim"].operations


def test_dynamic_mission_revisions_assignments_findings_and_five_drone_explanation():
    a=app()
    button(a,"Load dynamic mission").click().run()
    assert not a.exception
    assert a.session_state["tw_sim"].scenario=="dynamic"
    assert a.selectbox(key="tw_scenario").value=="dynamic"
    button(a,"Jump to 55 min").click().run()
    assert not a.exception
    s=a.session_state["tw_sim"]
    assert s.replans and s.inspection_requests
    assert any(o["status"] in {"cancelled","superseded"} for o in s.operations)
    west=next(o for o in s.operations if o.get("request_id")=="SYN-LEAD-WEST")
    assert len(west["decision_explanation"]["candidates"])==5
    a.selectbox(key="tw_explain").select(west["id"]).run()
    assert not a.exception
    assert any("Why this drone" in m.value for m in a.markdown)
    assert any("Why this location" in m.value for m in a.markdown)
    for _ in range(3):button(a,"Advance 5 min").click().run()
    assert not a.exception
    assert west["status"]=="completed"
    assert west["finding"] and west["next_action"]
    assert any("Same-window model anomaly" in c.value for c in a.caption)


def test_selected_line_bn_evidence_historical_update_and_preview_isolation():
    a=app()
    button(a,"Load dynamic mission").click().run()
    button(a,"Jump to 55 min").click().run()
    button(a,"Advance 5 min").click().run()
    a.selectbox(key="tw_asset").select("LINE_058").run()
    assert not a.exception
    assert not a.session_state["tw_follow"]
    assert any(m.label=="After sensors" and m.value=="88.4%" for m in a.metric)
    assert any(m.label=="After inspection" and m.value=="55.5%" for m in a.metric)
    sim=a.session_state["tw_sim"]
    before=(len(sim.audit),len(sim.inspection_history),sim.current("LINE_058")["anomaly"])
    a.radio(key="tw_bn_preview_LINE_058").set_value("clear").run()
    assert not a.exception
    assert (len(sim.audit),len(sim.inspection_history),sim.current("LINE_058")["anomaly"])==before
    sim.advance_to(80)
    a.run()
    assert not a.exception
    assert any("previous inspection has expired" in w.value for w in a.warning)
    record=next(r for r in sim.inspection_history if r["asset_id"]=="LINE_058" and r["minute"]==60)
    a.selectbox(key="tw_bn_scope_LINE_058").select(record["id"]).run()
    assert not a.exception
    assert any("HISTORICAL INSPECTION" in i.value for i in a.info)
    assert any(m.label=="After inspection" and m.value=="55.5%" for m in a.metric)
