export const ANALYSIS_DATE = "2026-07-11";
export const MIN_DATE = "2026-07-08";
export const MAX_DATE = "2026-07-17";
export const MODEL_VERSION = "0.3.0-scenario";
export const SCENARIO_GENERATED_AT = "2026-07-11T06:00:00Z";

export const AUDIENCES = {
  residents: "Residents",
  farmers: "Farmers",
  municipal: "Municipal"
};

export const LAYERS = {
  impact: "Impact risk",
  heat: "Heat stress",
  drought: "Drought stress"
};

const DAY_MS = 86_400_000;
const HEAT_CURVE = [-6, -3, 0, 4, 8, 12, 10, 7, 2, -3];
const PREDICTION_FIELDS = [
  "area", "tmaxProxy", "tminProxy", "utciProxy", "soilWaterProxy", "spi3Proxy",
  "vpdProxy", "etDeficitProxy", "flowProxy", "faparProxy", "persistenceProxy",
  "consistencyProxy", "heatScore", "droughtScore"
];

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const round = (value, digits = 0) => Number(value.toFixed(digits));
const normalized = (value, min, max) => clamp((value - min) / (max - min), 0, 1) * 100;

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < String(value).length; index += 1) {
    hash ^= String(value).charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function gaussian(lon, lat, centerLon, centerLat, width) {
  const distanceSquared = (lon - centerLon) ** 2 + (lat - centerLat) ** 2;
  return Math.exp(-distanceSquared / (2 * width ** 2));
}

export function dateOffset(date) {
  if (!isScenarioDate(date)) throw new RangeError(`Date must be between ${MIN_DATE} and ${MAX_DATE}`);
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${ANALYSIS_DATE}T00:00:00Z`)) / DAY_MS);
}

export function isScenarioDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(date)) && date >= MIN_DATE && date <= MAX_DATE;
}

export function dateRange() {
  const dates = [];
  for (let time = Date.parse(`${MIN_DATE}T00:00:00Z`); time <= Date.parse(`${MAX_DATE}T00:00:00Z`); time += DAY_MS) {
    dates.push(new Date(time).toISOString().slice(0, 10));
  }
  return dates;
}

export function dataStatus(date) {
  const offset = dateOffset(date);
  if (offset < 0) return `Static scenario -${Math.abs(offset)}d`;
  if (offset === 0) return "Static scenario baseline";
  return `Static scenario +${offset}d`;
}

export function buildBasinPrediction(basin, date) {
  const offset = dateOffset(date);
  const curveIndex = clamp(offset + 3, 0, HEAT_CURVE.length - 1);
  const dateHeat = HEAT_CURVE[curveIndex];
  const id = basin.id ?? basin.properties?.HYBAS_ID ?? "basin";
  const [lon, lat] = basin.centroid;
  if (![lon, lat].every(Number.isFinite)) throw new TypeError("Basin centroid must contain finite longitude and latitude");
  const fingerprint = (hashString(id) % 10_000) / 10_000;
  const localNoise = (fingerprint - 0.5) * 5;
  const southernHeat = clamp((52.2 - lat) * 1.6, -3, 8);
  const easternDryness = clamp((lon - 9.2) * 1.9, -4, 10);
  const rhineHeat = gaussian(lon, lat, 8.7, 49.6, 1.7) * 5.5;
  const berlinHeat = gaussian(lon, lat, 13.4, 52.5, 1.3) * 5;
  const baselineDryness = 14 + easternDryness * 1.2 + rhineHeat * 0.8 + localNoise;

  const tmax = clamp(29 + southernHeat + rhineHeat + berlinHeat + dateHeat * 0.58 + localNoise * 0.55, 23, 43);
  const tmin = clamp(16 + southernHeat * 0.55 + berlinHeat * 0.65 + dateHeat * 0.32 + localNoise * 0.25, 12, 29);
  const utci = clamp(tmax + 1.8 + Math.max(0, 2.4 - Math.abs(lon - 10.5) * 0.2), 24, 46);
  const soilPercentile = clamp(58 - baselineDryness - Math.max(0, offset) * 1.8 - Math.max(0, dateHeat) * 0.45, 3, 88);
  const spi3 = clamp((soilPercentile - 48) / 21 + localNoise * 0.035, -2.6, 1.8);
  const vpd = clamp(1.1 + Math.max(0, tmax - 27) * 0.13 + (100 - soilPercentile) * 0.006, 0.8, 4.1);
  const etDeficit = clamp(8 + (100 - soilPercentile) * 0.24 + Math.max(0, tmax - 29) * 1.25, 8, 56);
  const flowPercentile = clamp(soilPercentile * 0.7 + 8 + localNoise, 2, 92);
  const faparAnomaly = clamp(-(100 - soilPercentile) * 0.16 - Math.max(0, offset) * 0.7, -20, 2);
  const persistence = clamp(3 + Math.max(0, offset + 1), 2, 8);
  const consistency = clamp(91 - Math.max(0, offset) * 4.2 - Math.abs(localNoise) * 0.8, 58, 93);

  const heatScore = clamp(
    0.32 * normalized(tmax, 28, 40) +
    0.28 * normalized(utci, 30, 44) +
    0.18 * normalized(tmin, 17, 27) +
    0.14 * normalized(persistence, 2, 8) +
    0.08 * normalized(vpd, 1, 3.6),
    0,
    100
  );
  const droughtScore = clamp(
    0.30 * (100 - soilPercentile) +
    0.18 * normalized(-spi3, 0, 2.2) +
    0.20 * normalized(etDeficit, 12, 50) +
    0.12 * (100 - flowPercentile) +
    0.12 * normalized(-faparAnomaly, 0, 18) +
    0.08 * normalized(vpd, 1, 3.6),
    0,
    100
  );

  return {
    id: String(id),
    date,
    area: Math.max(Number(basin.properties?.SUB_AREA) || 1, 0.001),
    centroid: basin.centroid,
    tmaxProxy: round(tmax, 1),
    tminProxy: round(tmin, 1),
    utciProxy: round(utci, 1),
    soilWaterProxy: round(soilPercentile),
    spi3Proxy: round(spi3, 2),
    vpdProxy: round(vpd, 1),
    etDeficitProxy: round(etDeficit, 1),
    flowProxy: round(flowPercentile),
    faparProxy: round(faparAnomaly, 1),
    persistenceProxy: round(persistence),
    consistencyProxy: round(consistency),
    heatScore: round(heatScore),
    droughtScore: round(droughtScore)
  };
}

function weightedAverage(predictions, key) {
  const totalWeight = predictions.reduce((sum, prediction) => sum + prediction.area, 0) || 1;
  return predictions.reduce((sum, prediction) => sum + prediction[key] * prediction.area, 0) / totalWeight;
}

export function aggregatePredictions(predictions, { audience = "residents", exposure = 50, cropSensitivity = 55 } = {}) {
  if (!predictions.length) throw new Error("At least one basin prediction is required");
  if (!Object.hasOwn(AUDIENCES, audience)) throw new RangeError(`Unknown audience: ${audience}`);
  const dates = new Set(predictions.map((prediction) => prediction.date));
  if (dates.size !== 1) throw new Error("Basin predictions must share one scenario date");
  if (predictions.some((prediction) => PREDICTION_FIELDS.some((key) => !Number.isFinite(prediction[key])) || prediction.area <= 0)) {
    throw new TypeError("Basin predictions must contain finite proxy values and positive overlap weights");
  }
  const metrics = {
    basinCount: new Set(predictions.map((item) => item.id)).size,
    coverageAreaKm2: round(predictions.reduce((sum, item) => sum + item.area, 0), 1),
    tmaxProxy: round(Math.max(...predictions.map((item) => item.tmaxProxy)), 1),
    tminProxy: round(weightedAverage(predictions, "tminProxy"), 1),
    utciProxy: round(Math.max(...predictions.map((item) => item.utciProxy)), 1),
    soilWaterProxy: round(weightedAverage(predictions, "soilWaterProxy")),
    spi3Proxy: round(weightedAverage(predictions, "spi3Proxy"), 2),
    vpdProxy: round(weightedAverage(predictions, "vpdProxy"), 1),
    etDeficitProxy: round(weightedAverage(predictions, "etDeficitProxy"), 1),
    flowProxy: round(weightedAverage(predictions, "flowProxy")),
    faparProxy: round(weightedAverage(predictions, "faparProxy"), 1),
    persistenceProxy: round(weightedAverage(predictions, "persistenceProxy")),
    consistencyProxy: round(weightedAverage(predictions, "consistencyProxy")),
    heatScore: round(weightedAverage(predictions, "heatScore")),
    droughtScore: round(weightedAverage(predictions, "droughtScore")),
    exposure: round(exposure),
    cropSensitivity: round(cropSensitivity)
  };

  const audienceScores = {
    residents: 0.72 * metrics.heatScore + 0.20 * metrics.exposure + 0.08 * metrics.droughtScore,
    farmers: 0.62 * metrics.droughtScore + 0.26 * metrics.heatScore + 0.12 * metrics.cropSensitivity,
    municipal: 0.55 * metrics.heatScore + 0.22 * metrics.exposure + 0.15 * metrics.droughtScore + 0.08 * normalized(metrics.persistenceProxy, 2, 8)
  };
  metrics.impactScore = round(clamp(audienceScores[audience], 0, 100));
  return metrics;
}

export function scoreForLayer(metrics, layer) {
  if (layer === "heat") return metrics.heatScore;
  if (layer === "drought") return metrics.droughtScore;
  if (layer === "impact") return metrics.impactScore;
  throw new RangeError(`Unknown risk layer: ${layer}`);
}

export function severity(score) {
  if (!Number.isFinite(score)) return { label: "Unavailable", className: "unavailable" };
  if (score >= 85) return { label: "Extreme", className: "extreme" };
  if (score >= 70) return { label: "Severe", className: "severe" };
  if (score >= 50) return { label: "Elevated", className: "elevated" };
  return { label: "Watch", className: "watch" };
}

export function fillColor(score) {
  if (!Number.isFinite(score)) return "#9aa7ac";
  if (score >= 85) return "#a83b35";
  if (score >= 70) return "#d56a2d";
  if (score >= 50) return "#d5ab3a";
  return "#6f9f99";
}

export function actionsFor(metrics, audience) {
  const heatWindow = metrics.utciProxy >= 39 ? "11:00-18:00" : "12:00-17:00";
  if (audience === "farmers") {
    return {
      actions: [
        "Evidence check: inspect root-zone moisture and canopy condition, then compare them with a nearby station and the official forecast.",
        "Context check: confirm crop stage, soil water-holding capacity, irrigation allocation, and recent rainfall before planning any response.",
        "Decision gate: do not change harvest timing, irrigation volume, or other costly action from this scenario alone; require agronomic confirmation."
      ],
      note: "Farm prompts are low-regret scenario guidance only. Field evidence, official forecasts, water rules, and an agronomic professional must confirm irreversible action."
    };
  }
  if (audience === "municipal") {
    return {
      actions: [
        "Readiness check: review cool-space, drinking-water, care-facility, and outreach capacity for heat-exposed groups.",
        `Workforce check: compare the ${heatWindow} scenario window with official DWD warnings and the responsible occupational-safety plan.`,
        "Escalation gate: the responsible authority must verify DWD or BBK warnings, local observations, staffing, and the municipal heat plan before activation."
      ],
      note: "Municipal prompts support preparedness; formal activation remains with the responsible authority and official DWD or BBK warning channels."
    };
  }
  return {
    actions: [
      `Avoid strenuous outdoor activity during ${heatWindow}; choose the cooler morning or evening period.`,
      "Check on heat-exposed neighbours and identify a cool indoor option before the daily peak.",
      "Check the soil before watering sensitive plants; water early only when the local soil is dry and restrictions allow it."
    ],
    note: "Resident guidance is limited to low-regret actions. This static scenario does not replace official DWD and local health warnings."
  };
}
