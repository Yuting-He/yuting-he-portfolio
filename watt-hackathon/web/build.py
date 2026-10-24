"""Package the public replay as one self-contained, offline-capable HTML file."""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path


def _embedded_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def schedule_document(source: Path | None = None) -> str:
    """Build a standalone route replay without relying on the BN story schema."""
    web = Path(__file__).resolve().parent
    sys.path.insert(0, str(web.parent))
    from gridscout.schedule_replay import build_schedule_replay

    data = build_schedule_replay(source) if source is not None else build_schedule_replay()
    html = (web / "schedule.html").read_text(encoding="utf-8")
    html = html.replace('<link rel="stylesheet" href="schedule.css">',
                        f"<style>\n{(web / 'schedule.css').read_text(encoding='utf-8')}\n</style>")
    html = html.replace("__SCHEDULE_DATA__", _embedded_json(data))
    html = html.replace('<script src="schedule.js"></script>',
                        f"<script>\n{(web / 'schedule.js').read_text(encoding='utf-8')}\n</script>")
    return html


def build_schedule(output: Path | None = None, source: Path | None = None) -> Path:
    """Rebuild the route page independently of the dynamic simulation story."""
    output = output or Path(__file__).resolve().parents[1] / "dist" / "schedule.html"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(schedule_document(source), encoding="utf-8")
    return output


def build(source: Path | None = None, output: Path | None = None) -> Path:
    web = Path(__file__).resolve().parent
    source = source or web.parent / "artifacts" / "showcase_data.json"
    output = output or web.parent / "dist" / "index.html"
    sys.path.insert(0, str(web.parent))
    try:
        from gridscout.showcase_data import load_showcase_data
    except ModuleNotFoundError as error:
        raise ValueError(
            f"Build dependency {error.name!r} is unavailable. Run this command "
            "with the project's .venv Python, or install requirements.txt."
        ) from error

    try:
        data = load_showcase_data(source)
    except (KeyError, TypeError) as error:
        raise ValueError(
            f"Incomplete release metadata ({error}). The replay and validation "
            "must contain matching model_version and code_hash values. "
            "Rebuild with python -m gridscout.showcase_data."
        ) from error
    chapters, frames = data.get("chapters"), data.get("frames")
    if not isinstance(chapters, list) or not chapters or not isinstance(frames, list) or not frames:
        raise ValueError("A complete frozen replay with chapters and frames is required")
    durations = [chapter.get("duration_seconds") for chapter in chapters]
    duration = data["metadata"].get("duration_seconds")
    if (any(isinstance(value, bool) or not isinstance(value, (int, float))
            or not math.isfinite(value) or value <= 0 for value in [duration, *durations])
            or not math.isclose(sum(durations), duration)):
        raise ValueError("Chapter durations must be positive and match the declared replay duration")
    if data["metadata"].get("chapter_count", len(chapters)) != len(chapters):
        raise ValueError("The declared chapter count does not match the frozen story")
    frame_keys = {(frame.get("asset_id"), frame.get("minute")) for frame in frames}
    snapshot_ids = [frame.get("snapshot_id") for frame in frames]
    if len(frame_keys) != len(frames) or len(set(snapshot_ids)) != len(frames) or not all(snapshot_ids):
        raise ValueError("Each frozen frame requires a unique asset/time pair and snapshot ID")
    chapter_ids = [chapter.get("id") for chapter in chapters]
    if not all(chapter_ids) or len(set(chapter_ids)) != len(chapters):
        raise ValueError("Every chapter requires a unique ID")
    for chapter in chapters:
        asset = chapter.get("asset_id", data["metadata"].get("asset_id"))
        minutes = chapter.get("frame_minutes")
        if not minutes or any((asset, minute) not in frame_keys for minute in minutes):
            raise ValueError("Every chapter must reference available frames for its target asset")
    metadata, validation = data["metadata"], data["validation"]["metadata"]
    for key in ("model_version", "code_hash"):
        if metadata[key] != validation[key]:
            raise ValueError(f"Replay and validation {key} do not match")
    html = (web / "index.html").read_text(encoding="utf-8")
    css = (web / "showcase.css").read_text(encoding="utf-8")
    js = (web / "showcase.js").read_text(encoding="utf-8")
    route = schedule_document()
    payload = _embedded_json(data)
    html = html.replace('<link rel="stylesheet" href="showcase.css">', f"<style>\n{css}\n</style>")
    html = html.replace("__SHOWCASE_DATA__", payload)
    html = html.replace("__SCHEDULE_DOCUMENT__", _embedded_json(route))
    html = html.replace('<script src="showcase.js"></script>', f"<script>\n{js}\n</script>")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(html, encoding="utf-8")
    (output.parent / "schedule.html").write_text(route, encoding="utf-8")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--route-only", action="store_true", help="Build the standalone route showcase only")
    args = parser.parse_args()
    try:
        result = build_schedule(output=args.output, source=args.data) if args.route_only else build(args.data, args.output)
    except (ValueError, OSError) as error:
        parser.error(str(error))
    print(f"Built {result} ({result.stat().st_size:,} bytes)")
