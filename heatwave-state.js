import { ANALYSIS_DATE, AUDIENCES, LAYERS, isScenarioDate } from "./heatwave-model.js";

const LEVELS = new Set(["state", "district", "basin"]);

export const DEFAULT_VIEW = Object.freeze({
  date: ANALYSIS_DATE,
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
  const date = params.get("date");
  const level = params.get("level");
  const audience = params.get("audience");
  const layer = params.get("layer");
  return {
    date: isScenarioDate(date) ? date : DEFAULT_VIEW.date,
    level: LEVELS.has(level) ? level : DEFAULT_VIEW.level,
    audience: Object.hasOwn(AUDIENCES, audience) ? audience : DEFAULT_VIEW.audience,
    layer: Object.hasOwn(LAYERS, layer) ? layer : DEFAULT_VIEW.layer,
    selectedState: optionalId(params, "state", /^DE[A-Z0-9]$/) || DEFAULT_VIEW.selectedState,
    selectedDistrict: optionalId(params, "district", /^DE[A-Z0-9]{3}$/),
    selectedBasin: optionalId(params, "basin", /^\d+$/)
  };
}

export function serializeViewState(view) {
  const params = new URLSearchParams({
    date: view.date,
    level: view.level,
    audience: view.audience,
    layer: view.layer,
    state: view.selectedState
  });
  if (view.selectedDistrict) params.set("district", view.selectedDistrict);
  if (view.selectedBasin) params.set("basin", view.selectedBasin);
  return params.toString();
}
