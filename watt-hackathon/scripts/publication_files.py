"""Prepare an explicit, credential-free GitHub publication manifest.

Only project sources, organizer data and the current public replay are included.
The existing portfolio is extended at /watt-hackathon without replacing its root.
The helper does not contact GitHub; the connected GitHub tool applies the commit.
"""
import argparse
import base64
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PREFIX = "watt-hackathon/"


def publication_files():
    paths = set()
    for pattern in ("*.md", "*.toml", "requirements*.txt", "app.py", ".gitignore", "launch.ps1"):
        paths.update(ROOT.glob(pattern))
    for folder in ("gridscout", "tests", "web", "scripts", "scenarios", "data/official", ".streamlit"):
        paths.update(p for p in (ROOT / folder).rglob("*")
                     if p.is_file() and not any(part in {"__pycache__", ".pytest_cache"} for part in p.parts))
    paths.update(ROOT / relative for relative in (
        "artifacts/showcase_data.json", "artifacts/validation_summary.json", "dist/index.html"))
    entries = []
    for path in sorted(paths):
        relative = path.relative_to(ROOT).as_posix()
        if path.suffix == ".pyc" or relative.endswith("publication_files.json"):
            continue
        raw = path.read_bytes()
        # Preserve original organizer byte order marks and line endings: their
        # checksums are part of the Python loader's provenance validation.
        entries.append({"path": PREFIX + relative, "encoding": "base64",
                        "content": base64.b64encode(raw).decode("ascii"), "bytes": len(raw)})
    index = next(row for row in entries if row["path"] == PREFIX + "dist/index.html")
    entries.append({**index, "path": PREFIX + "index.html"})
    entries.append({"path": PREFIX + ".nojekyll", "encoding": "base64", "content": "", "bytes": 0})
    return entries


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/publication_files.json")
    parser.add_argument("--chunk", type=int)
    parser.add_argument("--size", type=int, default=24000)
    parser.add_argument("--checkout", type=Path, help="Write the prepared files into the verified portfolio checkout")
    args = parser.parse_args()
    if args.chunk is not None:
        value = args.output.read_text(encoding="utf-8")
        print(value[args.chunk * args.size:(args.chunk + 1) * args.size], end="")
        return
    entries = publication_files()
    if args.checkout is not None:
        checkout = args.checkout.resolve()
        expected = ROOT.parent / "yuting-he-portfolio"
        if checkout != expected.resolve() or not (checkout / ".git").is_dir():
            raise ValueError("Publication checkout must be the existing personal portfolio repository")
        destination = checkout / "watt-hackathon"
        if destination.exists():
            raise ValueError("Publication destination already exists; inspect it before updating")
        for entry in entries:
            path = checkout / entry["path"]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(base64.b64decode(entry["content"]))
        print(json.dumps({"written": len(entries), "destination": str(destination)}))
        return
    encoded = json.dumps(entries, ensure_ascii=True, separators=(",", ":"))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(encoded, encoding="utf-8")
    print(json.dumps({"files": len(entries), "characters": len(encoded),
                      "chunks": (len(encoded) + args.size - 1) // args.size,
                      "source_bytes": sum(row["bytes"] for row in entries)}))


if __name__ == "__main__":
    main()
