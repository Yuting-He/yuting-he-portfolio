import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  geometryCentroid,
  parseDwdWarnings,
  summarizeForecastResponse,
  validateLiveDataset
} from "../scripts/fetch-live-data.mjs";
import { aggregatePredictions, buildLiveBasinPrediction } from "../heatwave-model.js";

const snapshot = JSON.parse(await readFile(new URL("../assets/live/forecast.json", import.meta.url), "utf8"));
const crosswalk = JSON.parse(await readFile(new URL("../assets/basin-nuts3-crosswalk.json", import.meta.url), "utf8"));

test("published live snapshot covers every basin and nine analysis dates", () => {
  assert.equal(validateLiveDataset(snapshot), snapshot);
  assert.equal(snapshot.forecast.basinCount, 614);
  assert.equal(snapshot.forecast.pastDays, 2);
  assert.equal(snapshot.forecast.contextPastDays, 4);
  assert.equal(snapshot.forecast.forecastDays, 7);
  assert.equal(snapshot.forecast.dates.length, 9);
  assert.equal(new Set(snapshot.basins.map((basin) => basin.id)).size, 614);
  assert.ok(Number.isFinite(Date.parse(snapshot.generatedAt)));
});

test("published weather values stay within broad physical guardrails", () => {
  for (const basin of snapshot.basins) {
    for (const day of basin.days) {
      assert.ok(day.tmaxC >= -60 && day.tmaxC <= 60);
      assert.ok(day.tminC >= -70 && day.tminC <= 50);
      assert.ok(day.apparentMaxC >= -70 && day.apparentMaxC <= 70);
      assert.ok(day.precipitationMm >= 0 && day.precipitationMm <= 500);
      assert.ok(day.et0Mm >= 0 && day.et0Mm <= 20);
      assert.ok(day.vpdMaxKpa >= 0 && day.vpdMaxKpa <= 12);
      assert.ok(day.soilMoistureM3M3 >= 0 && day.soilMoistureM3M3 <= 0.8);
      assert.ok(day.completeness >= 85);
    }
  }
});

test("every district and state aggregates to finite live scores on every date", () => {
  const recordsByDistrict = new Map();
  const recordsByState = new Map();
  for (const record of crosswalk) {
    const stateId = record.NUTS_ID.slice(0, 3);
    if (!recordsByDistrict.has(record.NUTS_ID)) recordsByDistrict.set(record.NUTS_ID, []);
    if (!recordsByState.has(stateId)) recordsByState.set(stateId, []);
    recordsByDistrict.get(record.NUTS_ID).push(record);
    recordsByState.get(stateId).push(record);
  }
  assert.equal(recordsByDistrict.size, 400);
  assert.equal(recordsByState.size, 16);

  for (const date of snapshot.forecast.dates) {
    const predictions = new Map(snapshot.basins.map((basin) => [
      basin.id,
      buildLiveBasinPrediction({ id: basin.id }, basin.days.find((day) => day.date === date))
    ]));
    for (const groups of [recordsByDistrict, recordsByState]) {
      for (const records of groups.values()) {
        const metrics = aggregatePredictions(records.map((record) => ({
          ...predictions.get(String(record.HYBAS_ID)),
          area: record.overlap_km2
        })));
        for (const score of [metrics.heatScore, metrics.waterStressScore, metrics.impactScore]) {
          assert.ok(Number.isFinite(score) && score >= 0 && score <= 100);
        }
      }
    }
  }
});

test("hourly VPD and root-zone soil moisture are summarized without invented fields", () => {
  const response = {
    hourly: {
      time: ["2026-07-20T00:00", "2026-07-20T12:00"],
      vapour_pressure_deficit: [0.4, 2.1],
      soil_moisture_3_to_9cm: [0.18, 0.2],
      soil_moisture_9_to_27cm: [0.22, 0.24],
      soil_moisture_27_to_81cm: [0.26, 0.28]
    },
    daily: {
      time: ["2026-07-20"],
      temperature_2m_max: [31],
      temperature_2m_min: [18],
      apparent_temperature_max: [33],
      precipitation_sum: [0],
      et0_fao_evapotranspiration: [5]
    }
  };
  const [day] = summarizeForecastResponse(response);
  assert.equal(day.vpdMaxKpa, 2.1);
  assert.equal(day.soilMoistureM3M3, 0.255);
  assert.equal(day.waterBalance3dMm, -5);
  assert.equal(day.completeness, 100);
});

test("DWD JSONP is parsed and heat alerts stay separate by state", () => {
  const payload = {
    time: Date.parse("2026-07-20T08:00:00Z"),
    copyright: "DWD",
    warnings: {
      x: [{
        stateShort: "BY",
        state: "Bayern",
        type: 8,
        level: 2,
        start: Date.parse("2026-07-20T09:00:00Z"),
        end: Date.parse("2026-07-20T18:00:00Z"),
        regionName: "Test region",
        event: "HITZE",
        headline: "Test heat warning"
      }]
    }
  };
  const parsed = parseDwdWarnings(`warnWetter.loadWarnings(${JSON.stringify(payload)});`);
  assert.equal(parsed.states.DE2.heatWarningCount, 1);
  assert.equal(parsed.states.DE2.warnings[0].isHeat, true);
});

test("geometry centroid is stable for a simple polygon", () => {
  assert.deepEqual(geometryCentroid({
    type: "Polygon",
    coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]]
  }), [1, 1]);
});
