# HeatLens Germany: Operational Data and Decision Design

## Product purpose

HeatLens is a decision-translation layer, not another official warning system. It connects authoritative context, basin-scale environmental signals, and a user's decision setting:

1. **Authority layer** - DWD heat and rain warnings and links to state flood services remain separate and authoritative.
2. **Screening layer** - transparent 0-100 heat, dry, and excess-water indices explain which model signals deserve attention.
3. **Decision layer** - role-specific rules order reversible checks, evidence verification, and escalation while blocking unsafe automation.

Residents receive low-regret heat and local-water prompts. Farmers receive crop-, stage-, soil-, and task-specific field checks, never an autonomous irrigation, harvest, or chemical-use instruction. Gardeners receive plant-, setting-, drainage-, season-, and weather-specific checks that work without a sensor. Municipal teams receive preparedness checks tied to official warnings, state flood information, local plans, observations, and responsible authorities.

## Verified German service landscape

Germany already provides substantial monitoring, forecast, and warning infrastructure:

| Service | Existing capability | Boundary relevant to HeatLens |
| --- | --- | --- |
| [DWD weather warnings](https://www.dwd.de/DE/wetter/warnungen_aktuell/kriterien/warnkriterien.html) | Official heat, heavy-rain, persistent-rain, and other weather warnings | Authoritative hazard warning; HeatLens must not replace or rescore it |
| [DWD soil-moisture viewer](https://www.dwd.de/bodenfeuchteviewer) | Daily AMBAV soil moisture for crops and depths; WCS values are machine-readable as percent nFK | DWD percentile maps use a separate 1991-2020 reference but are currently published as non-georeferenced PNGs, not a stable numeric API |
| [DWD soil-moisture forecasts](https://www.dwd.de/DE/leistungen/kvhs_de/help_de/1_bkgrd_info/04_predictions/08_soil_moisture.html) | Dry/normal/wet outlooks for weeks 2-5 and seasonal horizons | Longer-range category outlook under reference vegetation |
| [UFZ Dürremonitor](https://www.ufz.de/index.php?de=37937&m=0) | Daily nationwide dry and wet recurrence classes and plant-available water | Scientific monitoring and download service, not an official crop-operation warning |
| [German flood portal](https://www.hochwasserzentralen.de/) | Official state flood warnings, gauges, and situation reports | Required source for river flooding; meteorological wetness is not flood probability |
| [DWD Agrowetter irrigation](https://www.dwd.de/DE/leistungen/agrowetter_beregnung/agrobereg.html) | Paid crop-, soil-, and site-specific four-day irrigation advice | Specialised service demonstrating why HeatLens must avoid invented irrigation amounts |

The defensible gap is therefore not missing data. It is the absence of one free, nationwide, short-horizon workflow that jointly presents heat, dry, and excess-water signals and translates them into transparent low-regret checks for four user groups. HeatLens fills that orchestration and communication gap.

## Connection to `material_prep`

The project extends the CAMELS-DE Neckar GNN drought teaching work in `material_prep`. That work organised time-varying hydroclimate inputs and static catchment attributes on a river graph for one-month-ahead drought classification. HeatLens keeps the same discipline:

- hydrological units remain the prediction layer;
- static sensitivity stays separate from time-varying forcing;
- spatial aggregation is explicit and reproducible;
- freshness and completeness are checked before presentation;
- consequential actions require official evidence and a responsible human.

The operational baseline remains interpretable. A graph model should replace it only after leakage-safe temporal and spatial backtesting demonstrates stable added skill.

## Spatial architecture

| Layer | Coverage | Responsibility |
| --- | ---: | --- |
| State | 16 NUTS-1 regions | national comparison and first drill-down |
| District / urban district | 400 NUTS-3 regions | administrative screening and response context |
| Sub-basin | 614 Germany-clipped HydroBASINS Level 8 polygons | prediction and hydroclimatic feature unit |

GISCO NUTS 2024 and HydroBASINS are projected to EPSG:3035 for exact polygon intersections. The browser area-weights basin predictions into administrative regions. Scores fail closed below 50% exact hydrological coverage or 85% source completeness.

## Live ingestion

`scripts/fetch-live-data.mjs`:

1. samples one representative centroid for each Level 8 sub-basin;
2. queries Open-Meteo's DWD ICON seamless endpoint in rate-limited batches;
3. queries ICON-D2-EPS daily means and hourly member standard deviations for the near term, then ICON-EU/Global EPS seamless fields for the remaining horizon;
4. downloads UFZ v2 geographic NetCDF grids (0.015625-degree longitude/latitude spacing), decodes the newest time plane with descending latitude preserved, and samples 14-day-mean topsoil/total-soil SMI plus daily 0-25 cm plant-available water; SMI uses the 1974-2023 reference period;
5. downloads DWD AMBAV WCS grids for dominant land use, grass, maize, and winter wheat, then averages 10 cm layers to 30/60/90 cm root zones;
6. decodes the DWD RADOLAN SF HDF5 rolling 24-hour, gauge-adjusted precipitation composite;
7. builds a spatially distributed network of up to 160 DWD POI stations, maps observations to sub-basins with both mean and farthest-match distance retained, and reports area-weighted matched-pair bias and MAE rather than subtracting unmatched regional maxima;
8. retains daily maximum/minimum and apparent temperature, precipitation, FAO ET0, VPD, and model soil moisture;
9. derives heat/dry persistence and rolling three-day `precipitation - ET0`;
10. parses DWD heat and heavy/persistent-rain warnings by state, preserving warning-cell/region identifiers for future verified local mapping;
11. validates 614 unique basins, observed-source coverage, ensemble coverage, and one common two-past/seven-forecast-day window before atomic write.

The public snapshot records every source's valid time, observation period, resolution, model, variables, station/cell distance, warning issue time, and completeness. Every accepted DWD station must itself be no more than 8 hours old. A refresh fails closed when RADOLAN or the retained DWD station network are more than 8 hours old, or when UFZ or DWD daily soil data are more than 96 hours old. The browser recalculates those limits against the current clock every minute, so a failed refresh suppresses actions as soon as a component expires rather than waiting for the 36-hour snapshot gate. GitHub Actions refreshes every six hours. Snapshots are current up to 18 hours, delayed from 18 to 36 hours, and stale after 36 hours. Stale scores remain visible for audit while actions are suppressed.

UFZ and DWD soil values are dated baselines, not daily forecasts. They are never attached to a retrospective date before their own valid date, which prevents future-information leakage. For the valid date and later forecast dates they initialise the observed water-state context while ICON soil moisture and water balance provide the changing daily forecast. RADOLAN and latest station temperature are similarly withheld from earlier retrospective dates. UFZ component timestamps are recorded separately and each component respects its own date; the oldest component sets the combined freshness time. Plant-available water above 100% is retained. The v2 valid-cell fallback is capped at 24 km, a physical bound comparable to the former six 4 km cells; the actual geographic sampling distance is recorded and must not be interpreted as a local measurement.

Scheduled and manually requested data refreshes require successful ingestion and a separate real-clock check: snapshot age at most two hours, a contiguous nine-day window anchored on today's Berlin date, and unchanged required-source freshness limits. The gate runs again immediately before publication. Failure preserves the deployed site and fails the workflow rather than reporting a green refresh. Ordinary code pushes and PR validation may reuse an explicitly identified saved snapshot without changing source clocks; stale saved data cannot produce current advice. Per-attempt JSON diagnostics and the Actions summary record refresh/reuse origin, source ages and errors. Scheduled workflows must be re-enabled if GitHub disables them after inactivity.

## Screening indices

All transforms are bounded engineering response curves, not fitted German climatological percentiles or calibrated probabilities.

### Heat stress

| Component | Weight | 0-100 response range |
| --- | ---: | --- |
| Daily maximum temperature | 34% | 25-40 C |
| Daily maximum apparent temperature | 30% | 26-42 C |
| Daily minimum temperature | 18% | 16-26 C |
| Forecast heat persistence | 10% | 0-4 days at or above 30 C |
| Daily maximum VPD | 8% | 0.8-3.6 kPa |

### Dry stress

| Component | Weight | 0-100 response range |
| --- | ---: | --- |
| 3-81 cm model soil-moisture deficit | 28% | 0.36 to 0.12 m3/m3 |
| Three-day `precipitation - ET0` deficit | 20% | 0 to -18 mm |
| Daily FAO ET0 | 10% | 2-7 mm |
| Daily maximum VPD | 8% | 0.8-3.6 kPa |
| Dry persistence | 6% | 0-7 days |
| UFZ topsoil SMI | 16% | 0.40 to 0.02 |
| UFZ total-soil SMI | 12% | 0.35 to 0.02 |

### Excess-water stress

| Component | Weight | 0-100 response range |
| --- | ---: | --- |
| 3-81 cm model soil moisture | 30% | 0.30-0.48 m3/m3 |
| Positive three-day `precipitation - ET0` | 23% | 5-45 mm |
| Daily precipitation | 23% | 10-55 mm |
| Maximum hourly precipitation | 12% | 5-25 mm |
| UFZ topsoil and total-soil wet percentiles | 12% | SMI 0.70-0.98 |

Dry and wet scores remain independent: dry root-zone conditions and short intense rainfall can coexist. The excess-water layer is a waterlogging/runoff screening signal, not a river-flood probability. Absolute soil moisture remains sensitive to soil texture, model bias, rooting depth, drainage, groundwater, irrigation, and crop stage.

### Role-specific impact

| Lens | Composition |
| --- | --- |
| Residents | heat 72%, exposure assumption 13%, dry 7%, excess water 8% |
| Farmers | dry 34%, excess water 28%, heat 20%, crop-sensitivity assumption 18% |
| Gardeners | dry 38%, excess water 24%, heat 20%, selected plant sensitivity 18% |
| Municipal | heat 50%, excess water 22%, exposure assumption 18%, dry 5%, heat persistence 5% |

For the farmer lens, DWD crop-specific nFK contributes 18% of the dry-state result and 12% of the wet-state result only when at least 85% of the selected region's area has a valid crop/depth value. Growth stage selects a 30, 60, or 90 cm root zone and changes crop sensitivity. Maize, winter wheat, grass, and local dominant land use use directly ingested DWD profiles. Winter barley, potato, sugar beet, winter oilseed rape, and orchard are useful decision contexts but use a visibly labelled DWD reference profile rather than claiming crop-specific measurement. Auto stage is a coarse German month-based planning estimate; the user can and should replace it with the observed field stage. The local DWD/BUEK profile is the default; sandy, loamy, and clayey choices are explicit scenario adjustments rather than mapped observations.

For the gardener lens, plant sensitivity, container/open-ground/rain-shadow exposure, and drainage context adjust the dry and wet screening result. The DWD local dominant-land-use profile is only a regional reference at the nearest supported 30, 60, or 90 cm depth. It is never presented as a measurement inside a pot or individual root ball. Advice therefore starts with observation-led checks such as pot weight, moisture below the surface, root-ball versus surrounding soil, visible persistent stress, and standing water.

## Personalisation architecture

Release `0.8.0` uses a deterministic guided-personalisation engine. This is the production choice for the public static demo because it has zero per-query inference cost, needs no secret key, works on ordinary mobile devices, is testable, and keeps consequential advice traceable to approved rules.

The alternative language-model paths remain optional extensions:

- A hosted model API requires a server-side or edge proxy so credentials are never shipped to the browser. Usage is metered, and a public endpoint also needs quotas, rate limits, abuse controls, caching, and monitoring.
- A free cloud allowance is suitable for development but is not a dependable public-service budget.
- Browser-local inference avoids an API bill and keeps prompts on-device, but current WebGPU support, model download size, memory use, and mobile performance make it an opt-in enhancement rather than the default.

A future conversational interface should map free text into the existing crop/plant, stage/season, setting, drainage, and advice-focus schema. The deterministic engine must continue to calculate the risk context and allowed actions. A model may explain or rephrase those actions, but must not invent an irrigation amount, diagnosis, pesticide treatment, harvest instruction, or official warning.

Urban/rural exposure remains an explicit placeholder. This prevents the interface from implying that age, health, critical infrastructure, or response-capacity data has already been collected.

## Recommendation policy

Recommendation policy `0.8.0` uses four internal screening bands: Low, Moderate, High, and Very high. These are not DWD warning levels.

Every audience receives a different sequence:

- **Residents** - protective timing, vulnerable-person checks, measured garden watering, standing-water precautions, and official-source checks.
- **Farmers** - representative field measurements, date-estimated or manual crop stage, crop/profile provenance, task focus, dry/wet/heat readiness, and an explicit prohibition on autonomous harvest, irrigation-volume, pesticide, or other irreversible decisions.
- **Gardeners** - selected ornamental-plant and growing-place checks, forecast-rain deferral, heat protection, drainage checks, seasonal context, and local watering-rule verification.
- **Municipal teams** - official-source verification, heat-plan readiness, drainage and access checks, public-green-space triage, and a responsible-authority activation gate.

Official warning counts affect state-level action wording only when the feed is at most eight hours old, the selected date is today in Berlin, and the warning interval is active now. District and sub-basin actions do not inherit state-wide counts because the warning areas have not been mapped to those units. Warning panels show all matching affected areas and validity intervals as state-wide background, alongside issue time and independent freshness status. Saved/invalid feeds never establish current warning conditions; missing entries never establish an all-clear. These counts never enter the custom 0-100 score. The feed is not a retrospective archive or a warning forecast for the full horizon. River flooding must be checked through the responsible state flood service.

## Workbench and publication upgrade

The workbench uses a results-first mobile layout, searchable state/district selection and explicit drill-down. Dates are Berlin calendar dates; an expired or invalid shared date is explained rather than silently replaced. Role settings are retained when changing roles, but only the active role's effective context enters calculation. Residents and municipalities use the default environmental context instead of hidden farm or garden selections.

Data publication derives a SHA-256-verified national overview and immutable state bundles from one complete validated snapshot. All 16 states, four default audiences and nine analysis dates are precomputed with the same prediction and exact-overlap aggregation functions used by detailed client views. Regional bundles include every crosswalk dependency, including cross-border basins. The source contains 614 basins, while 604 have administrative crosswalk records; no administrative assignment is invented for the other ten. Global primary assignments are retained independently of load order. Custom configurations load the selected state's full dependencies; other states are explicitly marked as not yet calculated for that configuration.

The client preserves a verified overview when regional requests fail. It verifies byte size, SHA-256, model version, snapshot identity and date window before accepting an asset; failed/corrupt responses are bypassed on retry. A new manifest is checked when the page returns to the foreground and at bounded intervals. Applying a snapshot preserves valid region, date, role and language settings, while explaining dates that have left the window. Dependent controls pause during the atomic application; language and official services remain available.

Scheduled and manual runs continue to require a genuine fresh ingestion and the strict real-clock gate. Ordinary code updates may reuse a structurally valid public or repository snapshot, preserving every source time and reporting whether advice is current or suppressed. PRs execute the same regression and dependency assembly checks without publication. Static assembly verifies all immutable assets and local dependencies, then records commit, model and snapshot identities in `build-info.json`.

Browser regression covers real DOM state, requests, keyboard navigation, mobile layouts, failed loads, update replays and share restoration. Test-only update replays are labelled fixtures and retain source provenance. Scientific model calibration, precise DWD-to-district warning geometry and durable historical replay storage remain independent follow-up work.

## Current limitations

- One ICON grid sample represents each sub-basin; it is not a raster zonal mean or downscaled urban heat field.
- ICON daily ensemble means and hourly member standard deviations are available. The temperature value is sampled at the hour with the hottest ensemble mean, and the precipitation value is the largest hourly member standard deviation; neither is a daily Tmax standard deviation, confidence interval, or calibrated exceedance probability.
- UFZ SMI supplies a climatological percentile; DWD's machine-readable field is percent nFK, not the DWD percentile-map class.
- DWD percent nFK may legitimately be negative at the surface or exceed 200%; these values are retained rather than replaced with a neighbouring grid cell.
- Apparent temperature is not UTCI.
- NUTS-3 exposure is assumed rather than observed.
- Crop and growth stage are user-declared or coarse date-estimated scenarios; BUEK1000 is a generalised soil profile, not a field measurement. Non-DWD crops use reference profiles. Garden plant types and settings are planning heuristics, not species-level diagnoses. Irrigation history, drainage capacity, river routing, gauge state, and local response capacity remain absent.
- Open-Meteo's free endpoint has rate limits and no service-level guarantee.

## Production roadmap

1. Replace centroid sampling with raster zonal statistics and build lead-time-stratified DWD/RADOLAN validation histories.
2. Calibrate ICON ensemble exceedance probabilities and report reliability, Brier score, false alarms, misses, and useful lead time separately for heat, dry, and wet outcomes.
3. Add higher-resolution state soil data and governed parcel inputs where licensing and user consent permit.
4. Add governed local exposure data: age, imperviousness, tree cover, care facilities, drainage, and response capacity.
5. Connect upstream/downstream topology and official gauges without inferring flood probability from meteorological wetness alone.
6. Compare the interpretable baseline with a HydroBASINS graph model using time- and region-held-out tests.
7. Pilot the decision policy with public-health, agricultural, water, and municipal professionals before stronger recommendations.
8. Add an optional constrained natural-language input layer only after prompt-abuse, cost, output-grounding, and accessibility tests pass.
