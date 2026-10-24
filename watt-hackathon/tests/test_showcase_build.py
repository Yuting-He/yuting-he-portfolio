"""A published replay must be self-contained and match its model sources."""
import json
from pathlib import Path

import pytest

from web.build import build

ROOT = Path(__file__).resolve().parents[1]


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
