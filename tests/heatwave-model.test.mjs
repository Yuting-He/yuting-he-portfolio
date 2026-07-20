import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregatePredictions,
  actionsFor,
  buildLiveBasinPrediction,
  freshnessStatus,
  isIsoDate,
  scoreForLayer
} from "../heatwave-model.js";

const basin = { id: "2080469900", properties: { SUB_AREA: 420 } };
const mildDay = {
  date: "2026-07-20",
  tmaxC: 27,
  tminC: 15,
  apparentMaxC: 28,
  precipitationMm: 1,
  et0Mm: 4,
  vpdMaxKpa: 1.8,
  soilMoistureM3M3: 0.24,
  waterBalance3dMm: -6,
  heatPersistenceDays: 0,
  dryPersistenceDays: 2,
  completeness: 100
};

test("ISO dates and source freshness fail closed", () => {
  assert.equal(isIsoDate("2026-07-20"), true);
  assert.equal(isIsoDate("2026-02-30"), false);
  assert.equal(isIsoDate("9999-99-99"), false);
  assert.equal(freshnessStatus("2026-07-20T06:00:00Z", Date.parse("2026-07-20T12:00:00Z")).label, "Current");
  assert.equal(freshnessStatus("2026-07-18T12:00:00Z", Date.parse("2026-07-20T12:00:00Z")).stale, true);
  assert.equal(freshnessStatus("not-a-date").stale, true);
});

test("live indices respond monotonically to hotter and drier inputs", () => {
  const mild = buildLiveBasinPrediction(basin, mildDay);
  const hotDry = buildLiveBasinPrediction(basin, {
    ...mildDay,
    tmaxC: 39,
    tminC: 25,
    apparentMaxC: 42,
    et0Mm: 6.5,
    vpdMaxKpa: 3.5,
    soilMoistureM3M3: 0.12,
    waterBalance3dMm: -18,
    heatPersistenceDays: 4,
    dryPersistenceDays: 7
  });
  assert.ok(hotDry.heatScore > mild.heatScore);
  assert.ok(hotDry.waterStressScore > mild.waterStressScore);
  assert.ok(hotDry.heatScore <= 100);
  assert.ok(hotDry.waterStressScore <= 100);
});

test("aggregated scores remain in the public 0-100 range", () => {
  const predictions = [
    buildLiveBasinPrediction(basin, mildDay),
    buildLiveBasinPrediction({ ...basin, id: "2080469901" }, { ...mildDay, tmaxC: 31, apparentMaxC: 33 })
  ];
  for (const audience of ["residents", "farmers", "municipal"]) {
    const metrics = aggregatePredictions(predictions, { audience, exposure: 72, cropSensitivity: 65 });
    for (const layer of ["impact", "heat", "water"]) {
      assert.ok(scoreForLayer(metrics, layer) >= 0);
      assert.ok(scoreForLayer(metrics, layer) <= 100);
    }
    assert.equal(metrics.completeness, 100);
  }
});

test("invalid or mixed live inputs are rejected", () => {
  assert.throws(() => buildLiveBasinPrediction(basin, { ...mildDay, tmaxC: null }), /finite source values/);
  const first = buildLiveBasinPrediction(basin, mildDay);
  const second = buildLiveBasinPrediction({ ...basin, id: "2" }, { ...mildDay, date: "2026-07-21" });
  assert.throws(() => aggregatePredictions([]), /At least one basin/);
  assert.throws(() => aggregatePredictions([first], { audience: "insurer" }), /Unknown audience/);
  assert.throws(() => aggregatePredictions([first, second]), /share one forecast date/);
  assert.throws(() => scoreForLayer(aggregatePredictions([first]), "wind"), /Unknown risk layer/);
});

test("farmer prompts remain evidence checks rather than autonomous actions", () => {
  const metrics = aggregatePredictions([buildLiveBasinPrediction(basin, mildDay)], { audience: "farmers" });
  const guidance = actionsFor(metrics, "farmers");
  assert.match(guidance.actions.join(" "), /field probe/i);
  assert.match(guidance.actions.join(" "), /do not change harvest timing/i);
  assert.match(guidance.note, /agronomic professional/i);
});
