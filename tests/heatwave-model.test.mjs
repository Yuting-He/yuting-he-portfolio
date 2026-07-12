import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregatePredictions,
  actionsFor,
  buildBasinPrediction,
  dataStatus,
  dateRange,
  dateOffset,
  isScenarioDate,
  scoreForLayer
} from "../heatwave-model.js";

const basin = {
  id: "2080469900",
  centroid: [13.2, 52.4],
  properties: { SUB_AREA: 420 }
};

test("date window covers analysis and nearby dates", () => {
  const dates = dateRange();
  assert.equal(dates.length, 10);
  assert.ok(dates.includes("2026-07-11"));
  assert.equal(dataStatus("2026-07-14"), "Static scenario +3d");
  assert.equal(isScenarioDate("2026-07-17"), true);
  assert.equal(isScenarioDate("2026-07-18"), false);
  assert.throws(() => dateOffset("2026-07-18"), RangeError);
});

test("basin predictions are deterministic and date-sensitive", () => {
  const first = buildBasinPrediction(basin, "2026-07-11");
  const repeated = buildBasinPrediction(basin, "2026-07-11");
  const later = buildBasinPrediction(basin, "2026-07-14");
  assert.deepEqual(first, repeated);
  assert.notEqual(first.heatScore, later.heatScore);
  assert.ok(later.consistencyProxy < first.consistencyProxy);
});

test("aggregated scores remain in the public 0-100 range", () => {
  const predictions = [
    buildBasinPrediction(basin, "2026-07-12"),
    buildBasinPrediction({ ...basin, id: "2080469901", centroid: [8.6, 49.4] }, "2026-07-12")
  ];
  for (const audience of ["residents", "farmers", "municipal"]) {
    const metrics = aggregatePredictions(predictions, { audience, exposure: 72, cropSensitivity: 65 });
    for (const layer of ["impact", "heat", "drought"]) {
      assert.ok(scoreForLayer(metrics, layer) >= 0);
      assert.ok(scoreForLayer(metrics, layer) <= 100);
    }
  }
});

test("aggregation rejects empty prediction groups", () => {
  assert.throws(() => aggregatePredictions([]), /At least one basin/);
  assert.throws(() => aggregatePredictions([buildBasinPrediction(basin, "2026-07-11")], { audience: "insurer" }), /Unknown audience/);
});

test("unknown public layers are rejected instead of silently returning impact", () => {
  const metrics = aggregatePredictions([buildBasinPrediction(basin, "2026-07-11")]);
  assert.throws(() => scoreForLayer(metrics, "wind"), /Unknown risk layer/);
});

test("invalid model inputs fail closed", () => {
  assert.throws(() => buildBasinPrediction({ ...basin, centroid: [Number.NaN, 52] }, "2026-07-11"), /finite longitude/);
  const first = buildBasinPrediction(basin, "2026-07-11");
  const second = buildBasinPrediction({ ...basin, id: "2" }, "2026-07-12");
  assert.throws(() => aggregatePredictions([first, second]), /share one scenario date/);
  assert.throws(() => aggregatePredictions([{ ...first, heatScore: Number.NaN }]), /finite proxy values/);
});

test("farmer prompts remain evidence checks rather than autonomous actions", () => {
  const metrics = aggregatePredictions([buildBasinPrediction(basin, "2026-07-11")], { audience: "farmers" });
  const guidance = actionsFor(metrics, "farmers");
  assert.doesNotMatch(guidance.actions.join(" "), /Irrigation priority/i);
  assert.match(guidance.actions.join(" "), /do not change harvest timing/i);
  assert.match(guidance.note, /agronomic professional/i);
});
