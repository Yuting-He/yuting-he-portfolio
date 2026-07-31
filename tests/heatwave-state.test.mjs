import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VIEW,
  isRetrospectiveDate,
  parseViewState,
  resolveForecastDate,
  runtimeSourceFreshness,
  serializeViewState,
  warningAppliesToDate
} from "../heatwave-state.js";

test("shared live view state round-trips through URL parameters", () => {
  const source = {
    date: "2026-07-22",
    level: "basin",
    audience: "farmers",
    layer: "dry",
    detail: "technical",
    crop: "maize",
    stage: "flowering",
    soil: "sand",
    selectedState: "DE2",
    selectedDistrict: "DE21H",
    selectedBasin: "2080469900"
  };
  assert.deepEqual(parseViewState(`?${serializeViewState(source)}`), source);
});

test("legacy drought and water links migrate to the dry-stress layer", () => {
  assert.equal(parseViewState("?layer=drought").layer, "dry");
  assert.equal(parseViewState("?layer=water").layer, "dry");
});

test("invalid shared state falls back to a safe default view", () => {
  const parsed = parseViewState("?date=2026-02-30&level=postcode&audience=admin&layer=wind&detail=expert&state=BAD&district=DE2");
  assert.deepEqual(parsed, DEFAULT_VIEW);
});

test("a requested date resolves to the current or nearest available model date", () => {
  const dates = ["2026-07-18", "2026-07-19", "2026-07-20", "2026-07-21"];
  assert.equal(resolveForecastDate(null, dates, "2026-07-20"), "2026-07-20");
  assert.equal(resolveForecastDate("2026-07-21", dates, "2026-07-20"), "2026-07-21");
  assert.equal(resolveForecastDate("2026-07-30", dates, "2026-07-20"), "2026-07-21");
  assert.throws(() => resolveForecastDate(null, []), /non-empty/);
});

test("runtime source freshness expires faster sources before the snapshot age gate", () => {
  const sourceFreshness = {
    sources: {
      radolan: { validAt: "2026-07-29T20:00:00Z", maximumAgeHours: 8 },
      dwdTemperature: { validAt: "2026-07-29T20:00:00Z", maximumAgeHours: 8 },
      ufz: { validAt: "2026-07-27T00:00:00Z", maximumAgeHours: 96 },
      dwdSoil: { validAt: "2026-07-28T00:00:00Z", maximumAgeHours: 96 }
    }
  };
  const current = runtimeSourceFreshness(sourceFreshness, Date.parse("2026-07-30T02:00:00Z"));
  const stale = runtimeSourceFreshness(sourceFreshness, Date.parse("2026-07-30T05:00:00Z"));
  assert.equal(current.stale, false);
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.staleSources, ["radolan", "dwdTemperature"]);
});

test("official warnings apply only to dates inside their Berlin-time validity window", () => {
  const warning = {
    start: "2026-07-30T08:00:00Z",
    end: "2026-07-30T16:00:00Z"
  };
  assert.equal(warningAppliesToDate(warning, "2026-07-29"), false);
  assert.equal(warningAppliesToDate(warning, "2026-07-30"), true);
  assert.equal(warningAppliesToDate(warning, "2026-07-31"), false);
});

test("dates before the current model day are retrospective", () => {
  assert.equal(isRetrospectiveDate("2026-07-29", "2026-07-30"), true);
  assert.equal(isRetrospectiveDate("2026-07-30", "2026-07-30"), false);
  assert.equal(isRetrospectiveDate("2026-07-31", "2026-07-30"), false);
  assert.throws(() => isRetrospectiveDate("30-07-2026", "2026-07-30"), /ISO dates/);
});
