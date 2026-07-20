# Yuting He Portfolio and HeatLens Germany

Personal portfolio for geospatial NatCat risk, hydrology, statistics, and applied AI implementation. The repository includes **HeatLens Germany**, a live multi-scale heat and water-stress screening application.

- Portfolio: <https://yuting-he.github.io/yuting-he-portfolio/>
- HeatLens: <https://yuting-he.github.io/yuting-he-portfolio/heatwave-demo.html>

## HeatLens capabilities

- live DWD ICON model fields via the Open-Meteo DWD API
- a separately displayed official DWD warning snapshot
- two retrospective and seven forecast dates
- 614 Germany-clipped HydroBASINS Level 8 prediction units
- exact sub-basin x NUTS-3 overlap weights in EPSG:3035
- 400 NUTS-3 district / urban-district views and 16 state summaries
- GISCO 2024 1:1M boundaries over an OpenStreetMap base map
- resident, farmer, and municipal decision lenses
- heat, water-stress, and role-specific impact screening layers
- shareable URL state and JSON snapshot export
- freshness, source completeness, and spatial coverage gates

## Decision boundary

The weather and warning feeds are real, but HeatLens's 0-100 scores are transparent **uncalibrated screening indices**. They are not probabilities, observations, official warnings, medical advice, or agronomic instructions. Official DWD warning context is displayed separately and is never blended into the custom score.

The current impact layer still uses explicit urban/rural exposure and crop-sensitivity assumptions. A snapshot older than 36 hours remains visible for audit, but the application suppresses suggested actions. See [`docs/heatwave-demo-data-plan.md`](docs/heatwave-demo-data-plan.md) for formulas, limitations, governance, and the calibration roadmap.

## Local development

Node.js 20 or newer is required. No package install is necessary.

```bash
npm run serve
```

Open <http://127.0.0.1:4173/> and run all tests with:

```bash
npm test
```

Refresh the live snapshot with internet access:

```bash
npm run refresh-data
```

The ingestion job queries coordinates in rate-limited batches, validates all 614 basins and nine dates, and atomically replaces `assets/live/forecast.json`. GitHub Actions repeats this every three hours. A failed scheduled refresh skips deployment so the last successful Pages release stays online.

## Spatial ETL

Rebuild the exact-area crosswalk with Shapely 2 and pyproj 3:

```bash
python scripts/build_spatial_crosswalk.py
```

The script projects the GISCO and HydroBASINS layers to ETRS89 / LAEA Europe (EPSG:3035), calculates polygon intersections, and updates the spatial manifest and checksums.

## Repository guide

- `heatwave-demo.html`, `heatwave-demo.css`, `heatwave-demo.js` - live application interface
- `heatwave-model.js` - transparent heat, water-stress, and impact screening model
- `heatwave-state.js` - validated shareable view state and dynamic date resolution
- `assets/live/forecast.json` - last validated operational snapshot
- `scripts/fetch-live-data.mjs` - Open-Meteo DWD ICON and DWD warning ingestion
- `scripts/build_spatial_crosswalk.py` - reproducible exact-area spatial ETL
- `tests/` - model, live-data, spatial, state, and page-contract checks
- `.github/workflows/pages.yml` - three-hour refresh, test, and Pages deployment

## License and attribution

Project code is available under the [MIT License](LICENSE). Weather data is attributed to Open-Meteo under CC BY 4.0 and uses DWD ICON model output. Spatial, warning, map-tile, and bundled-library terms are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); original source terms continue to apply.
