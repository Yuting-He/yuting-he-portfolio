import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASIN_PATH = resolve(ROOT, "assets/hydrobasins-de-level8.geojson");
const OUTPUT_PATH = resolve(ROOT, "assets/live/forecast.json");
const OPEN_METEO_URL = "https://api.open-meteo.com/v1/dwd-icon";
const DWD_WARNINGS_URL = "https://www.dwd.de/DWD/warnungen/warnapp/json/warnings.json";
const USER_AGENT = "HeatLensGermany/0.5 (+https://github.com/Yuting-He/yuting-he-portfolio)";
const BATCH_SIZE = Number(process.env.HEATLENS_BATCH_SIZE || 100);
const REQUEST_DELAY_MS = Number(process.env.HEATLENS_REQUEST_DELAY_MS || 11_000);
const CONTEXT_PAST_DAYS = 4;
const DISPLAY_PAST_DAYS = 2;
const FORECAST_DAYS = 7;

const DAILY_FIELDS = [
  "temperature_2m_max",
  "temperature_2m_min",
  "apparent_temperature_max",
  "precipitation_sum",
  "et0_fao_evapotranspiration"
];
const HOURLY_FIELDS = [
  "vapour_pressure_deficit",
  "soil_moisture_3_to_9cm",
  "soil_moisture_9_to_27cm",
  "soil_moisture_27_to_81cm"
];
const SOIL_FIELDS = HOURLY_FIELDS.slice(1);
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

async function fetchWithRetry(url, attempts = 5) {
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
    if (!hourlyByDate.has(date)) hourlyByDate.set(date, { vpd: [], soil: [] });
    const bucket = hourlyByDate.get(date);
    bucket.vpd.push(response.hourly.vapour_pressure_deficit?.[index]);
    bucket.soil.push(rootZoneMoistureAt(response, index));
  });

  const days = (response.daily?.time || []).map((date, index) => {
    const hourly = hourlyByDate.get(date) || { vpd: [], soil: [] };
    const values = {
      date,
      tmaxC: response.daily.temperature_2m_max?.[index],
      tminC: response.daily.temperature_2m_min?.[index],
      apparentMaxC: response.daily.apparent_temperature_max?.[index],
      precipitationMm: response.daily.precipitation_sum?.[index],
      et0Mm: response.daily.et0_fao_evapotranspiration?.[index],
      vpdMaxKpa: Math.max(...hourly.vpd.filter(finite)),
      soilMoistureM3M3: average(hourly.soil)
    };
    if (!finite(values.vpdMaxKpa)) values.vpdMaxKpa = null;
    const available = Object.entries(values).filter(([key, value]) => key !== "date" && finite(value)).length;
    return {
      date,
      tmaxC: finite(values.tmaxC) ? round(values.tmaxC) : null,
      tminC: finite(values.tminC) ? round(values.tminC) : null,
      apparentMaxC: finite(values.apparentMaxC) ? round(values.apparentMaxC) : null,
      precipitationMm: finite(values.precipitationMm) ? round(values.precipitationMm) : null,
      et0Mm: finite(values.et0Mm) ? round(values.et0Mm) : null,
      vpdMaxKpa: finite(values.vpdMaxKpa) ? round(values.vpdMaxKpa, 2) : null,
      soilMoistureM3M3: finite(values.soilMoistureM3M3) ? round(values.soilMoistureM3M3, 3) : null,
      completeness: Math.round(available / 7 * 100)
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

export function parseDwdWarnings(text) {
  const start = text.indexOf("(");
  const end = text.lastIndexOf(")");
  if (start < 0 || end <= start) throw new Error("Unexpected DWD warning payload");
  const payload = JSON.parse(text.slice(start + 1, end));
  const states = {};
  Object.values(payload.warnings || {}).flat().forEach((warning) => {
    const stateId = STATE_IDS[warning.stateShort];
    if (!stateId) return;
    if (!states[stateId]) states[stateId] = { warningCount: 0, maxLevel: 0, heatWarningCount: 0, warnings: [] };
    const target = states[stateId];
    const isHeat = /HITZE/i.test(`${warning.event || ""} ${warning.headline || ""}`);
    target.warningCount += 1;
    target.maxLevel = Math.max(target.maxLevel, Number(warning.level) || 0);
    if (isHeat) target.heatWarningCount += 1;
    target.warnings.push({
      regionName: warning.regionName,
      event: warning.event,
      headline: warning.headline,
      level: Number(warning.level) || 0,
      start: new Date(warning.start).toISOString(),
      end: new Date(warning.end).toISOString(),
      isHeat
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

export function validateLiveDataset(dataset, expectedBasinCount = 614) {
  if (dataset.schema !== "heatlens-live/v1") throw new Error("Unexpected live-data schema");
  const dates = dataset.forecast?.dates;
  if (!Array.isArray(dates) || dates.length !== DISPLAY_PAST_DAYS + FORECAST_DAYS) {
    throw new Error("Unexpected forecast date window");
  }
  if (!Array.isArray(dataset.basins) || dataset.basins.length !== expectedBasinCount) {
    throw new Error(`Expected ${expectedBasinCount} basins`);
  }
  const ids = new Set();
  for (const basin of dataset.basins) {
    if (ids.has(basin.id)) throw new Error(`Duplicate basin ${basin.id}`);
    ids.add(basin.id);
    if (!Array.isArray(basin.days) || basin.days.map((day) => day.date).join() !== dates.join()) {
      throw new Error(`Date window mismatch for basin ${basin.id}`);
    }
    for (const day of basin.days) {
      const values = [
        day.tmaxC, day.tminC, day.apparentMaxC, day.precipitationMm, day.et0Mm,
        day.vpdMaxKpa, day.soilMoistureM3M3, day.heatPersistenceDays,
        day.dryPersistenceDays, day.waterBalance3dMm, day.completeness
      ];
      if (!values.every(finite) || day.completeness < 85) {
        throw new Error(`Incomplete forecast values for basin ${basin.id} on ${day.date}`);
      }
    }
  }
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
  const batchResults = [];
  for (let index = 0; index < batches.length; index += 1) {
    batchResults.push(await fetchForecastBatch(batches[index]));
    if (index < batches.length - 1) await sleep(REQUEST_DELAY_MS);
  }
  const basins = batchResults.flat();
  const dates = basins[0]?.days.map((day) => day.date) || [];
  if (basins.length !== basinLocations.length || !dates.length) throw new Error("Incomplete forecast dataset");
  if (basins.some((basin) => basin.days.map((day) => day.date).join() !== dates.join())) {
    throw new Error("Forecast date windows differ between basins");
  }
  return validateLiveDataset({
    schema: "heatlens-live/v1",
    generatedAt: new Date().toISOString(),
    forecast: {
      provider: "Open-Meteo DWD ICON API",
      sourceModel: "DWD ICON seamless",
      sourceUrl: "https://open-meteo.com/en/docs/dwd-api",
      timezone: "Europe/Berlin",
      dates,
      basinCount: basins.length,
      pastDays: DISPLAY_PAST_DAYS,
      contextPastDays: CONTEXT_PAST_DAYS,
      forecastDays: FORECAST_DAYS,
      variables: {
        temperature: "2 m daily maximum/minimum (degC)",
        apparentTemperature: "daily maximum (degC)",
        vapourPressureDeficit: "hourly maximum (kPa)",
        soilMoisture: "3-81 cm depth-weighted daily model mean (m3/m3)",
        precipitation: "daily sum (mm)",
        referenceEvapotranspiration: "FAO ET0 daily sum (mm)"
      }
    },
    warnings: await fetchDwdWarnings(),
    basins
  });
}

async function main() {
  const dataset = await buildLiveDataset();
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  const temporaryPath = `${OUTPUT_PATH}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(dataset)}\n`, "utf8");
  await rename(temporaryPath, OUTPUT_PATH);
  console.log(`Wrote ${dataset.basins.length} basins x ${dataset.forecast.dates.length} days; DWD warnings ${dataset.warnings.status}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
