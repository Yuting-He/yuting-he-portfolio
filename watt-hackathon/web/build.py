"""Package the public replay as one self-contained, offline-capable HTML file."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


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
    if len(data.get("chapters", [])) != 6 or not data.get("frames"):
        raise ValueError("A complete six-chapter frozen replay is required")
    if sum(c["duration_seconds"] for c in data["chapters"]) != 75:
        raise ValueError("The public replay must be 75 seconds long")
    metadata, validation = data["metadata"], data["validation"]["metadata"]
    for key in ("model_version", "code_hash"):
        if metadata[key] != validation[key]:
            raise ValueError(f"Replay and validation {key} do not match")
    html = (web / "index.html").read_text(encoding="utf-8")
    css = (web / "showcase.css").read_text(encoding="utf-8")
    js = (web / "showcase.js").read_text(encoding="utf-8")
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    html = html.replace('<link rel="stylesheet" href="showcase.css">', f"<style>\n{css}\n</style>")
    html = html.replace("__SHOWCASE_DATA__", payload)
    html = html.replace('<script src="showcase.js"></script>', f"<script>\n{js}\n</script>")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(html, encoding="utf-8")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        result = build(args.data, args.output)
    except (ValueError, OSError) as error:
        parser.error(str(error))
    print(f"Built {result} ({result.stat().st_size:,} bytes)")
