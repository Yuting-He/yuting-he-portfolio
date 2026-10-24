"""A published replay must be self-contained and match its model sources."""
import json
from pathlib import Path

import pytest

from web.build import build, build_schedule
from gridscout.showcase_data import build_showcase_data

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def multi_asset_release():
    validation = json.loads((ROOT / "artifacts/showcase_data.json").read_text(encoding="utf-8"))["validation"]
    return build_showcase_data(validation)


def test_public_build_embeds_the_same_evidence_without_external_assets(tmp_path):
    target = build(output=tmp_path / "index.html")
    html = target.read_text(encoding="utf-8")
    assert '<script src=' not in html
    assert '<link rel="stylesheet"' not in html
    assert 'View evidence for this step' in html
    assert 'OpenStreetMap' in html
    payload = html.split('<script id="showcase-data" type="application/json">', 1)[1].split('</script>', 1)[0]
    data = json.loads(payload)
    assert data == json.loads((ROOT / "artifacts/showcase_data.json").read_text(encoding="utf-8"))


def test_two_matching_but_stale_reports_cannot_be_published(tmp_path):
    data = json.loads((ROOT / "artifacts/showcase_data.json").read_text(encoding="utf-8"))
    data["metadata"]["code_hash"] = "stale-but-matching"
    data["validation"]["metadata"]["code_hash"] = "stale-but-matching"
    source = tmp_path / "old.json"
    source.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError):
        build(source=source, output=tmp_path / "index.html")
    assert not (tmp_path / "index.html").exists()


def test_replay_without_validation_is_not_a_production_build(tmp_path):
    data = json.loads((ROOT / "artifacts/showcase_data.json").read_text(encoding="utf-8"))
    data["validation"] = None
    source = tmp_path / "development.json"
    source.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError):
        build(source=source, output=tmp_path / "index.html")


def test_route_showcase_is_embedded_offline_and_also_built_standalone(tmp_path):
    target = build(output=tmp_path / "index.html")
    html = target.read_text(encoding="utf-8")
    payload = html.split('<script id="schedule-document" type="application/json">', 1)[1].split('</script>', 1)[0]
    route = json.loads(payload)
    assert route == (tmp_path / "schedule.html").read_text(encoding="utf-8")
    assert '<script src=' not in route
    assert '<link rel="stylesheet"' not in route
    assert 'data-page="schedule"' in html
    data = json.loads(route.split('<script id="schedule-data" type="application/json">', 1)[1].split('</script>', 1)[0])
    assert data["summary"]["distance_km"] == 184.681261
    assert len(data["legs"]) == 56
    assert data["unspecified"] == ["LINE_024"]
    assert 'View evidence for this step' not in route
    assert 'id="evidence-tabs"' not in route


def test_route_can_build_independently_of_the_simulation_bundle(tmp_path, monkeypatch):
    def unavailable(*args, **kwargs):
        raise AssertionError("Route builds do not load the simulation story")
    monkeypatch.setattr("gridscout.showcase_data.load_showcase_data", unavailable)
    route = build_schedule(output=tmp_path / "route.html").read_text(encoding="utf-8")
    assert '184.681261' in route
    assert '<script src=' not in route
    assert 'id="schedule-data"' in route


def test_public_build_accepts_complete_data_driven_multi_asset_story(tmp_path, multi_asset_release):
    source = tmp_path / "multi-asset.json"
    source.write_text(json.dumps(multi_asset_release), encoding="utf-8")
    target = build(source=source, output=tmp_path / "index.html")
    payload = target.read_text(encoding="utf-8").split('<script id="showcase-data" type="application/json">', 1)[1].split('</script>', 1)[0]
    data = json.loads(payload)
    assert len(data["chapters"]) == data["metadata"]["chapter_count"] == 9
    assert sum(chapter["duration_seconds"] for chapter in data["chapters"]) == data["metadata"]["duration_seconds"] == 105
    assert data["metadata"]["asset_ids"] == ["LINE_058", "LINE_015"]


@pytest.mark.parametrize("invalid", ["duration", "count", "target_frames", "duplicate_snapshot", "nonpositive"])
def test_public_build_rejects_incomplete_story_contract(tmp_path, multi_asset_release, invalid):
    data = json.loads(json.dumps(multi_asset_release))
    if invalid == "duration":
        data["metadata"]["duration_seconds"] += 1
    elif invalid == "count":
        data["metadata"]["chapter_count"] -= 1
    elif invalid == "target_frames":
        data["chapters"][5]["asset_id"] = "LINE_025"
    elif invalid == "duplicate_snapshot":
        data["frames"].append(data["frames"][0])
    else:
        data["chapters"][0]["duration_seconds"] = 0
    source = tmp_path / "incomplete.json"
    source.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError):
        build(source=source, output=tmp_path / "index.html")
    assert not (tmp_path / "index.html").exists()
