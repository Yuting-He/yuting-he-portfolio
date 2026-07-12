"""Build exact HydroBASINS-to-NUTS-3 overlap weights for HeatLens.

Run with Shapely >= 2 and pyproj installed. All areas are calculated in the
equal-area ETRS89 / LAEA Europe projection (EPSG:3035).
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from pyproj import Transformer
from shapely import make_valid
from shapely.geometry import shape
from shapely.ops import transform
from shapely.strtree import STRtree


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
BASIN_PATH = ASSETS / "hydrobasins-de-level8.geojson"
DISTRICT_PATH = ASSETS / "nuts3-de.geojson"
OUTPUT_PATH = ASSETS / "basin-nuts3-crosswalk.json"
MANIFEST_PATH = ASSETS / "spatial-data-manifest.json"
MIN_OVERLAP_KM2 = 0.001


def load_features(path: Path) -> list[dict]:
    return json.loads(path.read_text(encoding="utf-8"))["features"]


def sha256(path: Path) -> str:
    content = path.read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(content).hexdigest()


def project_geometry(feature: dict, transformer: Transformer):
    geometry = make_valid(shape(feature["geometry"]))
    return transform(transformer.transform, geometry)


def main() -> None:
    basin_features = load_features(BASIN_PATH)
    district_features = load_features(DISTRICT_PATH)
    transformer = Transformer.from_crs("EPSG:4326", "EPSG:3035", always_xy=True)

    district_geometries = [project_geometry(feature, transformer) for feature in district_features]
    district_ids = [feature["properties"]["NUTS_ID"] for feature in district_features]
    district_areas = [geometry.area / 1_000_000 for geometry in district_geometries]
    tree = STRtree(district_geometries)
    records: list[dict] = []
    unmatched_basins: list[str] = []

    for feature in basin_features:
        basin_id = str(feature["properties"]["HYBAS_ID"])
        basin_geometry = project_geometry(feature, transformer)
        basin_area = basin_geometry.area / 1_000_000
        matches: list[tuple[int, float]] = []
        for district_index in tree.query(basin_geometry, predicate="intersects"):
            overlap = basin_geometry.intersection(district_geometries[district_index]).area / 1_000_000
            if overlap >= MIN_OVERLAP_KM2:
                matches.append((int(district_index), overlap))
        if not matches:
            unmatched_basins.append(basin_id)
            continue
        for district_index, overlap in matches:
            records.append(
                {
                    "HYBAS_ID": basin_id,
                    "NUTS_ID": district_ids[district_index],
                    "overlap_km2": round(overlap, 4),
                    "basin_area_km2": round(basin_area, 4),
                    "district_area_km2": round(district_areas[district_index], 4),
                    "basin_share": round(overlap / basin_area, 7),
                    "district_share": round(overlap / district_areas[district_index], 7),
                }
            )

    records.sort(key=lambda item: (item["HYBAS_ID"], item["NUTS_ID"]))
    OUTPUT_PATH.write_text(json.dumps(records, indent=2) + "\n", encoding="utf-8")

    covered_districts = {record["NUTS_ID"] for record in records}
    generated_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    manifest = {
        "schema": "heatlens-spatial-manifest/v1",
        "generated_at": generated_at,
        "crosswalk": {
            "method": "Exact polygon intersection area in ETRS89 / LAEA Europe",
            "analysis_crs": "EPSG:3035",
            "minimum_overlap_km2": MIN_OVERLAP_KM2,
            "records": len(records),
            "basins": len(basin_features),
            "districts": len(covered_districts),
            "unmatched_basins": unmatched_basins,
            "sha256": sha256(OUTPUT_PATH),
        },
        "assets": [
            {
                "path": "assets/hydrobasins-de-level8.geojson",
                "source": "HydroBASINS Europe Level 8 v1c",
                "url": "https://www.hydrosheds.org/products/hydrobasins",
                "sha256": sha256(BASIN_PATH),
            },
            {
                "path": "assets/nuts3-de.geojson",
                "source": "Eurostat GISCO NUTS 2024 Level 3",
                "url": "https://ec.europa.eu/eurostat/web/gisco/geodata/statistical-units/territorial-units-statistics",
                "sha256": sha256(DISTRICT_PATH),
            },
        ],
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(
        f"Wrote {len(records)} overlap records covering {len(covered_districts)} districts; "
        f"{len(unmatched_basins)} border fragments have no NUTS-3 overlap"
    )


if __name__ == "__main__":
    main()
