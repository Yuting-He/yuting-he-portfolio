import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VIEW,
  isRetrospectiveDate,
  parseViewState,
  resolveForecastDate,
  resolveForecastSelection,
  runtimeSourceFreshness,
  serializeViewState,
  warningAppliesToDate
} from "../heatwave-state.js";

test("shared live view state round-trips through URL parameters", () => {
  const source = {
    language: "de",
    date: "2026-07-22",
    level: "basin",
    audience: "farmers",
    layer: "dry",
    detail: "technical",
    crop: "maize",
    stage: "flowering",
    soil: "sand",
    farmGoal: "irrigation",
    plant: "newlyPlantedWoody",
    gardenSetting: "openGround",
    gardenSoil: "moistureRetentive",
    gardenGoal: "watering",
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

test("language state accepts English or German and supports a browser default", () => {
  assert.equal(parseViewState("?lang=de").language, "de");
  assert.equal(parseViewState("?lang=en", "de").language, "en");
  assert.equal(parseViewState("", "de").language, "de");
  assert.equal(parseViewState("?lang=fr", "fr").language, "en");
});

test("a requested date resolves to the current or nearest available model date", () => {
  const dates = ["2026-07-18", "2026-07-19", "2026-07-20", "2026-07-21"];
  assert.equal(resolveForecastDate(null, dates, "2026-07-20"), "2026-07-20");
  assert.equal(resolveForecastDate("2026-07-21", dates, "2026-07-20"), "2026-07-21");
  assert.equal(resolveForecastDate("2026-07-30", dates, "2026-07-20"), "2026-07-21");
  assert.throws(() => resolveForecastDate(null, []), /non-empty/);
});

test("date selection distinguishes a default, a valid request and an invalid shared date", () => {
  const dates = ["2026-10-25", "2026-10-26", "2026-10-27"];
  for (const requested of [undefined, null, ""]) {
    assert.deepEqual(resolveForecastSelection(requested, dates, "2026-10-26"), {
      date: "2026-10-26", requestedDate: null, adjusted: false, reason: "default"
    });
  }
  assert.deepEqual(resolveForecastSelection("2026-10-27", dates, "2026-10-26"), {
    date: "2026-10-27", requestedDate: "2026-10-27", adjusted: false, reason: "requested"
  });
  for (const requestedDate of ["2026-02-30", "27.10.2026", "2026-10-27T00:00:00Z", " 2026-10-27"]) {
    assert.deepEqual(resolveForecastSelection(requestedDate, dates, "2026-10-26"), {
      date: "2026-10-26", requestedDate, adjusted: true, reason: "invalid"
    });
  }
  assert.equal(resolveForecastSelection(null, dates, "2026-10-30").date, dates[0]);
});

test("expired and future shared dates retain the requested date and explain the window fallback", () => {
  const dates = ["2026-10-25", "2026-10-26", "2026-10-27"];
  for (const [requestedDate, expectedDate] of [["2026-10-22", dates[0]], ["2026-11-01", dates[2]]]) {
    assert.deepEqual(resolveForecastSelection(requestedDate, dates, "2026-10-26"), {
      date: expectedDate, requestedDate, adjusted: true, reason: "outside-window"
    });
    assert.equal(resolveForecastDate(requestedDate, dates, "2026-10-26"), expectedDate);
  }
});

test("date selection handles gaps and daylight-saving boundaries as calendar dates", () => {
  // Germany changes to winter time on 25 October 2026. Calendar distance is
  // unchanged by the 25-hour local day; ties retain the first supplied day.
  const autumnDates = ["2026-10-24", "2026-10-26"];
  assert.deepEqual(resolveForecastSelection("2026-10-25", autumnDates, "2026-10-26"), {
    date: "2026-10-24", requestedDate: "2026-10-25", adjusted: true, reason: "missing-date"
  });
  assert.equal(resolveForecastSelection("2026-03-29", ["2026-03-28", "2026-03-30"]).date, "2026-03-28");
  // The helper also accepts an unsorted set from an independently loaded shard.
  const unsorted = ["2026-10-27", "2026-10-23", "2026-10-26"];
  assert.equal(resolveForecastSelection("2026-10-24", unsorted).reason, "missing-date");
  assert.equal(resolveForecastSelection("2026-10-24", unsorted).date, "2026-10-23");
  assert.equal(resolveForecastSelection("2026-10-22", unsorted).reason, "outside-window");
  for (const candidates of [[], ["2026-10-25", "invalid"], ["2026-02-30"], null]) {
    assert.throws(() => resolveForecastSelection("2026-10-25", candidates), /non-empty ISO date array/);
  }
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
