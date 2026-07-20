export const MODEL_VERSION = "0.5.0-live";

export const AUDIENCES = {
  residents: "Residents",
  farmers: "Farmers",
  municipal: "Municipal"
};

export const LAYERS = {
  impact: "Impact screening",
  heat: "Heat stress",
  water: "Water stress"
};

const PREDICTION_FIELDS = [
  "area", "tmaxC", "tminC", "apparentMaxC", "precipitationMm", "et0Mm",
  "vpdMaxKpa", "soilMoistureM3M3", "waterBalance3dMm", "heatPersistenceDays",
  "dryPersistenceDays", "completeness", "heatScore", "waterStressScore"
];

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const round = (value, digits = 0) => Number(value.toFixed(digits));
const normalized = (value, min, max) => clamp((value - min) / (max - min), 0, 1) * 100;
const reverseNormalized = (value, wet, dry) => normalized(wet - value, 0, wet - dry);

export function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function freshnessStatus(generatedAt, now = Date.now()) {
  const generated = Date.parse(generatedAt);
  if (!Number.isFinite(generated)) {
    return { label: "Unavailable", className: "unavailable", ageHours: null, stale: true };
  }
  const ageHours = Math.max(0, (now - generated) / 3_600_000);
  if (ageHours <= 18) return { label: "Current", className: "current", ageHours, stale: false };
  if (ageHours <= 36) return { label: "Delayed", className: "delayed", ageHours, stale: false };
  return { label: "Stale", className: "stale", ageHours, stale: true };
}

export function buildLiveBasinPrediction(basin, day) {
  const id = String(basin.id ?? basin.properties?.HYBAS_ID ?? "");
  const inputs = [
    day?.tmaxC, day?.tminC, day?.apparentMaxC, day?.precipitationMm, day?.et0Mm,
    day?.vpdMaxKpa, day?.soilMoistureM3M3, day?.waterBalance3dMm,
    day?.heatPersistenceDays, day?.dryPersistenceDays, day?.completeness
  ];
  if (!id || !isIsoDate(day?.date) || !inputs.every(Number.isFinite)) {
    throw new TypeError("Live basin prediction requires a basin id, ISO date, and finite source values");
  }

  const heatScore = clamp(
    0.34 * normalized(day.tmaxC, 25, 40) +
    0.30 * normalized(day.apparentMaxC, 26, 42) +
    0.18 * normalized(day.tminC, 16, 26) +
    0.10 * normalized(day.heatPersistenceDays, 0, 4) +
    0.08 * normalized(day.vpdMaxKpa, 0.8, 3.6),
    0,
    100
  );
  const waterStressScore = clamp(
    0.38 * reverseNormalized(day.soilMoistureM3M3, 0.36, 0.12) +
    0.28 * normalized(-day.waterBalance3dMm, 0, 18) +
    0.12 * normalized(day.et0Mm, 2, 7) +
    0.12 * normalized(day.vpdMaxKpa, 0.8, 3.6) +
    0.10 * normalized(day.dryPersistenceDays, 0, 7),
    0,
    100
  );

  return {
    id,
    date: day.date,
    area: Math.max(Number(basin.properties?.SUB_AREA) || Number(basin.area) || 1, 0.001),
    tmaxC: round(day.tmaxC, 1),
    tminC: round(day.tminC, 1),
    apparentMaxC: round(day.apparentMaxC, 1),
    precipitationMm: round(day.precipitationMm, 1),
    et0Mm: round(day.et0Mm, 1),
    vpdMaxKpa: round(day.vpdMaxKpa, 2),
    soilMoistureM3M3: round(day.soilMoistureM3M3, 3),
    waterBalance3dMm: round(day.waterBalance3dMm, 1),
    heatPersistenceDays: round(day.heatPersistenceDays),
    dryPersistenceDays: round(day.dryPersistenceDays),
    completeness: round(day.completeness),
    heatScore: round(heatScore),
    waterStressScore: round(waterStressScore)
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
  if (dates.size !== 1) throw new Error("Basin predictions must share one forecast date");
  if (predictions.some((prediction) => PREDICTION_FIELDS.some((key) => !Number.isFinite(prediction[key])) || prediction.area <= 0)) {
    throw new TypeError("Basin predictions must contain finite live values and positive overlap weights");
  }

  const metrics = {
    basinCount: new Set(predictions.map((item) => item.id)).size,
    coverageAreaKm2: round(predictions.reduce((sum, item) => sum + item.area, 0), 1),
    tmaxC: round(Math.max(...predictions.map((item) => item.tmaxC)), 1),
    tminC: round(weightedAverage(predictions, "tminC"), 1),
    apparentMaxC: round(Math.max(...predictions.map((item) => item.apparentMaxC)), 1),
    precipitationMm: round(weightedAverage(predictions, "precipitationMm"), 1),
    et0Mm: round(weightedAverage(predictions, "et0Mm"), 1),
    vpdMaxKpa: round(weightedAverage(predictions, "vpdMaxKpa"), 2),
    soilMoistureM3M3: round(weightedAverage(predictions, "soilMoistureM3M3"), 3),
    waterBalance3dMm: round(weightedAverage(predictions, "waterBalance3dMm"), 1),
    heatPersistenceDays: round(Math.max(...predictions.map((item) => item.heatPersistenceDays))),
    dryPersistenceDays: round(weightedAverage(predictions, "dryPersistenceDays")),
    completeness: round(weightedAverage(predictions, "completeness")),
    heatScore: round(weightedAverage(predictions, "heatScore")),
    waterStressScore: round(weightedAverage(predictions, "waterStressScore")),
    exposure: round(clamp(exposure, 0, 100)),
    cropSensitivity: round(clamp(cropSensitivity, 0, 100))
  };

  const audienceScores = {
    residents: 0.78 * metrics.heatScore + 0.15 * metrics.exposure + 0.07 * metrics.waterStressScore,
    farmers: 0.55 * metrics.waterStressScore + 0.30 * metrics.heatScore + 0.15 * metrics.cropSensitivity,
    municipal: 0.66 * metrics.heatScore + 0.22 * metrics.exposure + 0.07 * metrics.waterStressScore +
      0.05 * normalized(metrics.heatPersistenceDays, 0, 4)
  };
  metrics.impactScore = round(clamp(audienceScores[audience], 0, 100));
  return metrics;
}

export function scoreForLayer(metrics, layer) {
  if (layer === "heat") return metrics.heatScore;
  if (layer === "water") return metrics.waterStressScore;
  if (layer === "impact") return metrics.impactScore;
  throw new RangeError(`Unknown risk layer: ${layer}`);
}

export function severity(score) {
  if (!Number.isFinite(score)) return { label: "Unavailable", className: "unavailable" };
  if (score >= 75) return { label: "Very high", className: "extreme" };
  if (score >= 55) return { label: "High", className: "severe" };
  if (score >= 35) return { label: "Moderate", className: "elevated" };
  return { label: "Low", className: "watch" };
}

export function fillColor(score) {
  if (!Number.isFinite(score)) return "#9aa7ac";
  if (score >= 75) return "#a83b35";
  if (score >= 55) return "#d56a2d";
  if (score >= 35) return "#d5ab3a";
  return "#6f9f99";
}

export function actionsFor(metrics, audience) {
  const peakWindow = metrics.apparentMaxC >= 32 ? "11:00-18:00" : "12:00-17:00";
  if (audience === "farmers") {
    return {
      actions: [
        "Compare the model root-zone moisture and three-day water balance with a field probe, nearby station, and recent rainfall.",
        "Review crop stage, soil water-holding capacity, irrigation allocation, and a locally calibrated trigger before changing irrigation.",
        "Do not change harvest timing or make another costly irreversible decision from this screening index alone; obtain agronomic confirmation."
      ],
      note: "Farm outputs are monitoring prompts, not irrigation or harvest instructions. Local measurements, official forecasts, water rules, and an agronomic professional remain decisive."
    };
  }
  if (audience === "municipal") {
    return {
      actions: [
        "Compare the custom heat index with the active DWD warning feed and the municipal heat-action plan.",
        `Review cool-space, drinking-water, care-facility, outreach, and outdoor-work readiness for the ${peakWindow} modelled peak window.`,
        "Let the responsible authority verify observations, staffing, vulnerable-group exposure, and official DWD or BBK alerts before activation."
      ],
      note: "HeatLens supports preparedness only. Formal warning and response activation remains with DWD, BBK, and the responsible local authority."
    };
  }
  const outdoorAction = metrics.heatScore >= 55
    ? `Move strenuous outdoor activity outside ${peakWindow}, seek shade or a cool indoor place, and drink regularly.`
    : `Use the cooler morning or evening for strenuous activity when possible and check official advice before the ${peakWindow} peak.`;
  const plantAction = metrics.waterStressScore >= 55
    ? "Check soil moisture before watering sensitive plants; water early or late only where needed and where restrictions allow it."
    : "Check the soil before watering plants; avoid routine extra watering when the root zone is still moist.";
  return {
    actions: [
      outdoorAction,
      "Check on heat-sensitive neighbours and keep an accessible cool indoor option in mind.",
      plantAction
    ],
    note: "Resident guidance is limited to low-regret actions. Use official DWD and local health warnings for protective decisions."
  };
}
