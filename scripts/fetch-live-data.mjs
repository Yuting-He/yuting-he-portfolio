import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DWD_STATION_URLS, fetchDwdTemperatureContext } from "./dwd-stations.mjs";
import { fetchGridContexts, GRID_SOURCE_URLS } from "./grid-sources.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASIN_PATH = resolve(ROOT, "assets/hydrobasins-de-level8.geojson");
const OUTPUT_PATH = resolve(ROOT, "assets/live/forecast.json");
const OPEN_METEO_URL = "https://api.open-meteo.com/v1/dwd-icon";
const OPEN_METEO_ENSEMBLE_URL = "https://ensemble-api.open-meteo.com/v1/ensemble";
const DWD_WARNINGS_URL = "https://www.dwd.de/DWD/warnungen/warnapp/json/warnings.json";
const USER_AGENT = "HeatLensGermany/0.7 (+https://github.com/Yuting-He/yuting-he-portfolio)";
const BATCH_SIZE = Number(process.env.HEATLENS_BATCH_SIZE || 100);
const REQUEST_DELAY_MS = Number(process.env.HEATLENS_REQUEST_DELAY_MS || 11_000);
const CONTEXT_PAST_DAYS = 4;
const DISPLAY_PAST_DAYS = 2;
const FORECAST_DAYS = 7;
export const SOURCE_FRESHNESS_LIMIT_HOURS = Object.freeze({
  radolan: 8,
  dwdTemperature: 8,
  ufz: 96,
  dwdSoil: 96
});
const ENSEMBLE_FIELDS = [
  "temperature_2m",
  "temperature_2m_spread",
  "precipitation",
  "precipitation_spread"
];
const ENSEMBLE_DAILY_FIELDS = ["temperature_2m_max", "precipitation_sum"];
const ENSEMBLE_MODELS = Object.freeze({
  d2: {
    apiName: "dwd_icon_d2_eps_ensemble_mean",
    label: "DWD ICON-D2-EPS",
    members: 20,
    forecastDays: 2
  },
  seamless: {
    apiName: "dwd_icon_eps_ensemble_mean_seamless",
    label: "DWD ICON-EU-EPS / ICON-EPS seamless",
    members: 40,
    forecastDays: FORECAST_DAYS
  }
});

const DAILY_FIELDS = [
  "temperature_2m_max",
  "temperature_2m_min",
  "apparent_temperature_max",
  "precipitation_sum",
  "et0_fao_evapotranspiration"
];
const HOURLY_FIELDS = [
  "vapour_pressure_deficit",
  "precipitation",
  "soil_moisture_3_to_9cm",
  "soil_moisture_9_to_27cm",
  "soil_moisture_27_to_81cm"
];
const SOIL_FIELDS = HOURLY_FIELDS.slice(2);
const SOIL_DEPTH_WEIGHTS = [6, 18, 54];
const STATE_IDS = {
  BW: "DE1", BY: "DE2", BE: "DE3", BB: "DE4", HB: "DE5", HH: "DE6",
  HE: "DE7", MV: "DE8", NI: "DE9", NW: "DEA", RP: "DEB", SL: "DEC",
  SN: "DED", ST: "DEE", SH: "DEF", TH: "DEG"
};

const round = (value, digits = 1) => Number(value.toFixed(digits));
const finite = (value) => Number.isFinite(value);
const sleep = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const average = (values) => {
  const usable = values.filter(finite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
};

function ringAreaAndCentroid(ring) {
  let crossSum = 0;
  let xSum = 0;
  let ySum = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[index + 1];
    const cross = x1 * y2 - x2 * y1;
    crossSum += cross;
    xSum += (x1 + x2) * cross;
    ySum += (y1 + y2) * cross;
  }
  if (Math.abs(crossSum) < 1e-12) {
    return { area: 0, centroid: ring[0] || [10.5, 51.2] };
  }
  return {
    area: Math.abs(crossSum / 2),
    centroid: [xSum / (3 * crossSum), ySum / (3 * crossSum)]
  };
}

export function geometryCentroid(geometry) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const parts = polygons.map((polygon) => ringAreaAndCentroid(polygon[0]));
  const totalArea = parts.reduce((sum, part) => sum + part.area, 0);
  if (!totalArea) return parts[0]?.centroid || [10.5, 51.2];
  return [
    parts.reduce((sum, part) => sum + part.centroid[0] * part.area, 0) / totalArea,
    parts.reduce((sum, part) => sum + part.centroid[1] * part.area, 0) / totalArea
  ];
}

export async function fetchWithRetry(url, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 240);
        const error = new Error(`${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`);
        error.status = response.status;
        error.retryAfter = Number(response.headers.get("retry-after"));
        throw error;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const retryAfterMs = finite(error.retryAfter) && error.retryAfter > 0
          ? error.retryAfter * 1000
          : error.status === 429 ? 65_000 : 0;
        const backoffMs = Math.min(60_000, 1500 * 2 ** (attempt - 1));
        await sleep(Math.max(retryAfterMs, backoffMs));
      }
    }
  }
  throw lastError;
}

function buildForecastUrl(batch) {
  const url = new URL(OPEN_METEO_URL);
  url.searchParams.set("latitude", batch.map((item) => item.latitude.toFixed(5)).join(","));
  url.searchParams.set("longitude", batch.map((item) => item.longitude.toFixed(5)).join(","));
  url.searchParams.set("daily", DAILY_FIELDS.join(","));
  url.searchParams.set("hourly", HOURLY_FIELDS.join(","));
  url.searchParams.set("timezone", "Europe/Berlin");
  url.searchParams.set("past_days", String(CONTEXT_PAST_DAYS));
  url.searchParams.set("forecast_days", String(FORECAST_DAYS));
  return url;
}

function buildEnsembleUrl(batch, model) {
  const url = new URL(OPEN_METEO_ENSEMBLE_URL);
  url.searchParams.set("latitude", batch.map((item) => item.latitude.toFixed(5)).join(","));
  url.searchParams.set("longitude", batch.map((item) => item.longitude.toFixed(5)).join(","));
  url.searchParams.set("models", model.apiName);
  url.searchParams.set("hourly", ENSEMBLE_FIELDS.join(","));
  url.searchParams.set("daily", ENSEMBLE_DAILY_FIELDS.join(","));
  url.searchParams.set("timezone", "Europe/Berlin");
  url.searchParams.set("forecast_days", String(model.forecastDays));
  return url;
}

function rootZoneMoistureAt(response, index) {
  let weighted = 0;
  let weight = 0;
  SOIL_FIELDS.forEach((field, fieldIndex) => {
    const value = response.hourly?.[field]?.[index];
    if (!finite(value)) return;
    weighted += value * SOIL_DEPTH_WEIGHTS[fieldIndex];
    weight += SOIL_DEPTH_WEIGHTS[fieldIndex];
  });
  return weight ? weighted / weight : null;
}

export function summarizeForecastResponse(response, { trimContextDays = 0 } = {}) {
  const hourlyByDate = new Map();
  (response.hourly?.time || []).forEach((time, index) => {
    const date = time.slice(0, 10);
    if (!hourlyByDate.has(date)) hourlyByDate.set(date, { vpd: [], precipitation: [], soil: [] });
    const bucket = hourlyByDate.get(date);
    bucket.vpd.push(response.hourly.vapour_pressure_deficit?.[index]);
    bucket.precipitation.push(response.hourly.precipitation?.[index]);
    bucket.soil.push(rootZoneMoistureAt(response, index));
  });

  const days = (response.daily?.time || []).map((date, index) => {
    const hourly = hourlyByDate.get(date) || { vpd: [], precipitation: [], soil: [] };
    const values = {
      date,
      tmaxC: response.daily.temperature_2m_max?.[index],
      tminC: response.daily.temperature_2m_min?.[index],
      apparentMaxC: response.daily.apparent_temperature_max?.[index],
      precipitationMm: response.daily.precipitation_sum?.[index],
      precipitation1hMaxMm: Math.max(...hourly.precipitation.filter(finite)),
      et0Mm: response.daily.et0_fao_evapotranspiration?.[index],
      vpdMaxKpa: Math.max(...hourly.vpd.filter(finite)),
      soilMoistureM3M3: average(hourly.soil)
    };
    if (!finite(values.vpdMaxKpa)) values.vpdMaxKpa = null;
    if (!finite(values.precipitation1hMaxMm)) values.precipitation1hMaxMm = null;
    const available = Object.entries(values).filter(([key, value]) => key !== "date" && finite(value)).length;
    return {
      date,
      tmaxC: finite(values.tmaxC) ? round(values.tmaxC) : null,
      tminC: finite(values.tminC) ? round(values.tminC) : null,
      apparentMaxC: finite(values.apparentMaxC) ? round(values.apparentMaxC) : null,
      precipitationMm: finite(values.precipitationMm) ? round(values.precipitationMm) : null,
      precipitation1hMaxMm: finite(values.precipitation1hMaxMm) ? round(values.precipitation1hMaxMm) : null,
      et0Mm: finite(values.et0Mm) ? round(values.et0Mm) : null,
      vpdMaxKpa: finite(values.vpdMaxKpa) ? round(values.vpdMaxKpa, 2) : null,
      soilMoistureM3M3: finite(values.soilMoistureM3M3) ? round(values.soilMoistureM3M3, 3) : null,
      completeness: Math.round(available / 8 * 100)
    };
  });

  let heatStreak = 0;
  let dryStreak = 0;
  days.forEach((day, index) => {
    heatStreak = finite(day.tmaxC) && day.tmaxC >= 30 ? heatStreak + 1 : 0;
    dryStreak = finite(day.precipitationMm) && finite(day.et0Mm) && day.precipitationMm < 1 && day.et0Mm > 2
      ? dryStreak + 1
      : 0;
    const balanceWindow = days.slice(Math.max(0, index - 2), index + 1)
      .map((item) => finite(item.precipitationMm) && finite(item.et0Mm) ? item.precipitationMm - item.et0Mm : null)
      .filter(finite);
    day.heatPersistenceDays = heatStreak;
    day.dryPersistenceDays = dryStreak;
    day.waterBalance3dMm = balanceWindow.length ? round(balanceWindow.reduce((sum, value) => sum + value, 0)) : null;
  });
  return days.slice(trimContextDays);
}

export function summarizeEnsembleResponse(response, model) {
  const hourlyByDate = new Map();
  (response.hourly?.time || []).forEach((time, index) => {
    const date = time.slice(0, 10);
    if (!hourlyByDate.has(date)) hourlyByDate.set(date, []);
    hourlyByDate.get(date).push({
      temperatureMeanC: response.hourly.temperature_2m?.[index],
      temperatureSpreadC: response.hourly.temperature_2m_spread?.[index],
      precipitationMeanMm: response.hourly.precipitation?.[index],
      precipitationSpreadMm: response.hourly.precipitation_spread?.[index]
    });
  });
  return (response.daily?.time || []).map((date, index) => {
    const hours = hourlyByDate.get(date) || [];
    const peakTemperatureHour = hours
      .filter((hour) => finite(hour.temperatureMeanC))
      .sort((left, right) => right.temperatureMeanC - left.temperatureMeanC)[0];
    const precipitationSpreads = hours.map((hour) => hour.precipitationSpreadMm).filter(finite);
    const values = {
      ensembleDailyTmaxMeanC: response.daily.temperature_2m_max?.[index],
      ensemblePeakHourTemperatureSdC: peakTemperatureHour?.temperatureSpreadC,
      ensembleDailyPrecipitationMeanMm: response.daily.precipitation_sum?.[index],
      ensembleMaxHourlyPrecipitationSdMm: precipitationSpreads.length ? Math.max(...precipitationSpreads) : null
    };
    const available = Object.values(values).filter(finite).length;
    return {
      date,
      ensembleModel: model.label,
      ensembleMemberCount: model.members,
      ensembleDailyTmaxMeanC: finite(values.ensembleDailyTmaxMeanC) ? round(values.ensembleDailyTmaxMeanC) : null,
      ensemblePeakHourTemperatureSdC: finite(values.ensemblePeakHourTemperatureSdC)
        ? round(values.ensemblePeakHourTemperatureSdC, 2)
        : null,
      ensembleDailyPrecipitationMeanMm: finite(values.ensembleDailyPrecipitationMeanMm)
        ? round(values.ensembleDailyPrecipitationMeanMm)
        : null,
      ensembleMaxHourlyPrecipitationSdMm: finite(values.ensembleMaxHourlyPrecipitationSdMm)
        ? round(values.ensembleMaxHourlyPrecipitationSdMm, 2)
        : null,
      ensembleCompleteness: Math.round(available / 4 * 100)
    };
  });
}

async function fetchForecastBatch(batch) {
  const response = await fetchWithRetry(buildForecastUrl(batch));
  const payload = await response.json();
  const locations = Array.isArray(payload) ? payload : [payload];
  if (locations.length !== batch.length) throw new Error(`Expected ${batch.length} locations, received ${locations.length}`);
  return locations.map((location, index) => ({
    id: batch[index].id,
    latitude: round(location.latitude, 4),
    longitude: round(location.longitude, 4),
    elevationM: finite(location.elevation) ? round(location.elevation, 0) : null,
    days: summarizeForecastResponse(location, { trimContextDays: CONTEXT_PAST_DAYS - DISPLAY_PAST_DAYS })
  }));
}

async function fetchEnsembleBatch(batch, model) {
  const response = await fetchWithRetry(buildEnsembleUrl(batch, model));
  const payload = await response.json();
  const locations = Array.isArray(payload) ? payload : [payload];
  if (locations.length !== batch.length) {
    throw new Error(`Expected ${batch.length} ${model.label} locations, received ${locations.length}`);
  }
  return locations.map((location, index) => ({
    id: batch[index].id,
    days: summarizeEnsembleResponse(location, model)
  }));
}

function mergeEnsembleDays(d2, seamless) {
  const d2ByDate = new Map((d2 || []).map((day) => [day.date, day]));
  const seamlessByDate = new Map((seamless || []).map((day) => [day.date, day]));
  return new Map([...new Set([...d2ByDate.keys(), ...seamlessByDate.keys()])].map((date) => {
    const d2Day = d2ByDate.get(date);
    const seamlessDay = seamlessByDate.get(date);
    const selected = d2Day?.ensembleCompleteness >= 75 ? d2Day : seamlessDay;
    return [date, selected || null];
  }));
}

export function parseDwdWarnings(text) {
  const start = text.indexOf("(");
  const end = text.lastIndexOf(")");
  if (start < 0 || end <= start) throw new Error("Unexpected DWD warning payload");
  const payload = JSON.parse(text.slice(start + 1, end));
  const states = {};
  Object.values(payload.warnings || {}).flat().forEach((warning) => {
    const stateId = STATE_IDS[warning.stateShort];
    if (!stateId) return;
    if (!states[stateId]) {
      states[stateId] = { warningCount: 0, maxLevel: 0, heatWarningCount: 0, rainWarningCount: 0, warnings: [] };
    }
    const target = states[stateId];
    const warningText = `${warning.event || ""} ${warning.headline || ""}`;
    const isHeat = /HITZE/i.test(warningText);
    const isRain = /STARKREGEN|DAUERREGEN|ERGIEBIGER REGEN|NIEDERSCHLAG/i.test(warningText);
    target.warningCount += 1;
    target.maxLevel = Math.max(target.maxLevel, Number(warning.level) || 0);
    if (isHeat) target.heatWarningCount += 1;
    if (isRain) target.rainWarningCount += 1;
    target.warnings.push({
      regionName: warning.regionName,
      event: warning.event,
      headline: warning.headline,
      level: Number(warning.level) || 0,
      start: new Date(warning.start).toISOString(),
      end: new Date(warning.end).toISOString(),
      isHeat,
      isRain
    });
  });
  Object.values(states).forEach((state) => {
    state.warnings.sort((left, right) => right.level - left.level || left.start.localeCompare(right.start));
  });
  return {
    status: "available",
    issuedAt: new Date(payload.time).toISOString(),
    totalWarnings: Object.values(states).reduce((sum, item) => sum + item.warningCount, 0),
    states,
    sourceUrl: DWD_WARNINGS_URL,
    copyright: payload.copyright || "Deutscher Wetterdienst"
  };
}

function ageHours(generatedAt, validAt) {
  return (Date.parse(generatedAt) - Date.parse(validAt)) / 3_600_000;
}

export function sourceFreshnessAt(dataset) {
  const sourceTimes = {
    radolan: dataset.observations?.radolan?.periodEnd,
    dwdTemperature: dataset.observations?.dwdTemperature?.observedAt,
    ufz: dataset.soilMoisture?.ufz?.validAt,
    dwdSoil: dataset.soilMoisture?.dwd?.validAt
  };
  return Object.fromEntries(Object.entries(sourceTimes).map(([source, validAt]) => {
    const sourceAgeHours = ageHours(dataset.generatedAt, validAt);
    return [source, {
      validAt,
      ageHoursAtGeneration: finite(sourceAgeHours) ? round(sourceAgeHours, 1) : null,
      maximumAgeHours: SOURCE_FRESHNESS_LIMIT_HOURS[source],
      current: finite(sourceAgeHours) && sourceAgeHours >= -2 &&
        sourceAgeHours <= SOURCE_FRESHNESS_LIMIT_HOURS[source]
    }];
  }));
}

export function validateLiveDataset(dataset, expectedBasinCount = 614) {
  if (dataset.schema !== "heatlens-live/v3") throw new Error("Unexpected live-data schema");
  const dates = dataset.forecast?.dates;
  if (!Array.isArray(dates) || dates.length !== DISPLAY_PAST_DAYS + FORECAST_DAYS) {
    throw new Error("Unexpected forecast date window");
  }
  if (!Array.isArray(dataset.basins) || dataset.basins.length !== expectedBasinCount) {
    throw new Error(`Expected ${expectedBasinCount} basins`);
  }
  const ids = new Set();
  const sourceCoverage = {
    radolan: 0,
    ufz: 0,
    dwdSoil: 0,
    dwdTemperature: 0
  };
  for (const basin of dataset.basins) {
    if (ids.has(basin.id)) throw new Error(`Duplicate basin ${basin.id}`);
    ids.add(basin.id);
    if (!Array.isArray(basin.days) || basin.days.map((day) => day.date).join() !== dates.join()) {
      throw new Error(`Date window mismatch for basin ${basin.id}`);
    }
    if (finite(basin.context?.radolanPrecipitation24hMm)) sourceCoverage.radolan += 1;
    if ([basin.context?.ufzTopsoilSmi, basin.context?.ufzTotalSmi, basin.context?.ufzPlantAvailableWaterPct].every(finite)) {
      sourceCoverage.ufz += 1;
    }
    if ([basin.context?.dwdNfkDominantPct, basin.context?.dwdNfkGrassPct,
      basin.context?.dwdNfkMaizePct, basin.context?.dwdNfkWinterWheatPct].every(finite)) {
      sourceCoverage.dwdSoil += 1;
    }
    if (finite(basin.context?.dwdLatestTemperatureC) && finite(basin.context?.dwdStationDistanceKm)) {
      sourceCoverage.dwdTemperature += 1;
    }
    for (let index = 0; index < basin.days.length; index += 1) {
      const day = basin.days[index];
      const values = [
        day.tmaxC, day.tminC, day.apparentMaxC, day.precipitationMm, day.precipitation1hMaxMm, day.et0Mm,
        day.vpdMaxKpa, day.soilMoistureM3M3, day.heatPersistenceDays,
        day.dryPersistenceDays, day.waterBalance3dMm, day.completeness
      ];
      if (!values.every(finite) || day.completeness < 85) {
        throw new Error(`Incomplete forecast values for basin ${basin.id} on ${day.date}`);
      }
      if (index >= DISPLAY_PAST_DAYS) {
        const ensembleValues = [
          day.ensembleDailyTmaxMeanC,
          day.ensemblePeakHourTemperatureSdC,
          day.ensembleDailyPrecipitationMeanMm,
          day.ensembleMaxHourlyPrecipitationSdMm,
          day.ensembleMemberCount
        ];
        if (!ensembleValues.every(finite) || day.ensembleCompleteness < 75) {
          throw new Error(`Incomplete ICON ensemble values for basin ${basin.id} on ${day.date}`);
        }
      }
    }
  }
  for (const [source, count] of Object.entries(sourceCoverage)) {
    if (count / expectedBasinCount < 0.9) {
      throw new Error(`${source} covers only ${count} of ${expectedBasinCount} basins`);
    }
  }
  const freshness = sourceFreshnessAt(dataset);
  for (const [source, status] of Object.entries(freshness)) {
    if (!status.current) {
      throw new Error(`${source} source time is outside the ${status.maximumAgeHours}-hour freshness policy`);
    }
  }
  dataset.sourceFreshness = {
    policyVersion: "2026-07",
    sources: freshness
  };
  return dataset;
}

async function fetchDwdWarnings() {
  try {
    const response = await fetchWithRetry(DWD_WARNINGS_URL);
    return parseDwdWarnings(await response.text());
  } catch (error) {
    return {
      status: "unavailable",
      issuedAt: null,
      totalWarnings: null,
      states: {},
      sourceUrl: DWD_WARNINGS_URL,
      error: error.message
    };
  }
}

export async function buildLiveDataset() {
  const collection = JSON.parse(await readFile(BASIN_PATH, "utf8"));
  const basinLocations = collection.features.map((feature) => {
    const [longitude, latitude] = geometryCentroid(feature.geometry);
    return { id: String(feature.properties.HYBAS_ID), latitude, longitude };
  });
  const batches = [];
  for (let index = 0; index < basinLocations.length; index += BATCH_SIZE) {
    batches.push(basinLocations.slice(index, index + BATCH_SIZE));
  }
  const contextPromise = Promise.all([
    fetchGridContexts(basinLocations, fetchWithRetry),
    fetchDwdTemperatureContext(basinLocations, fetchWithRetry),
    fetchDwdWarnings()
  ]);
  const forecastResults = [];
  const d2Results = [];
  const seamlessResults = [];
  for (let index = 0; index < batches.length; index += 1) {
    const [forecast, d2, seamless] = await Promise.all([
      fetchForecastBatch(batches[index]),
      fetchEnsembleBatch(batches[index], ENSEMBLE_MODELS.d2),
      fetchEnsembleBatch(batches[index], ENSEMBLE_MODELS.seamless)
    ]);
    forecastResults.push(forecast);
    d2Results.push(d2);
    seamlessResults.push(seamless);
    if (index < batches.length - 1) await sleep(REQUEST_DELAY_MS);
  }
  const basins = forecastResults.flat();
  const d2ById = new Map(d2Results.flat().map((basin) => [basin.id, basin.days]));
  const seamlessById = new Map(seamlessResults.flat().map((basin) => [basin.id, basin.days]));
  const [gridContexts, temperatureContext, warnings] = await contextPromise;
  const ufzValidDate = gridContexts.ufz.validAt.slice(0, 10);
  const dwdSoilValidDate = gridContexts.dwdSoil.validAt.slice(0, 10);
  const dates = basins[0]?.days.map((day) => day.date) || [];
  if (basins.length !== basinLocations.length || !dates.length) throw new Error("Incomplete forecast dataset");
  if (basins.some((basin) => basin.days.map((day) => day.date).join() !== dates.join())) {
    throw new Error("Forecast date windows differ between basins");
  }
  const contextualBasins = basins.map((basin) => {
    const ufz = gridContexts.ufz.basins.get(basin.id) || {};
    const dwdSoil = gridContexts.dwdSoil.basins.get(basin.id) || {};
    const radolan = gridContexts.radolan.basins.get(basin.id) || {};
    const temperature = temperatureContext.basins.get(basin.id) || {};
    const ensembleByDate = mergeEnsembleDays(d2ById.get(basin.id), seamlessById.get(basin.id));
    return {
      ...basin,
      context: {
        ...ufz,
        ...dwdSoil,
        ...radolan,
        ...temperature
      },
      days: basin.days.map((day) => {
        const ensemble = ensembleByDate.get(day.date);
        const useUfzBaseline = day.date >= ufzValidDate;
        const useDwdSoilBaseline = day.date >= dwdSoilValidDate;
        const useLatestObservations = day.date >= temperature.dwdCurrentDayDate;
        const observedTmaxC = day.date === temperature.dwdPreviousDayDate
          ? temperature.dwdPreviousDayMaxC
          : day.date === temperature.dwdCurrentDayDate
            ? temperature.dwdCurrentDayMaxSoFarC
            : null;
        const datedDwdSoil = Object.fromEntries(
          Object.entries(dwdSoil)
            .filter(([key]) => key.startsWith("dwdNfk"))
            .map(([key, value]) => [key, useDwdSoilBaseline ? value : null])
        );
        return {
          ...day,
          ufzTopsoilSmi: useUfzBaseline ? ufz.ufzTopsoilSmi : null,
          ufzTotalSmi: useUfzBaseline ? ufz.ufzTotalSmi : null,
          ufzPlantAvailableWaterPct: useUfzBaseline ? ufz.ufzPlantAvailableWaterPct : null,
          ufzCellDistanceKm: useUfzBaseline ? ufz.ufzCellDistanceKm : null,
          ...datedDwdSoil,
          dwdSoilCellDistanceKm: useDwdSoilBaseline ? dwdSoil.dwdSoilCellDistanceKm : null,
          radolanPrecipitation24hMm: useLatestObservations ? radolan.radolanPrecipitation24hMm : null,
          dwdLatestTemperatureC: useLatestObservations ? temperature.dwdLatestTemperatureC : null,
          ensembleModel: ensemble?.ensembleModel || null,
          ensembleMemberCount: ensemble?.ensembleMemberCount ?? null,
          ensembleDailyTmaxMeanC: ensemble?.ensembleDailyTmaxMeanC ?? null,
          ensemblePeakHourTemperatureSdC: ensemble?.ensemblePeakHourTemperatureSdC ?? null,
          ensembleDailyPrecipitationMeanMm: ensemble?.ensembleDailyPrecipitationMeanMm ?? null,
          ensembleMaxHourlyPrecipitationSdMm: ensemble?.ensembleMaxHourlyPrecipitationSdMm ?? null,
          ensembleCompleteness: ensemble?.ensembleCompleteness ?? null,
          dwdObservedTmaxC: observedTmaxC,
          dwdObservationKind: day.date === temperature.dwdPreviousDayDate
            ? "complete-day"
            : day.date === temperature.dwdCurrentDayDate ? "day-so-far" : null
        };
      })
    };
  });
  return validateLiveDataset({
    schema: "heatlens-live/v3",
    generatedAt: new Date().toISOString(),
    forecast: {
      provider: "Open-Meteo DWD ICON and Ensemble APIs",
      sourceModel: "DWD ICON seamless + ICON-D2/EU/Global EPS",
      sourceUrl: "https://open-meteo.com/en/docs/dwd-api",
      ensembleSourceUrl: "https://open-meteo.com/en/docs/ensemble-mean-api",
      timezone: "Europe/Berlin",
      dates,
      basinCount: contextualBasins.length,
      pastDays: DISPLAY_PAST_DAYS,
      contextPastDays: CONTEXT_PAST_DAYS,
      forecastDays: FORECAST_DAYS,
      variables: {
        temperature: "2 m daily maximum/minimum (degC)",
        apparentTemperature: "daily maximum (degC)",
        vapourPressureDeficit: "hourly maximum (kPa)",
        soilMoisture: "3-81 cm depth-weighted daily model mean (m3/m3)",
        precipitation: "daily sum and hourly maximum (mm)",
        referenceEvapotranspiration: "FAO ET0 daily sum (mm)",
        ensemble: "ICON-D2-EPS near term, then ICON-EU-EPS / ICON-EPS seamless; daily ensemble means plus hourly member standard deviations"
      }
    },
    observations: {
      radolan: {
        status: gridContexts.radolan.status,
        periodStart: gridContexts.radolan.periodStart,
        periodEnd: gridContexts.radolan.periodEnd,
        resolutionKm: gridContexts.radolan.resolutionKm,
        sourceUrl: GRID_SOURCE_URLS.radolan,
        variable: "gauge-adjusted rolling 24-hour precipitation (mm)"
      },
      dwdTemperature: {
        status: temperatureContext.status,
        observedAt: temperatureContext.observedAt,
        stationCount: temperatureContext.stationCount,
        requestedStationCount: temperatureContext.requestedStationCount,
        sourceUrl: DWD_STATION_URLS.poiIndex,
        variable: "2 m air temperature and previous-day maximum"
      }
    },
    soilMoisture: {
      ufz: {
        status: gridContexts.ufz.status,
        validAt: gridContexts.ufz.validAt,
        resolutionKm: gridContexts.ufz.resolutionKm,
        sourceUrl: "https://www.ufz.de/index.php?de=37937",
        variables: "topsoil SMI, total-soil SMI, and 0-25 cm plant-available water"
      },
      dwd: {
        status: gridContexts.dwdSoil.status,
        validAt: gridContexts.dwdSoil.validAt,
        rootZoneDepthsCm: gridContexts.dwdSoil.rootZoneDepthsCm,
        resolutionKm: gridContexts.dwdSoil.resolutionKm,
        sourceUrl: "https://www.dwd.de/bodenfeuchteviewer",
        wcsUrl: GRID_SOURCE_URLS.dwdSoilWcs,
        variables: "AMBAV 2.0 soil moisture as percent of plant-available field capacity for local BUEK1000 soil and four land-use/crop profiles, averaged to 30/60/90 cm",
        percentileReferencePeriod: "1991-2020",
        percentileReferenceOnly: true
      }
    },
    warnings,
    basins: contextualBasins
  });
}

async function main() {
  const dataset = await buildLiveDataset();
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  const temporaryPath = `${OUTPUT_PATH}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(dataset)}\n`, "utf8");
  await rename(temporaryPath, OUTPUT_PATH);
  console.log(
    `Wrote ${dataset.basins.length} basins x ${dataset.forecast.dates.length} days; ` +
    `RADOLAN ${dataset.observations.radolan.status}; UFZ ${dataset.soilMoisture.ufz.status}; ` +
    `DWD stations ${dataset.observations.dwdTemperature.stationCount}; warnings ${dataset.warnings.status}`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
