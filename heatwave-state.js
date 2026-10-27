import {
  AUDIENCES,
  FARM_GOALS,
  FIELD_CONTEXTS,
  HORTICULTURE_CONTEXTS,
  LAYERS,
  isIsoDate
} from "./heatwave-model.js";

const LEVELS = new Set(["state", "district", "basin"]);
const DETAIL_MODES = new Set(["plain", "technical"]);
const LANGUAGES = new Set(["en", "de"]);

export const DEFAULT_VIEW = Object.freeze({
  language: "en",
  date: null,
  level: "state",
  audience: "residents",
  layer: "impact",
  detail: "plain",
  crop: "dominant",
  stage: "auto",
  soil: "local",
  farmGoal: "overview",
  plant: "seasonalFlowers",
  gardenSetting: "container",
  gardenSoil: "unknown",
  gardenGoal: "overview",
  selectedState: "DE2",
  selectedDistrict: null,
  selectedBasin: null
});

function optionalId(params, key, pattern) {
  const value = params.get(key);
  return value && pattern.test(value) ? value : null;
}

export function parseViewState(search = "", defaultLanguage = DEFAULT_VIEW.language) {
  const params = new URLSearchParams(search);
  const language = params.get("lang");
  const legacyLayer = params.get("layer");
  const requestedLayer = legacyLayer === "drought" || legacyLayer === "water" ? "dry" : legacyLayer;
  const date = params.get("date");
  const level = params.get("level");
  const audience = params.get("audience");
  const detail = params.get("detail");
  const crop = params.get("crop");
  const stage = params.get("stage");
  const soil = params.get("soil");
  const farmGoal = params.get("farmGoal");
  const plant = params.get("plant");
  const gardenSetting = params.get("setting");
  const gardenSoil = params.get("gardenSoil");
  const gardenGoal = params.get("gardenGoal");
  return {
    language: LANGUAGES.has(language)
      ? language
      : LANGUAGES.has(defaultLanguage) ? defaultLanguage : DEFAULT_VIEW.language,
    date: isIsoDate(date) ? date : DEFAULT_VIEW.date,
    level: LEVELS.has(level) ? level : DEFAULT_VIEW.level,
    audience: Object.hasOwn(AUDIENCES, audience) ? audience : DEFAULT_VIEW.audience,
    layer: Object.hasOwn(LAYERS, requestedLayer) ? requestedLayer : DEFAULT_VIEW.layer,
    detail: DETAIL_MODES.has(detail) ? detail : DEFAULT_VIEW.detail,
    crop: Object.hasOwn(FIELD_CONTEXTS.crops, crop) ? crop : DEFAULT_VIEW.crop,
    stage: Object.hasOwn(FIELD_CONTEXTS.stages, stage) ? stage : DEFAULT_VIEW.stage,
    soil: Object.hasOwn(FIELD_CONTEXTS.soils, soil) ? soil : DEFAULT_VIEW.soil,
    farmGoal: Object.hasOwn(FARM_GOALS, farmGoal) ? farmGoal : DEFAULT_VIEW.farmGoal,
    plant: Object.hasOwn(HORTICULTURE_CONTEXTS.plants, plant) ? plant : DEFAULT_VIEW.plant,
    gardenSetting: Object.hasOwn(HORTICULTURE_CONTEXTS.settings, gardenSetting)
      ? gardenSetting : DEFAULT_VIEW.gardenSetting,
    gardenSoil: Object.hasOwn(HORTICULTURE_CONTEXTS.soils, gardenSoil)
      ? gardenSoil : DEFAULT_VIEW.gardenSoil,
    gardenGoal: Object.hasOwn(HORTICULTURE_CONTEXTS.goals, gardenGoal)
      ? gardenGoal : DEFAULT_VIEW.gardenGoal,
    selectedState: optionalId(params, "state", /^DE[A-Z0-9]$/) || DEFAULT_VIEW.selectedState,
    selectedDistrict: optionalId(params, "district", /^DE[A-Z0-9]{3}$/),
    selectedBasin: optionalId(params, "basin", /^\d+$/)
  };
}

// Keep the requested date alongside the date that can actually be displayed.
// This lets shared links and rolling snapshots explain a fallback instead of
// silently showing a different analysis day. Dates are calendar labels in the
// existing Berlin analysis window, so compare them at UTC midnight rather than
// using local day lengths across daylight-saving changes.
export function resolveForecastSelection(requestedDate, dates, fallbackDate = dates?.[0]) {
  if (!Array.isArray(dates) || !dates.length || !dates.every(isIsoDate)) {
    throw new TypeError("Forecast dates must be a non-empty ISO date array");
  }
  const defaultDate = dates.includes(fallbackDate) ? fallbackDate : dates[0];
  if (requestedDate === null || requestedDate === undefined || requestedDate === "") {
    return { date: defaultDate, requestedDate: null, adjusted: false, reason: "default" };
  }
  if (dates.includes(requestedDate)) {
    return { date: requestedDate, requestedDate, adjusted: false, reason: "requested" };
  }
  if (!isIsoDate(requestedDate)) {
    return { date: defaultDate, requestedDate, adjusted: true, reason: "invalid" };
  }
  const requestedTime = Date.parse(`${requestedDate}T00:00:00Z`);
  const date = dates.reduce((nearest, candidate) => {
    const distance = Math.abs(Date.parse(`${candidate}T00:00:00Z`) - requestedTime);
    const nearestDistance = Math.abs(Date.parse(`${nearest}T00:00:00Z`) - requestedTime);
    return distance < nearestDistance ? candidate : nearest;
  }, dates[0]);
  const outsideWindow = requestedDate < dates.reduce((earliest, value) => value < earliest ? value : earliest) ||
    requestedDate > dates.reduce((latest, value) => value > latest ? value : latest);
  return { date, requestedDate, adjusted: true, reason: outsideWindow ? "outside-window" : "missing-date" };
}

export function resolveForecastDate(requestedDate, dates, fallbackDate = dates?.[0]) {
  return resolveForecastSelection(requestedDate, dates, fallbackDate).date;
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
    lang: LANGUAGES.has(view.language) ? view.language : DEFAULT_VIEW.language,
    level: view.level,
    audience: view.audience,
    layer: view.layer,
    detail: view.detail,
    crop: view.crop,
    stage: view.stage,
    soil: view.soil,
    farmGoal: view.farmGoal,
    plant: view.plant,
    setting: view.gardenSetting,
    gardenSoil: view.gardenSoil,
    gardenGoal: view.gardenGoal,
    state: view.selectedState
  });
  if (view.date) params.set("date", view.date);
  if (view.selectedDistrict) params.set("district", view.selectedDistrict);
  if (view.selectedBasin) params.set("basin", view.selectedBasin);
  return params.toString();
}
