# HeatLens Germany: Operational Data and Decision Design

## Product purpose

HeatLens is a decision-translation layer, not another official warning system. It connects authoritative context, basin-scale environmental signals, and a user's decision setting:

1. **Authority layer** - DWD heat and rain warnings and links to state flood services remain separate and authoritative.
2. **Screening layer** - transparent 0-100 heat, dry, and excess-water indices explain which model signals deserve attention.
3. **Decision layer** - role-specific rules order reversible checks, evidence verification, and escalation while blocking unsafe automation.

Residents receive low-regret heat, garden, and local-water prompts. Farmers receive field-verification and operational-readiness prompts, never an autonomous irrigation, harvest, or chemical-use instruction. Municipal teams receive preparedness checks tied to official warnings, state flood information, local plans, observations, and responsible authorities.

## Verified German service landscape

Germany already provides substantial monitoring, forecast, and warning infrastructure:

| Service | Existing capability | Boundary relevant to HeatLens |
| --- | --- | --- |
| [DWD weather warnings](https://www.dwd.de/DE/wetter/warnungen_aktuell/kriterien/warnkriterien.html) | Official heat, heavy-rain, persistent-rain, and other weather warnings | Authoritative hazard warning; HeatLens must not replace or rescore it |
| [DWD soil-moisture viewer](https://www.dwd.de/bodenfeuchteviewer) | Daily soil moisture for crops and depths, including plant-available water and excess-water context | Detailed reference monitoring, not one unified cross-user action workflow |
| [DWD soil-moisture forecasts](https://www.dwd.de/DE/leistungen/kvhs_de/help_de/1_bkgrd_info/04_predictions/08_soil_moisture.html) | Dry/normal/wet outlooks for weeks 2-5 and seasonal horizons | Longer-range category outlook under reference vegetation |
| [UFZ Dürremonitor](https://www.ufz.de/index.php?de=37937&m=0) | Daily nationwide dry and wet recurrence classes and plant-available water | Scientific monitoring and download service, not an official crop-operation warning |
| [German flood portal](https://www.hochwasserzentralen.de/) | Official state flood warnings, gauges, and situation reports | Required source for river flooding; meteorological wetness is not flood probability |
| [DWD Agrowetter irrigation](https://www.dwd.de/DE/leistungen/agrowetter_beregnung/agrobereg.html) | Paid crop-, soil-, and site-specific four-day irrigation advice | Specialised service demonstrating why HeatLens must avoid invented irrigation amounts |

The defensible gap is therefore not missing data. It is the absence of one free, nationwide, short-horizon workflow that jointly presents heat, dry, and excess-water signals and translates them into transparent low-regret checks for three user groups. HeatLens fills that orchestration and communication gap.

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
3. retains daily maximum/minimum and apparent temperature, precipitation, and FAO ET0;
4. aggregates hourly VPD, hourly rain maximum, and 3-81 cm depth-weighted soil moisture;
5. derives heat/dry persistence and rolling three-day `precipitation - ET0`;
6. parses DWD heat and heavy/persistent-rain warnings by state;
7. validates 614 unique basins and one common two-past/seven-forecast-day window before atomic write.

The public snapshot records generation time, source model, variables, warning issue time, and completeness. GitHub Actions refreshes every three hours. Snapshots are current up to 18 hours, delayed from 18 to 36 hours, and stale after 36 hours. Stale scores remain visible for audit while actions are suppressed.

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
| 3-81 cm root-zone soil-moisture deficit | 38% | 0.36 to 0.12 m3/m3 |
| Three-day `precipitation - ET0` deficit | 28% | 0 to -18 mm |
| Daily FAO ET0 | 12% | 2-7 mm |
| Daily maximum VPD | 12% | 0.8-3.6 kPa |
| Dry persistence | 10% | 0-7 days |

### Excess-water stress

| Component | Weight | 0-100 response range |
| --- | ---: | --- |
| 3-81 cm root-zone soil moisture | 35% | 0.30-0.48 m3/m3 |
| Positive three-day `precipitation - ET0` | 25% | 5-45 mm |
| Daily precipitation | 25% | 10-55 mm |
| Maximum hourly precipitation | 15% | 5-25 mm |

Dry and wet scores remain independent: dry root-zone conditions and short intense rainfall can coexist. The excess-water layer is a waterlogging/runoff screening signal, not a river-flood probability. Absolute soil moisture remains sensitive to soil texture, model bias, rooting depth, drainage, groundwater, irrigation, and crop stage.

### Role-specific impact

| Lens | Composition |
| --- | --- |
| Residents | heat 72%, exposure assumption 13%, dry 7%, excess water 8% |
| Farmers | dry 34%, excess water 28%, heat 20%, crop-sensitivity assumption 18% |
| Municipal | heat 50%, excess water 22%, exposure assumption 18%, dry 5%, heat persistence 5% |

Fixed urban/rural exposure and crop-sensitivity values are explicit placeholders. They prevent the interface from implying that age, health, crop, soil, critical infrastructure, or response-capacity data has already been collected.

## Recommendation policy

Recommendation policy `0.6.0` uses four internal screening bands: Low, Moderate, High, and Very high. These are not DWD warning levels.

Every audience receives a different sequence:

- **Residents** - protective timing, vulnerable-person checks, measured garden watering, standing-water precautions, and official-source checks.
- **Farmers** - representative field measurements, crop-stage and soil verification, dry/wet/heat readiness, and an explicit prohibition on autonomous harvest, irrigation-volume, pesticide, or other irreversible decisions.
- **Municipal teams** - official-source verification, heat-plan readiness, drainage and access checks, public-green-space triage, and a responsible-authority activation gate.

Official warning counts affect the wording and urgency of verification only. They never enter the custom 0-100 score. River flooding must be checked through the responsible state flood service.

## Current limitations

- One ICON grid sample represents each sub-basin; it is not a raster zonal mean or downscaled urban heat field.
- Deterministic output does not provide ensemble probability or spread.
- The soil-moisture response ranges are not local seasonal percentiles.
- Apparent temperature is not UTCI.
- NUTS-3 exposure and crop sensitivity are assumed rather than observed.
- No crop type, phenology, soil hydraulic property, irrigation history, drainage capacity, river routing, gauge state, or local response capacity enters the current score.
- Open-Meteo's free endpoint has rate limits and no service-level guarantee.

## Production roadmap

1. Integrate DWD station and RADOLAN verification, raster zonal statistics, and lead-time bias correction.
2. Calibrate local soil-moisture percentiles against DWD, UFZ, ERA5-Land, SoilGrids/ESDAC, and field observations.
3. Add ICON ensemble features and report calibration, Brier score, false alarms, misses, and useful lead time separately for heat, dry, and wet outcomes.
4. Add governed local exposure data: age, imperviousness, tree cover, care facilities, crop type, phenology, soil, drainage, and response capacity.
5. Connect upstream/downstream topology and official gauges without inferring flood probability from meteorological wetness alone.
6. Compare the interpretable baseline with a HydroBASINS graph model using time- and region-held-out tests.
7. Pilot the decision policy with public-health, agricultural, water, and municipal professionals before stronger recommendations.
