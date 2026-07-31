# Yuting He Portfolio and HeatLens Germany

Personal portfolio for environmental engineering, statistics, geospatial NatCat risk, and applied AI and AI-assisted development. The repository includes **HeatLens Germany**, a live multi-scale decision-support application for heat, dry stress, and excess water.

- Portfolio: <https://yuting-he.github.io/yuting-he-portfolio/>
- HeatLens: <https://yuting-he.github.io/yuting-he-portfolio/heatwave-demo.html>

## HeatLens capabilities

- live DWD ICON forcing plus ICON-D2/EU/Global daily ensemble means and hourly member standard deviations
- matched DWD station-temperature bias/MAE and RADOLAN rolling 24-hour precipitation checks
- UFZ topsoil and total-soil SMI plus plant-available water
- DWD AMBAV crop-specific nFK using local BÜK1000 soil profiles, averaged from 10 cm layers to 30/60/90 cm
- separately displayed official DWD heat and heavy/persistent-rain warning context
- two retrospective and seven forecast dates
- 614 Germany-clipped HydroBASINS Level 8 prediction units
- exact sub-basin x NUTS-3 overlap weights in EPSG:3035
- 400 NUTS-3 district / urban-district views and 16 state summaries
- GISCO 2024 1:1M boundaries over an OpenStreetMap base map
- resident, farmer, and municipal decision lenses
- farmer crop, growth-stage, and soil-profile scenarios with explicit irreversible-action gates
- separate heat, dry-stress, excess-water, and role-specific impact screening layers
- staged low-regret actions and explicit human-verification gates for residents, farmers, and municipal teams
- direct escalation links to DWD warnings, the German state flood portals, and the UFZ soil-water monitor
- shareable URL state and JSON snapshot export
- per-source freshness, source completeness, spatial coverage, station-distance, and ensemble-dispersion evidence grades

## Decision boundary

Germany already has DWD heat and rain warnings, DWD and UFZ soil-water services, state flood portals, and specialised agricultural advice. HeatLens does not replace them. Its purpose is to connect authoritative context and basin signals to role-specific, reversible decision checks.

The source feeds are real, but HeatLens's 0-100 scores are transparent **uncalibrated screening indices**. They are not probabilities, official warnings, flood forecasts, medical advice, or agronomic instructions. Observations and official warnings remain visibly identifiable, and costly or irreversible actions always require local verification.

The current impact layer still uses explicit urban/rural exposure and crop-sensitivity assumptions. A snapshot older than 36 hours remains visible for audit, but the application suppresses suggested actions. See [`docs/heatwave-demo-data-plan.md`](docs/heatwave-demo-data-plan.md) for formulas, limitations, governance, and the calibration roadmap.

## Local development

HeatLens opens in a plain-language explanation mode that translates the selected heat and soil-water signals into an overall situation, heat meaning, ground or crop meaning, rain and standing-water meaning, confidence, and role-specific next actions. Technical detail remains available in the same interface with exact parameters, source timestamps, and model provenance. The selected explanation mode is included in shareable URLs and JSON exports.

Node.js 20 or newer is required.

```bash
npm ci
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

The ingestion job queries forecast and observation sources in rate-limited batches, decodes HDF5 / NetCDF4 grids, validates all 614 basins and nine dates, and atomically replaces `assets/live/forecast.json`. GitHub Actions repeats this every six hours. A failed scheduled refresh skips deployment so the last successful Pages release stays online.

## Spatial ETL

Rebuild the exact-area crosswalk with Shapely 2 and pyproj 3:

```bash
python scripts/build_spatial_crosswalk.py
```

The script projects the GISCO and HydroBASINS layers to ETRS89 / LAEA Europe (EPSG:3035), calculates polygon intersections, and updates the spatial manifest and checksums.

## Repository guide

- `heatwave-demo.html`, `heatwave-demo.css`, `heatwave-demo.js` - live application interface
- `heatwave-model.js` - transparent heat, dry, excess-water, impact, and action-policy model
- `heatwave-language.js` - deterministic plain-language translation and decision-safety wording
- `heatwave-state.js` - validated shareable view state and dynamic date resolution
- `assets/live/forecast.json` - last validated operational snapshot
- `scripts/fetch-live-data.mjs` - coordinated deterministic and ensemble forecast ingestion
- `scripts/grid-sources.mjs` - UFZ, DWD soil WCS, and RADOLAN HDF5 adapters
- `scripts/dwd-stations.mjs` - DWD station discovery and temperature-observation adapter
- `scripts/build_spatial_crosswalk.py` - reproducible exact-area spatial ETL
- `tests/` - model, live-data, spatial, state, and page-contract checks
- `.github/workflows/pages.yml` - six-hour refresh, test, and Pages deployment

## License and attribution

Project code is available under the [MIT License](LICENSE). Forecast, observation, soil-water, spatial, warning, map-tile, and bundled-library terms are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); original source terms continue to apply.
