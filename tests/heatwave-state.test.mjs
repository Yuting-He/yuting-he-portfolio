import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VIEW, parseViewState, serializeViewState } from "../heatwave-state.js";

test("shared view state round-trips through URL parameters", () => {
  const source = {
    date: "2026-07-15",
    level: "basin",
    audience: "farmers",
    layer: "drought",
    selectedState: "DE2",
    selectedDistrict: "DE21H",
    selectedBasin: "2080469900"
  };
  assert.deepEqual(parseViewState(`?${serializeViewState(source)}`), source);
});

test("invalid shared state falls back to a safe default view", () => {
  const parsed = parseViewState("?date=2030-01-01&level=postcode&audience=admin&layer=wind&state=BAD&district=DE2");
  assert.deepEqual(parsed, DEFAULT_VIEW);
});
