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
| [DWD soil-moisture viewer](https://www.dwd.de/bodenfeuchteviewer) | Daily AMBAV soil moisture for crops and depths; WCS values are machine-readable as percent nFK | DWD percentile maps use a separate 1991-2020 reference but are currently published as non-georeferenced PNGs, not a stable numeric API |
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
3. queries ICON-D2-EPS daily means and hourly member standard deviations for the near term, then ICON-EU/Global EPS seamless fields for the remaining horizon;
4. downloads and decodes UFZ topsoil SMI, total-soil SMI, and 0-25 cm plant-available water;
5. downloads DWD AMBAV WCS grids for dominant land use, grass, maize, and winter wheat, then averages 10 cm layers to 30/60/90 cm root zones;
6. decodes the DWD RADOLAN SF HDF5 rolling 24-hour, gauge-adjusted precipitation composite;
7. builds a spatially distributed network of up to 160 DWD POI stations, maps observations to sub-basins with both mean and farthest-match distance retained, and reports area-weighted matched-pair bias and MAE rather than subtracting unmatched regional maxima;
8. retains daily maximum/minimum and apparent temperature, precipitation, FAO ET0, VPD, and model soil moisture;
9. derives heat/dry persistence and rolling three-day `precipitation - ET0`;
10. parses DWD heat and heavy/persistent-rain warnings by state;
11. validates 614 unique basins, observed-source coverage, ensemble coverage, and one common two-past/seven-forecast-day window before atomic write.

The public snapshot records every source's valid time, observation period, resolution, model, variables, station/cell distance, warning issue time, and completeness. Every accepted DWD station must itself be no more than 8 hours old. A refresh fails closed when RADOLAN or the retained DWD station network are more than 8 hours old, or when UFZ or DWD daily soil data are more than 96 hours old. The browser recalculates those limits against the current clock every minute, so a failed refresh suppresses actions as soon as a component expires rather than waiting for the 36-hour snapshot gate. GitHub Actions refreshes every six hours. Snapshots are current up to 18 hours, delayed from 18 to 36 hours, and stale after 36 hours. Stale scores remain visible for audit while actions are suppressed.

UFZ and DWD soil values are dated baselines, not daily forecasts. They are never attached to a retrospective date before their own valid date, which prevents future-information leakage. For the valid date and later forecast dates they initialise the observed water-state context while ICON soil moisture and water balance provide the changing daily forecast. RADOLAN and latest station temperature are similarly withheld from earlier retrospective dates.

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
| Municipal | heat 50%, excess water 22%, exposure assumption 18%, dry 5%, heat persistence 5% |

For the farmer lens, DWD crop-specific nFK contributes 18% of the dry-state result and 12% of the wet-state result only when at least 85% of the selected region's area has a valid crop/depth value. Growth stage selects a 30, 60, or 90 cm root zone and changes crop sensitivity. The local DWD/BÜK profile is the default; sandy, loamy, and clayey choices are explicit scenario adjustments rather than mapped observations.

Urban/rural exposure remains an explicit placeholder. This prevents the interface from implying that age, health, critical infrastructure, or response-capacity data has already been collected.

## Recommendation policy

Recommendation policy `0.7.0` uses four internal screening bands: Low, Moderate, High, and Very high. These are not DWD warning levels.

Every audience receives a different sequence:

- **Residents** - protective timing, vulnerable-person checks, measured garden watering, standing-water precautions, and official-source checks.
- **Farmers** - representative field measurements, crop-stage and soil verification, dry/wet/heat readiness, and an explicit prohibition on autonomous harvest, irrigation-volume, pesticide, or other irreversible decisions.
- **Municipal teams** - official-source verification, heat-plan readiness, drainage and access checks, public-green-space triage, and a responsible-authority activation gate.

Official warning counts affect the wording and urgency of verification only when the warning's Berlin-time start/end interval overlaps the selected date. They never enter the custom 0-100 score. The current feed is not presented as a retrospective archive or a warning forecast for the full horizon. River flooding must be checked through the responsible state flood service.

## Current limitations

- One ICON grid sample represents each sub-basin; it is not a raster zonal mean or downscaled urban heat field.
- ICON daily ensemble means and hourly member standard deviations are available. The temperature value is sampled at the hour with the hottest ensemble mean, and the precipitation value is the largest hourly member standard deviation; neither is a daily Tmax standard deviation, confidence interval, or calibrated exceedance probability.
- UFZ SMI supplies a climatological percentile; DWD's machine-readable field is percent nFK, not the DWD percentile-map class.
- DWD percent nFK may legitimately be negative at the surface or exceed 200%; these values are retained rather than replaced with a neighbouring grid cell.
- Apparent temperature is not UTCI.
- NUTS-3 exposure is assumed rather than observed.
- Crop and growth stage are user-declared scenarios; BÜK1000 is a generalised soil profile, not a field measurement. Irrigation history, drainage capacity, river routing, gauge state, and local response capacity remain absent.
- Open-Meteo's free endpoint has rate limits and no service-level guarantee.

## Production roadmap

1. Replace centroid sampling with raster zonal statistics and build lead-time-stratified DWD/RADOLAN validation histories.
2. Calibrate ICON ensemble exceedance probabilities and report reliability, Brier score, false alarms, misses, and useful lead time separately for heat, dry, and wet outcomes.
3. Add higher-resolution state soil data and governed parcel inputs where licensing and user consent permit.
4. Add governed local exposure data: age, imperviousness, tree cover, care facilities, drainage, and response capacity.
5. Connect upstream/downstream topology and official gauges without inferring flood probability from meteorological wetness alone.
6. Compare the interpretable baseline with a HydroBASINS graph model using time- and region-held-out tests.
7. Pilot the decision policy with public-health, agricultural, water, and municipal professionals before stronger recommendations.
