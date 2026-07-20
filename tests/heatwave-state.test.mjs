import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VIEW, parseViewState, resolveForecastDate, serializeViewState } from "../heatwave-state.js";

test("shared live view state round-trips through URL parameters", () => {
  const source = {
    date: "2026-07-22",
    level: "basin",
    audience: "farmers",
    layer: "water",
    selectedState: "DE2",
    selectedDistrict: "DE21H",
    selectedBasin: "2080469900"
  };
  assert.deepEqual(parseViewState(`?${serializeViewState(source)}`), source);
});

test("legacy drought links migrate to the water-stress layer", () => {
  assert.equal(parseViewState("?layer=drought").layer, "water");
});

test("invalid shared state falls back to a safe default view", () => {
  const parsed = parseViewState("?date=2026-02-30&level=postcode&audience=admin&layer=wind&state=BAD&district=DE2");
  assert.deepEqual(parsed, DEFAULT_VIEW);
});

test("a requested date resolves to the current or nearest available model date", () => {
  const dates = ["2026-07-18", "2026-07-19", "2026-07-20", "2026-07-21"];
  assert.equal(resolveForecastDate(null, dates, "2026-07-20"), "2026-07-20");
  assert.equal(resolveForecastDate("2026-07-21", dates, "2026-07-20"), "2026-07-21");
  assert.equal(resolveForecastDate("2026-07-30", dates, "2026-07-20"), "2026-07-21");
  assert.throws(() => resolveForecastDate(null, []), /non-empty/);
});
