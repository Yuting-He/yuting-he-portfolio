# Third-party notices

HeatLens bundles browser distributions of the following open-source libraries so the map does not depend on a runtime CDN:

- D3 7.9.0, Copyright 2010-2023 Mike Bostock, ISC License: <https://github.com/d3/d3>
- Leaflet 1.9.4, Copyright 2010-2023 Vladimir Agafonkin and Copyright 2010-2011 CloudMade, BSD-2-Clause License: <https://github.com/Leaflet/Leaflet>

The scheduled Node.js ingestion uses:

- h5wasm 0.10.3 for HDF5 / NetCDF4 decoding: <https://www.npmjs.com/package/h5wasm>
- proj4 2.19.10 for source-grid coordinate transformations, MIT License: <https://github.com/proj4js/proj4js>

## Spatial data

Spatial assets are **not** relicensed under the project's MIT License. Their original source terms apply.

- HydroBASINS Level 8 v1c: HydroSHEDS / HydroBASINS license and attribution terms: <https://www.hydrosheds.org/products/hydrobasins>. Citation: Lehner, B. and Grill, G. (2013), *Global river hydrography and network routing: baseline data and new approaches to study the world's large river systems*, Hydrological Processes 27(15), 2171-2186, <https://doi.org/10.1002/hyp.9740>.
- NUTS 2024 1:1M geometry: Source: European Commission, Eurostat (GISCO), NUTS 2024. Dataset files and applicable reuse terms: <https://gisco-services.ec.europa.eu/distribution/v2/nuts/nuts-2024-files.html>.
- OpenStreetMap standard raster tiles and place context: &copy; OpenStreetMap contributors. Copyright and licence: <https://www.openstreetmap.org/copyright>. Tile usage policy: <https://operations.osmfoundation.org/policies/tiles/>.

The processed files, exact-intersection method, source URLs, and checksums are recorded in `assets/spatial-data-manifest.json`.

## Weather and warning data

- Weather forecast data: [Open-Meteo DWD ICON API](https://open-meteo.com/en/docs/dwd-api) and [Ensemble Mean API](https://open-meteo.com/en/docs/ensemble-mean-api), using Deutscher Wetterdienst ICON and ICON-EPS model output. Open-Meteo data is provided under CC BY 4.0 with attribution; free-endpoint usage terms and limits are published at <https://open-meteo.com/en/terms>.
- Official warning context: Deutscher Wetterdienst warning JSONP feed. Source description and reuse guidance: <https://www.dwd.de/DE/wetter/warnungen_aktuell/objekt_einbindung/objekteinbindung.html>.
- Gauge-adjusted rolling 24-hour precipitation: Deutscher Wetterdienst RADOLAN SF HDF5 product: <https://opendata.dwd.de/weather/radar/radolan/sf/> and <https://www.dwd.de/DE/leistungen/radolan/radolan.html>.
- Air-temperature observations and previous-day maxima: Deutscher Wetterdienst POI observations and synoptic station list: <https://opendata.dwd.de/weather/weather_reports/poi/>.
- Crop-specific soil moisture as percent of plant-available field capacity: Deutscher Wetterdienst CDC WCS, AMBAV 2.0 using BGR BÜK1000 soil profiles: <https://cdc.dwd.de/geoserver/CDC/wcs> and <https://www.dwd.de/bodenfeuchteviewer>.
- Soil Moisture Index and plant-available water: UFZ Dürremonitor Deutschland. Attribution: “UFZ-Dürremonitor/ Helmholtz-Zentrum für Umweltforschung”: <https://www.ufz.de/index.php?de=37937&m=0>.

Weather, soil-water, observation, and warning records in `assets/live/forecast.json` retain their source terms and are not relicensed under the project's MIT License. DWD-derived processing changes include centroid sampling, nearest-valid-cell fallback with a recorded distance, depth averaging, and administrative area weighting.

## Linked authority and reference services

The interface links to, but does not copy, these additional authority services:

- DWD 1991-2020 soil-moisture percentile maps: <https://www.dwd.de/DE/leistungen/bofeu_analyse/bfana.html>
- German state flood portals: <https://www.hochwasserzentralen.de/>
