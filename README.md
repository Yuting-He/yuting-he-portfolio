# Yuting He Portfolio and HeatLens Germany

Personal portfolio for geospatial NatCat risk, hydrology, statistics, and applied AI implementation. The repository also contains **HeatLens Germany**, a public multi-scale heat and drought research application.

- Portfolio: <https://yuting-he.github.io/yuting-he-portfolio/>
- HeatLens: <https://yuting-he.github.io/yuting-he-portfolio/heatwave-demo.html>

## HeatLens capabilities

- 614 Germany-clipped HydroBASINS Level 8 scenario units
- 2,139 exact sub-basin x NUTS-3 overlap records in EPSG:3035
- 400 NUTS-3 city/county views and 16 state summaries
- nearby-date exploration for 8-17 July 2026
- resident, farmer, and municipal decision lenses
- impact, heat-like, and drought-like scenario layers
- shareable URL state and JSON snapshot export
- keyboard-operable SVG map plus native region selector
- fail-closed handling when exact hydrological coverage is below 50%
- bundled D3 and TopoJSON browser libraries with no runtime CDN dependency

## Important data boundary

HeatLens currently uses real open spatial geometry but **synthetic deterministic scenario proxies** for the displayed environmental values. The values are not DWD observations, a live forecast, calibrated UTCI/SPI/soil-moisture products, medical guidance, or agronomic instruction. The application links to official DWD warnings and suppresses actionable output where spatial coverage is insufficient.

The product is useful as an auditable GIS and decision-design research application. Operational warning use requires the real-data, calibration, validation, freshness, and governance work documented in [`docs/heatwave-demo-data-plan.md`](docs/heatwave-demo-data-plan.md).

## Local development

Node.js 20 or newer is required. No package install is necessary.

```bash
npm run serve
```

Open <http://127.0.0.1:4173/>. Run all model, URL-state, spatial-integrity, and DOM-contract tests with:

```bash
npm test
```

## Rebuild spatial weights

The checked-in crosswalk is reproducible with Shapely 2 and pyproj 3:

```bash
python scripts/build_spatial_crosswalk.py
```

The script projects both layers to ETRS89 / LAEA Europe (EPSG:3035), calculates exact polygon intersections, and writes `assets/basin-nuts3-crosswalk.json` plus `assets/spatial-data-manifest.json`. The manifest records sources, method, counts, unmatched border fragments, and SHA-256 checksums.

## Repository guide

- `index.html`, `styles.css` - portfolio homepage
- `heatwave-demo.html`, `heatwave-demo.css` - HeatLens product interface
- `heatwave-demo.js` - map, drill-down, URL state, export, and failure handling
- `heatwave-model.js` - deterministic scenario proxy and aggregation model
- `heatwave-state.js` - validated shareable view state
- `assets/` - spatial geometry, overlap weights, manifest, CV, and portfolio imagery
- `scripts/build_spatial_crosswalk.py` - reproducible exact-area spatial ETL
- `tests/` - model, spatial, URL-state, and page-contract checks
- `.github/workflows/pages.yml` - test-gated GitHub Pages deployment

## License and attribution

Project code is available under the [MIT License](LICENSE). Bundled library and data attribution is recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the data-design document. Source dataset terms continue to apply.
