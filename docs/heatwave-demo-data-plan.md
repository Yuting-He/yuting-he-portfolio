# HeatLens Germany: Data and Decision Design

## Purpose and boundary

HeatLens Germany is a portfolio prototype for a Germany-wide heatwave resilience map. It is designed to show how GIS, hydroclimatic data, uncertainty-aware scoring, and AI-assisted product implementation can support distinct decision contexts:

- residents: low-regret daily heat and garden guidance;
- farmers: irrigation and crop-stress monitoring prompts, never an unverified harvest instruction;
- municipal teams: heat-protocol, outdoor-work, cool-space, and service-readiness prompts.

The current front-end runs a deterministic ten-day synthetic scenario from 8-17 July 2026. It exercises the complete spatial and decision workflow, but it is not an operational warning service, a clinical tool, or agronomic advice. Environmental values are deliberately labelled as proxies rather than real UTCI, SPI, soil-moisture, ET, FAPAR, or flow products.

## 2026 motivation, without over-attribution

The summer 2026 backdrop is a reason to build preparedness tools, not evidence that a particular German heat dome was caused by one climate driver. In July 2026 the [WMO reported a developing and strengthening El Nino](https://wmo.int/media/news/el-nino-forecast-intensify-increasing-likelihood-of-extreme-weather), which raises the global likelihood of heatwaves and other extremes; [WHO/Europe also warned of continued extreme-heat risk in the region](https://www.who.int/europe/news/item/07-07-2026-statement---extreme-heat--more-deadly-weeks-may-still-lie-ahead-for-the-european-region). European summer circulation is strongly shaped by regional weather patterns and the North Atlantic, so HeatLens does not use ENSO as a direct German heat-alert trigger. It uses local forecast, thermal-comfort, land-surface, and water-balance signals instead.

## Connection to `material_prep`

The prototype extends the CAMELS-DE Neckar GNN drought teaching work rather than treating heat as a disconnected topic. The previous project used 21 catchment nodes, 12 months of hydroclimatic history, static soil/landscape/hydrological attributes, and spatial adjacency to predict a one-month-ahead four-class SPI-like drought target. A stored training history reported validation macro-F1 of about 0.75; that historical result is not reproduced or independently verified in this repository.

HeatLens keeps the same modelling instincts:

- use spatial units and joinable GIS layers;
- separate static vulnerability from time-varying forcing;
- create explicit temporal features and quality checks;
- keep current prompts low-regret and require human verification before consequential action;
- validate a model spatially and temporally before turning it into operational advice.

## Implemented spatial architecture

| Layer | Implemented coverage | Responsibility |
| --- | ---: | --- |
| State | 16 NUTS-1 regions | national comparison and first drill-down |
| City / county | 400 NUTS-3 regions | administrative impact index and municipal response |
| Sub-basin | 614 Germany-clipped HydroBASINS Level 8 polygons | heat, drought, soil-water and hydroclimatic prediction unit |

The model computes each date at the sub-basin level. A reproducible spatial ETL projects both layers to ETRS89 / LAEA Europe (EPSG:3035) and creates 2,139 exact basin x NUTS-3 intersection records. These weights cover all 400 NUTS-3 regions and 605 sub-basins. Nine coastal/border fragments have no actual NUTS-3 intersection and are recorded in the manifest rather than assigned to a nearest region. Administrative scores fail closed when the exact hydrological overlap is below 50% of the selected region.

The crosswalk, generation method, source URLs, unmatched IDs, and SHA-256 checksums are versioned in `assets/spatial-data-manifest.json`. `scripts/build_spatial_crosswalk.py` reproduces the output with Shapely and pyproj.

NUTS-3 is used because it provides a stable Germany-wide layer containing urban districts and rural counties at a web-manageable resolution. True municipality/LAU deployment can be added after population, vulnerability and local heat-plan data are available consistently.

## Risk model

Each synthetic feature is mapped to 0-100 with transparent bounded response curves chosen for interface testing. These are not fitted seasonal or local reference distributions. The public map exposes the scenario components, exact spatial coverage, a deterministic consistency proxy, and the non-operational boundary.

| Decision lens | Indicative score composition | Intended action level |
| --- | --- | --- |
| Residents | heat stress 72%, exposure 20%, drought context 8% | information and low-regret protective actions |
| Farmers | drought stress 62%, heat stress 26%, crop sensitivity 12% | monitoring and conditional field checks |
| Municipal | heat stress 55%, synthetic exposure assumption 22%, drought stress 15%, persistence proxy 8% | evidence checks; authority verifies escalation |

This is a transparent synthetic scenario score, not a calibrated impact model. The exposure and crop-sensitivity inputs are deterministic assumptions derived for interface testing, not observed vulnerability data. A production model would estimate probabilities for concrete outcomes, calibrate them by German region and season, and report uncertainty intervals.

## Open data stack

Only the HydroBASINS and GISCO geometry is currently bundled and used in calculations. DWD, ERA5, EDO, land-cover, population, health, and crop sources below are the target operational data architecture, not data already powering the public scenario.

| Need | Candidate open source | Variables and use |
| --- | --- | --- |
| Official short-horizon weather and alerts | [DWD Open Data and Climate Data Center](https://www.dwd.de/EN/ourservices/cdc/cdc_ueberblick-klimadaten_en.html), [DWD CAP alert products](https://opendata.dwd.de/weather/alerts/cap/) | 2 m temperature, humidity/dew point, wind, radiation, precipitation, station observations, forecast fields, official alert status |
| Human heat stress | [ERA5-HEAT / UTCI](https://cds.climate.copernicus.eu/datasets/derived-utci-historical?tab=overview) | UTCI, heat-stress climatology, event thresholds |
| Water balance and soil moisture | [ERA5-Land hourly time series](https://cds.climate.copernicus.eu/datasets/reanalysis-era5-land-timeseries?tab=download) | volumetric soil water levels 1-4, precipitation, surface radiation, total evaporation, vegetation transpiration, potential evaporation, 2 m temperature, wind |
| Agricultural drought and vegetation response | [Copernicus European Drought Observatory](https://drought.emergency.copernicus.eu/tumbo/edo/map/) | SPI, Soil Moisture Index Anomaly, FAPAR anomaly, Combined Drought Indicator, low-flow context |
| Hydrological prediction geometry | [HydroBASINS Level 8](https://www.hydrosheds.org/products/hydrobasins) | consistently sized, hierarchically coded sub-basins with upstream/downstream identifiers; 614 polygons after clipping to Germany |
| National map geometry | [Eurostat GISCO NUTS 2024](https://ec.europa.eu/eurostat/web/gisco/geodata/statistical-units/territorial-units-statistics) | NUTS-1/2/3 boundaries for aggregation, display and linkage to regional statistics |
| Static landscape and exposure | Copernicus Land Monitoring Service, OpenStreetMap, Eurostat/DESTATIS regional statistics, ESDAC or SoilGrids | imperviousness, green cover, crop/land cover, population density and age proxies, hospitals/cooling sites, soil texture and water-holding capacity |

### Derived variables

1. Heat hazard: daily maximum and minimum temperature, UTCI maximum, tropical nights, heatwave duration, humidity, wind, radiation, and ensemble exceedance probability.
2. Atmospheric demand: vapour-pressure deficit (VPD), reference ET0, actual ET, potential ET, and a seven-day ET deficit.
3. Water availability: layer-weighted root-zone soil-water percentile, antecedent precipitation, SPI-1/SPI-3, soil moisture anomaly, and baseflow or low-flow indicators where appropriate.
4. Vegetation and agriculture: FAPAR anomaly, land cover/crop type, phenology, irrigation context, soil available-water capacity, and field sensor inputs where a user supplies them.
5. Exposure and response capacity: population and age structure, urban imperviousness/tree cover, healthcare/cooling-site proximity, outdoor-worker locations, and municipal service constraints.

## Data workflow

```text
DWD observations + forecast + CAP alerts
ERA5-Land + ERA5-HEAT + EDO drought indicators
HydroBASINS L8 + GISCO NUTS + exposure/soil/land-cover layers
                 |
                 v
        QA, temporal alignment, bias checks, freshness flags
                 |
                 v
        daily sub-basin feature store and prediction
                 |
                 v
    exact spatial crosswalk to NUTS-3 and state aggregation
                 |
                 v
  transparent scenario components + low-regret evidence checks
```

## Safety and uncertainty rules

- The current deterministic consistency proxy is not forecast confidence and must never be presented as one. A future confidence score must combine ensemble agreement, source agreement, data freshness, and spatial coverage with auditable components.
- Residents receive only low-regret suggestions unless an official DWD alert is present.
- Farmers never receive an autonomous instruction to harvest, irrigate, or deploy costly protection. The interface must request a local station check, field observation, crop-stage check, water-allocation check, and human agronomic confirmation before such a decision.
- Municipal prompts must link back to the responsible authority's local heat plan and official DWD/BBK warning channels.
- The current JSON export retains model version, scenario date, region, score components, spatial coverage, and the non-operational boundary. A future service should additionally retain source timestamps, forecast run, recommendation policy version, and user acknowledgement for review.

## Evaluation before operational use

1. Backtest heat and drought alerts by NUTS-2/3 and by urban/rural/crop strata.
2. Measure probabilistic calibration, Brier score, precision/recall, lead time, false-alarm rate, and missed-event rate.
3. Evaluate impact links separately: health outcomes, irrigation demand, crop-stress observations, and municipal service load do not share one ground truth.
4. Run human-in-the-loop pilots with a public-health professional, an agricultural advisor, and a municipal heat officer.
5. Compare an interpretable baseline against the GNN-informed drought module, and retain the simpler model unless the spatial model produces reliable, explainable benefit.

## Next production steps

- Replace deterministic scenario forcing with scheduled DWD forecast/observation ingestion and ERA5/EDO lagged features.
- Replace the current browser-loaded exact crosswalk with a server-side versioned feature store when live data volumes require it.
- Calibrate sub-basin probabilities against observed heat, soil-moisture, low-flow, crop-stress and health outcomes; publish uncertainty intervals.
- Use HydroBASINS `NEXT_DOWN` and Pfafstetter codes to extend the Neckar GNN concept to Germany-wide river-network message passing.
- Add LAU/municipality and neighbourhood views only where local exposure, heat-plan and governance data support a reliable decision product.
