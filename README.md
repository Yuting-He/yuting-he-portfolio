# Yuting He Portfolio and HeatLens Germany

Personal portfolio for environmental engineering, statistics, geospatial NatCat risk, and applied AI and AI-assisted development. The repository includes **HeatLens Germany**, a live multi-scale decision-support application for heat, dry stress, and excess water.

- Portfolio: <https://yuting-he.github.io/yuting-he-portfolio/>
- HeatLens: <https://yuting-he.github.io/yuting-he-portfolio/heatwave-demo.html>

## HeatLens capabilities

- live DWD ICON forcing plus ICON-D2/EU/Global daily ensemble means and hourly member standard deviations
- matched DWD station-temperature bias/MAE and RADOLAN rolling 24-hour precipitation checks
- UFZ v2 14-day-mean topsoil and total-soil SMI plus daily plant-available water
- DWD AMBAV crop-specific nFK using local BUEK1000 soil profiles, averaged from 10 cm layers to 30/60/90 cm
- separately displayed official DWD heat and heavy/persistent-rain warning context
- two retrospective and seven forecast dates
- 614 Germany-clipped HydroBASINS Level 8 prediction units
- exact sub-basin x NUTS-3 overlap weights in EPSG:3035
- 400 NUTS-3 district / urban-district views and 16 state summaries
- GISCO 2024 1:1M boundaries over an OpenStreetMap base map
- resident, farmer, gardener, and municipal decision lenses
- nine farm crop profiles, date-estimated or manual growth stage, soil scenarios, and task-specific advice focus
- six ornamental-plant profiles with container/open-ground/rain-shadow and drainage context
- separate heat, dry-stress, excess-water, and role-specific impact screening layers
- staged low-regret actions and explicit human-verification gates for residents, farmers, gardeners, and municipal teams
- direct escalation links to DWD warnings, the German state flood portals, and the UFZ soil-water monitor
- shareable URL state and JSON snapshot export
- complete English/German interface switching, including generated explanations, actions, dates, status messages, and shareable `lang` state
- per-source freshness, source completeness, spatial coverage, station-distance, and ensemble-dispersion evidence grades
- searchable state/district navigation, consistent map selection and explicit drill-down breadcrumbs
- results-first mobile workspace with map/results tabs, collapsible role settings and priority actions
- explicit expired-link date notices, a Berlin-time date strip and in-page snapshot update checks
- versioned national overview and on-demand state bundles, verified by SHA-256 before use

## Decision boundary

Germany already has DWD heat and rain warnings, DWD and UFZ soil-water services, state flood portals, and specialised agricultural advice. HeatLens does not replace them. Its purpose is to connect authoritative context and basin signals to role-specific, reversible decision checks.

The source feeds are real, but HeatLens's 0-100 scores are transparent **uncalibrated screening indices**. They are not probabilities, official warnings, flood forecasts, medical advice, or agronomic instructions. Observations and official warnings remain visibly identifiable, and costly or irreversible actions always require local verification.

The current impact layer still uses explicit urban/rural exposure and crop-sensitivity assumptions. A snapshot older than 36 hours remains visible for audit, but the application suppresses suggested actions. See [`docs/heatwave-demo-data-plan.md`](docs/heatwave-demo-data-plan.md) for formulas, limitations, governance, and the calibration roadmap.

## Local development

HeatLens opens in a plain-language explanation mode that translates the selected heat and soil-water signals into an overall situation, heat meaning, ground or crop meaning, rain and standing-water meaning, confidence, and role-specific next actions. Technical detail remains available in the same interface with exact parameters, source timestamps, and model provenance. The interface and generated guidance can be switched between English and German; language and explanation mode are included in shareable URLs and JSON exports. Browsers configured for German start in German unless an explicit `?lang=en` or `?lang=de` URL state is present.

Personalised farm and garden advice is deterministic and runs in the browser, so the public demo has no per-query AI charge and no exposed API key. Crop or plant selections change transparent thresholds, context, and action ordering. A future language-model layer may parse questions or rewrite the same approved actions, but it must not create irrigation volumes, harvest decisions, or unsupported diagnoses.

Node.js 20 or newer is required.

```bash
npm ci
npm run serve
```

Open <http://127.0.0.1:4173/> and run all tests with:

```bash
npm test
```

Build the immutable data products and run the browser regression suite:

```bash
npm run build-assets
npx playwright install chromium
npm run test:browser
```

CI installs Chromium and its Linux dependencies, tests real keyboard/search/navigation, narrow-screen German layouts, role settings, failed requests, immutable-version updates and shared URLs, and retains traces/screenshots on failure. `npm test` also checks exact precomputation parity for every state, role and date. Browser tests mock background map tiles; they never modify or present their replay fixtures as new observations.

`npm run serve` creates the manifest and versioned products from the bundled snapshot if they are absent. It can use saved data offline; all original source times and expiry rules remain visible. After changing a local snapshot, run `npm run build-assets` again. To download the current nine-day window and then start the local site, use:

```bash
npm run serve:live
```

Refresh the live snapshot with internet access:

```bash
npm run refresh-data
```

The ingestion job queries forecast and observation sources in rate-limited batches, decodes HDF5 / NetCDF4 grids, validates all 614 basins and nine dates, and atomically replaces `assets/live/forecast.json`. UFZ v2 uses a geographic 0.015625-degree grid, with separate timestamps for 14-day-mean SMI and daily plant-available water. The source URLs and version are retained in the snapshot.

GitHub Actions refreshes data every six hours and on manual dispatch. Those runs must pass the strict real-clock publication check: a newly generated snapshot, today's Berlin forecast window and each required source's raw timestamp. Failed live refreshes fail the workflow and preserve the previous Pages release. Ordinary pushes and pull requests reuse the validated public snapshot, with an explicitly reported repository fallback if needed; `--saved` validates the saved record without changing its generation/source times. Expired saved values remain visibly expired and cannot generate current advice. This lets code updates proceed independently of upstream availability. Pull requests run the same model, browser and assembly checks without deploying. Every attempt retains refresh/reuse/publication diagnostics. GitHub may disable scheduled workflows after inactivity; re-enable the workflow in Actions if its state is `disabled_inactivity`, then run it manually and verify a successful Pages deployment.

After Pages deployment, the runner checks the public site with `node scripts/verify-live-site.mjs`, using only Node.js and the checked-out application modules. It verifies the exact commit and immutable snapshot produced by that run, the homepage/HeatLens/two GridScout pages, all eleven HeatLens JavaScript modules and both stylesheets against the checkout, immutable overview/regional SHA-256 values, shared source metadata, and the complete 614-basin/nine-day forecast contract. Commit or snapshot propagation and transient network failures have at most six 15-second attempts with five-second pauses; missing files, changed content or mixed versions fail verification. Saved deployments retain and report their genuine age; live deployments must still pass the real-clock source limits. The `heatlens-live-site-verification` artifact contains `artifacts/live-site-verification.json` even on verification failure. Browser regression checks use the Chromium headless shell in CI to avoid downloading the unused headed browser.

The client initially requests only `assets/live/manifest.json` and its immutable national overview. Regional geometry, exact overlap weights and complete dependent basin records load on demand. Cross-border records are never assigned by centroid: the crosswalk maps 604 of the 614 available basins; the remaining ten keep their unassigned status. Display, model and snapshot versions remain separate. A failed regional request preserves the existing view; retry bypasses any cached error response. New snapshots are offered in-page and applied atomically while preserving valid user selections. A copied view URL follows available data; JSON export records the exact immutable snapshot ID.

DWD warning context has its own eight-hour freshness limit. The interface labels stale or unverified feeds as saved context, shows their issue time and affected areas, and does not interpret a missing entry as an all-clear. Warnings are grouped by state; district and sub-basin views explicitly show state-wide background, without inheriting state warning counts into local action advice. State-level warning prompts only use alerts active now on today's Berlin date. Precise DWD-to-NUTS warning-area matching remains a future improvement.

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
- `heatwave-language-de.js`, `heatwave-i18n.js` - German decision wording and shared EN/DE interface localization
- `heatwave-state.js` - validated shareable view state and dynamic date resolution
- `heatwave-warnings.js` - independent warning freshness, state scope and English/German explanations
- `heatwave-data.js` - versioned data client, integrity checks and role-specific effective context
- `heatwave-spatial.js` - spatial indexes, exact weights and cached regional calculation
- `heatwave-results.js`, `heatwave-controls.js` - result/evidence rendering and keyboard location search
- `assets/live/forecast.json` - last validated operational snapshot
- `scripts/fetch-live-data.mjs` - coordinated deterministic and ensemble forecast ingestion
- `scripts/grid-sources.mjs` - UFZ, DWD soil WCS, and RADOLAN HDF5 adapters
- `scripts/check-live-freshness.mjs` - real-clock publication gate and refresh diagnostic summary
- `scripts/build-heatlens-assets.mjs` - reproducible default overview and regional bundle generation
- `scripts/reuse-published-data.mjs` - saved snapshot reuse with explicit provenance and fallback
- `scripts/assemble-site.mjs` - dependency-traced atomic assembly, manifest integrity and build metadata
- `scripts/verify-live-site.mjs` - post-deployment public HTTP, source metadata and exact-version verification without data-adapter dependencies
- `playwright.config.mjs`, `tests/browser/` - real browser workflow and failure-recovery regression checks
- `scripts/dwd-stations.mjs` - DWD station discovery and temperature-observation adapter
- `scripts/build_spatial_crosswalk.py` - reproducible exact-area spatial ETL
- `tests/` - model, live-data, spatial, state, and page-contract checks
- `.github/workflows/pages.yml` - six-hour refresh, test, and Pages deployment

## License and attribution

Project code is available under the [MIT License](LICENSE). Forecast, observation, soil-water, spatial, warning, map-tile, and bundled-library terms are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); original source terms continue to apply.
