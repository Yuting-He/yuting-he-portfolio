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
  precipitation1hMaxMm: 0.5,
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

test("live indices respond monotonically to hotter, drier, and wetter inputs", () => {
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
  const saturated = buildLiveBasinPrediction(basin, {
    ...mildDay,
    precipitationMm: 58,
    precipitation1hMaxMm: 28,
    soilMoistureM3M3: 0.49,
    waterBalance3dMm: 48,
    dryPersistenceDays: 0
  });
  assert.ok(hotDry.heatScore > mild.heatScore);
  assert.ok(hotDry.dryStressScore > mild.dryStressScore);
  assert.ok(saturated.wetStressScore > mild.wetStressScore);
  assert.ok(hotDry.heatScore <= 100);
  assert.ok(hotDry.dryStressScore <= 100);
  assert.ok(saturated.wetStressScore <= 100);
});

test("aggregated scores remain in the public 0-100 range", () => {
  const predictions = [
    buildLiveBasinPrediction(basin, mildDay),
    buildLiveBasinPrediction({ ...basin, id: "2080469901" }, { ...mildDay, tmaxC: 31, apparentMaxC: 33 })
  ];
  for (const audience of ["residents", "farmers", "municipal"]) {
    const metrics = aggregatePredictions(predictions, { audience, exposure: 72, cropSensitivity: 65 });
    for (const layer of ["impact", "heat", "dry", "wet"]) {
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
  const text = guidance.actions.map((item) => `${item.category} ${item.text}`).join(" ");
  assert.match(text, /representative fields/i);
  assert.match(text, /do not change harvest timing/i);
  assert.match(guidance.note, /qualified advice/i);
});

test("short intense rain can coexist with dry root-zone stress", () => {
  const metrics = aggregatePredictions([buildLiveBasinPrediction(basin, {
    ...mildDay,
    precipitationMm: 35,
    precipitation1hMaxMm: 25,
    soilMoistureM3M3: 0.13,
    waterBalance3dMm: 20,
    et0Mm: 5.5,
    vpdMaxKpa: 3,
    dryPersistenceDays: 4
  })], { audience: "farmers" });
  assert.ok(metrics.dryStressScore >= 35);
  assert.ok(metrics.wetStressScore >= 35);
});

test("official warnings strengthen verification without entering the score", () => {
  const metrics = aggregatePredictions([buildLiveBasinPrediction(basin, mildDay)], { audience: "municipal" });
  const before = metrics.impactScore;
  const guidance = actionsFor(metrics, "municipal", { heatWarningCount: 1, rainWarningCount: 1 });
  assert.match(guidance.actions.map((item) => item.text).join(" "), /active DWD heat and rain warnings/i);
  assert.equal(metrics.impactScore, before);
});

test("very high water stress escalates without autonomous operational decisions", () => {
  const veryHigh = {
    ...aggregatePredictions([buildLiveBasinPrediction(basin, mildDay)], { audience: "farmers" }),
    dryStressScore: 82,
    wetStressScore: 88,
    heatScore: 40
  };
  const farmerText = actionsFor(veryHigh, "farmers").actions.map((item) => item.text).join(" ");
  const municipalText = actionsFor(veryHigh, "municipal").actions.map((item) => item.text).join(" ");
  assert.match(farmerText, /heavy machinery off/i);
  assert.match(farmerText, /do not change harvest timing/i);
  assert.match(municipalText, /only authorised teams may decide road closures/i);
  assert.doesNotMatch(farmerText, /\b\d+\s*(?:mm|litres?|l\/m)/i);
});
