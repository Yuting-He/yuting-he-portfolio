import { AUDIENCES, LAYERS, isIsoDate } from "./heatwave-model.js";

const LEVELS = new Set(["state", "district", "basin"]);

export const DEFAULT_VIEW = Object.freeze({
  date: null,
  level: "state",
  audience: "residents",
  layer: "impact",
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
  const requestedLayer = params.get("layer") === "drought" ? "water" : params.get("layer");
  const date = params.get("date");
  const level = params.get("level");
  const audience = params.get("audience");
  return {
    date: isIsoDate(date) ? date : DEFAULT_VIEW.date,
    level: LEVELS.has(level) ? level : DEFAULT_VIEW.level,
    audience: Object.hasOwn(AUDIENCES, audience) ? audience : DEFAULT_VIEW.audience,
    layer: Object.hasOwn(LAYERS, requestedLayer) ? requestedLayer : DEFAULT_VIEW.layer,
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

export function serializeViewState(view) {
  const params = new URLSearchParams({
    level: view.level,
    audience: view.audience,
    layer: view.layer,
    state: view.selectedState
  });
  if (view.date) params.set("date", view.date);
  if (view.selectedDistrict) params.set("district", view.selectedDistrict);
  if (view.selectedBasin) params.set("basin", view.selectedBasin);
  return params.toString();
}
