import { AUDIENCES, FIELD_CONTEXTS, LAYERS, isIsoDate } from "./heatwave-model.js";

const LEVELS = new Set(["state", "district", "basin"]);
const DETAIL_MODES = new Set(["plain", "technical"]);

export const DEFAULT_VIEW = Object.freeze({
  date: null,
  level: "state",
  audience: "residents",
  layer: "impact",
  detail: "plain",
  crop: "dominant",
  stage: "vegetative",
  soil: "local",
  selectedState: "DE2",
  selectedDistrict: null,
  selectedBasin: null
});

function optionalId(params, key, pattern) {
  const value = params.get(key);
  return value && pattern.test(value) ? value : null;
}

export function parseViewState(search = "") {
  const params = new URLSearchParams(search);
  const legacyLayer = params.get("layer");
  const requestedLayer = legacyLayer === "drought" || legacyLayer === "water" ? "dry" : legacyLayer;
  const date = params.get("date");
  const level = params.get("level");
  const audience = params.get("audience");
  const detail = params.get("detail");
  const crop = params.get("crop");
  const stage = params.get("stage");
  const soil = params.get("soil");
  return {
    date: isIsoDate(date) ? date : DEFAULT_VIEW.date,
    level: LEVELS.has(level) ? level : DEFAULT_VIEW.level,
    audience: Object.hasOwn(AUDIENCES, audience) ? audience : DEFAULT_VIEW.audience,
    layer: Object.hasOwn(LAYERS, requestedLayer) ? requestedLayer : DEFAULT_VIEW.layer,
    detail: DETAIL_MODES.has(detail) ? detail : DEFAULT_VIEW.detail,
    crop: Object.hasOwn(FIELD_CONTEXTS.crops, crop) ? crop : DEFAULT_VIEW.crop,
    stage: Object.hasOwn(FIELD_CONTEXTS.stages, stage) ? stage : DEFAULT_VIEW.stage,
    soil: Object.hasOwn(FIELD_CONTEXTS.soils, soil) ? soil : DEFAULT_VIEW.soil,
    selectedState: optionalId(params, "state", /^DE[A-Z0-9]$/) || DEFAULT_VIEW.selectedState,
    selectedDistrict: optionalId(params, "district", /^DE[A-Z0-9]{3}$/),
    selectedBasin: optionalId(params, "basin", /^\d+$/)
  };
}

export function resolveForecastDate(requestedDate, dates, fallbackDate = dates?.[0]) {
  if (!Array.isArray(dates) || !dates.length || !dates.every(isIsoDate)) {
    throw new TypeError("Forecast dates must be a non-empty ISO date array");
  }
  if (dates.includes(requestedDate)) return requestedDate;
  if (!isIsoDate(requestedDate)) return dates.includes(fallbackDate) ? fallbackDate : dates[0];
  const requestedTime = Date.parse(`${requestedDate}T00:00:00Z`);
  return dates.reduce((nearest, date) => {
    const distance = Math.abs(Date.parse(`${date}T00:00:00Z`) - requestedTime);
    const nearestDistance = Math.abs(Date.parse(`${nearest}T00:00:00Z`) - requestedTime);
    return distance < nearestDistance ? date : nearest;
  }, dates[0]);
}

export function runtimeSourceFreshness(sourceFreshness, now = Date.now()) {
  const sources = sourceFreshness?.sources || {};
  const statuses = Object.fromEntries(["radolan", "dwdTemperature", "ufz", "dwdSoil"].map((source) => {
    const policy = sources[source];
    const ageHours = (now - Date.parse(policy?.validAt)) / 3_600_000;
    const current = Number.isFinite(ageHours) &&
      Number.isFinite(policy?.maximumAgeHours) &&
      ageHours >= -2 &&
      ageHours <= policy.maximumAgeHours;
    return [source, {
      ageHours: Number.isFinite(ageHours) ? ageHours : null,
      current,
      maximumAgeHours: policy?.maximumAgeHours ?? null,
      validAt: policy?.validAt ?? null
    }];
  }));
  return {
    sources: statuses,
    staleSources: Object.entries(statuses)
      .filter(([, status]) => !status.current)
      .map(([source]) => source),
    stale: Object.values(statuses).some((status) => !status.current)
  };
}

function berlinIsoDate(timestamp) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(timestamp));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function warningAppliesToDate(warning, date) {
  if (!isIsoDate(date) || !Number.isFinite(Date.parse(warning?.start)) || !Number.isFinite(Date.parse(warning?.end))) {
    return false;
  }
  const inclusiveEnd = new Date(Date.parse(warning.end) - 1).toISOString();
  return berlinIsoDate(warning.start) <= date && berlinIsoDate(inclusiveEnd) >= date;
}

export function isRetrospectiveDate(selectedDate, currentModelDate) {
  if (!isIsoDate(selectedDate) || !isIsoDate(currentModelDate)) {
    throw new TypeError("Retrospective comparison requires ISO dates");
  }
  return selectedDate < currentModelDate;
}

export function serializeViewState(view) {
  const params = new URLSearchParams({
    level: view.level,
    audience: view.audience,
    layer: view.layer,
    detail: view.detail,
    crop: view.crop,
    stage: view.stage,
    soil: view.soil,
    state: view.selectedState
  });
  if (view.date) params.set("date", view.date);
  if (view.selectedDistrict) params.set("district", view.selectedDistrict);
  if (view.selectedBasin) params.set("basin", view.selectedBasin);
  return params.toString();
}
