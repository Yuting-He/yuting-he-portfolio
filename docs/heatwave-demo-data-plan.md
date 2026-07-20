# HeatLens Germany: Operational Data and Decision Design

## Product boundary

HeatLens Germany is a Germany-wide heat and water-stress screening application for three decision contexts:

- residents receive low-regret daily heat and garden prompts;
- farmers receive monitoring and evidence-check prompts, never an autonomous irrigation or harvest instruction;
- municipal teams receive preparedness checks tied back to official warning channels and local heat plans.

The environmental inputs and DWD warning feed are live. The custom 0-100 indices are not calibrated probabilities and are not an official warning service, clinical tool, or agronomic decision system.

## Connection to `material_prep`

The project extends the CAMELS-DE Neckar GNN drought teaching work in `material_prep`. That work organized time-varying hydroclimate inputs and static catchment attributes on a river graph for one-month-ahead drought classification. HeatLens keeps the same modelling discipline while moving to a public operational-data product:

- hydrological units remain the prediction layer;
- static sensitivity stays separate from time-varying forcing;
- spatial aggregation is explicit and reproducible;
- freshness and completeness are checked before presentation;
- consequential actions require official evidence and a responsible human.

The current live index is deliberately interpretable. A Germany-wide graph model should replace it only after temporal and spatial backtesting demonstrates a reliable improvement.

## Spatial architecture

| Layer | Coverage | Responsibility |
| --- | ---: | --- |
| State | 16 NUTS-1 regions | national comparison and first drill-down |
| District / urban district | 400 NUTS-3 regions | administrative screening and response context |
| Sub-basin | 614 Germany-clipped HydroBASINS Level 8 polygons | prediction and hydroclimatic feature unit |

The spatial ETL projects GISCO NUTS 2024 and HydroBASINS to EPSG:3035 and calculates exact polygon intersections. The browser aggregates basin predictions with these versioned overlap areas. Administrative scores are suppressed below 50% exact hydrological coverage.

NUTS-3 is a stable Germany-wide district layer, not a full municipality layer. A future Gemeinde/LAU view needs reliable local vulnerability, heat-plan, and governance data before it can support stronger claims.

## Live ingestion

`scripts/fetch-live-data.mjs` runs the following pipeline:

1. Calculate one representative centroid for each HydroBASINS Level 8 polygon.
2. Query the [Open-Meteo DWD ICON API](https://open-meteo.com/en/docs/dwd-api) in batches of at most 100 coordinates.
3. Respect the free API's [600 calls/minute limit](https://open-meteo.com/en/pricing) with serial batching, delay, and exponential 429 retry.
4. Aggregate hourly VPD and 3-81 cm depth-weighted soil moisture to daily values.
5. Retain daily maximum/minimum temperature, maximum apparent temperature, precipitation, and FAO reference evapotranspiration.
6. Derive forecast persistence and a rolling three-day `precipitation - ET0` balance.
7. Parse the [official DWD warning JSONP feed](https://www.dwd.de/DE/wetter/warnungen_aktuell/objekt_einbindung/objekteinbindung.html) into state-linked warning context.
8. Validate 614 unique basins, a common nine-date window, finite core values, and at least 85% field completeness before an atomic write.

The public date window contains two retrospective model dates and seven forecast dates. Ingestion requests four retrospective days, using the first two only as hidden context so the earliest displayed three-day water balance is complete. The DWD ICON seamless product uses the highest-resolution available ICON model for each lead time. The public snapshot records its generation time, source model, variables, warning issue time, and data completeness.

GitHub Actions refreshes every three hours. At roughly 4,912 weighted coordinate calls per day, this stays below the documented 10,000-call daily and 300,000-call monthly free-tier limits. A failed scheduled refresh does not replace the deployed Pages artifact. The client classifies snapshots as current up to 18 hours, delayed from 18 to 36 hours, and stale after 36 hours. Stale scores remain visible for audit while action prompts are suppressed.

## Screening indices

All component transforms are bounded linear response curves. They are engineering thresholds for a transparent screening product, not fitted German climatological percentiles.

### Heat stress

| Component | Weight | 0-100 response range |
| --- | ---: | --- |
| Daily maximum temperature | 34% | 25-40 C |
| Daily maximum apparent temperature | 30% | 26-42 C |
| Daily minimum temperature | 18% | 16-26 C |
| Forecast heat persistence | 10% | 0-4 days at or above 30 C |
| Daily maximum VPD | 8% | 0.8-3.6 kPa |

### Water stress

| Component | Weight | 0-100 response range |
| --- | ---: | --- |
| 3-81 cm root-zone soil-moisture deficit | 38% | 0.36 to 0.12 m3/m3 |
| Three-day `precipitation - ET0` deficit | 28% | 0 to -18 mm |
| Daily FAO ET0 | 12% | 2-7 mm |
| Daily maximum VPD | 12% | 0.8-3.6 kPa |
| Dry persistence | 10% | 0-7 days |

Absolute soil moisture is sensitive to soil texture and model bias. Until SoilGrids/ESDAC properties and local seasonal percentiles are integrated, this layer is called **water stress**, not drought probability.

### Role-specific impact screening

| Lens | Composition |
| --- | --- |
| Residents | heat 78%, urban/rural exposure assumption 15%, water stress 7% |
| Farmers | water stress 55%, heat 30%, crop-sensitivity assumption 15% |
| Municipal | heat 66%, exposure assumption 22%, water stress 7%, heat persistence 5% |

The fixed urban/rural and crop-sensitivity values are openly labelled assumptions. They prevent the interface from implying that uncollected population, age, crop, soil, healthcare, or response-capacity data already exists.

## Official warnings remain separate

The DWD warning feed is presented in its own block for the selected state. It is never added to the custom 0-100 score. A missing heat warning in the current snapshot is not presented as an all-clear for a later selected date. Users are always linked to the official DWD service.

## Current limitations

- One model-grid sample represents each sub-basin; it is not a raster zonal mean or downscaled urban heat field.
- Deterministic ICON output does not provide forecast probability or ensemble spread in this build.
- Persistence has only two retrospective days of context and can undercount events that began earlier.
- Apparent temperature is not UTCI and does not replace a calibrated human thermal-stress product.
- Root-zone depth weighting does not yet account for local soil texture, rooting depth, groundwater, irrigation, or crop stage.
- NUTS-3 impact sensitivity is assumed, not observed.
- Open-Meteo's free endpoint is suitable for this non-commercial portfolio prototype but has rate limits and no service-level guarantee.

## Production roadmap

1. Backtest by season, NUTS region, urban/rural class, and crop class using archived model runs without look-ahead bias.
2. Add DWD station verification, raster zonal statistics, and bias correction by lead time.
3. Derive local soil-moisture percentiles with ERA5-Land, EDO, SoilGrids/ESDAC, and field observations.
4. Add probabilistic ICON ensemble features and report calibration, Brier score, precision/recall, false-alarm rate, missed-event rate, and lead time.
5. Integrate population age, imperviousness, tree cover, care facilities, crop type, phenology, and response capacity under documented licences and governance.
6. Compare an interpretable baseline with a HydroBASINS graph model using `NEXT_DOWN` and Pfafstetter topology; retain the graph model only if it adds stable, explainable skill.
7. Run human-in-the-loop pilots with public-health, agricultural, and municipal heat-response professionals before any consequential recommendation.
