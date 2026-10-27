import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { checkLiveFreshness, formatRefreshSummary, validateSavedSnapshot } from "../scripts/check-live-freshness.mjs";

const NOW = Date.parse("2026-10-22T10:00:00Z");
const isoBefore = (hours) => new Date(NOW - hours * 3_600_000).toISOString();

function currentSnapshot() {
  return {
    generatedAt: isoBefore(0.1),
    forecast: {
      pastDays: 2, forecastDays: 7,
      dates: Array.from({ length: 9 }, (_, index) => `2026-10-${20 + index}`)
    },
    observations: {
      radolan: { status: "available", periodEnd: isoBefore(1) },
      dwdTemperature: { status: "available", observedAt: isoBefore(1) }
    },
    soilMoisture: {
      ufz: { status: "available", validAt: isoBefore(72) },
      dwd: { status: "available", validAt: isoBefore(36) }
    },
    warnings: { status: "unavailable", issuedAt: null }
  };
}

test("fresh independent weather sources can publish when warning feed is unavailable", () => {
  const report = checkLiveFreshness(currentSnapshot(), NOW);
  assert.equal(report.status, "ready");
  assert.deepEqual(report.issues, []);
  assert.equal(report.warningFeed.status, "unavailable");
});

test("a historical snapshot cannot pass by claiming its sources were current at generation", () => {
  const snapshot = currentSnapshot();
  snapshot.generatedAt = isoBefore(24);
  snapshot.soilMoisture.ufz.validAt = isoBefore(97);
  snapshot.sourceFreshness = { sources: { ufz: { current: true, maximumAgeHours: 1000 } } };
  const report = checkLiveFreshness(snapshot, NOW);
  assert.equal(report.status, "blocked");
  assert.equal(report.sources.ufz.status, "stale");
  assert.equal(report.sources.ufz.maximumAgeHours, 96);
  assert.ok(report.issues.some((issue) => issue.includes("generated within")));
});

test("live gate rejects future generation, missing sources and unavailable sources", () => {
  const snapshot = currentSnapshot();
  snapshot.generatedAt = isoBefore(-1);
  snapshot.observations.radolan.status = "unavailable";
  delete snapshot.soilMoisture.dwd.validAt;
  const report = checkLiveFreshness(snapshot, NOW);
  assert.equal(report.status, "blocked");
  assert.equal(report.sources.radolan.status, "unavailable");
  assert.equal(report.sources.dwdSoil.ageHours, null);
  assert.ok(report.issues.length >= 3);
});

test("live gate checks Berlin today rather than UTC date and rejects a broken forecast window", () => {
  const snapshot = currentSnapshot();
  const lateUtc = Date.parse("2026-10-22T22:30:00Z");
  const report = checkLiveFreshness(snapshot, lateUtc);
  assert.equal(report.currentDate, "2026-10-23");
  assert.ok(report.issues.some((issue) => issue.includes("anchored on 2026-10-23")));

  snapshot.forecast.dates[8] = "2026-10-29";
  assert.equal(checkLiveFreshness(snapshot, NOW).status, "blocked");
});

test("source thresholds are enforced at publication even if the snapshot is newly generated", () => {
  const snapshot = currentSnapshot();
  snapshot.observations.dwdTemperature.observedAt = isoBefore(8.1);
  const report = checkLiveFreshness(snapshot, NOW);
  assert.equal(report.status, "blocked");
  assert.equal(report.sources.dwdTemperature.status, "stale");
  assert.ok(report.issues.some((issue) => issue.startsWith("dwdTemperature")));
});

test("failure summary preserves source error and distinguishes a skipped publication check", () => {
  const summary = formatRefreshSummary({
    status: "failed", error: { message: "UFZ timestamp is stale" },
    sources: { ufz: { status: "stale", validAt: isoBefore(97), ageHours: 97, maximumAgeHours: 96 } }
  }, null, { refresh: "failure", publication: "skipped" });
  assert.match(summary, /Refresh step: \*\*failure\*\*/);
  assert.match(summary, /Publication check: \*\*skipped\*\*/);
  assert.match(summary, /UFZ timestamp is stale/);
  assert.match(summary, /previous Pages release is preserved/);
});

test("saved publication permits a real historical snapshot without rewriting its age or source limits", async () => {
  const dataset = JSON.parse(await readFile(new URL("../assets/live/forecast.json", import.meta.url), "utf8"));
  const original = JSON.stringify(dataset);
  const now = Date.parse(dataset.generatedAt) + 72 * 3_600_000;
  const report = await validateSavedSnapshot(dataset, now);
  assert.equal(report.status, "ready");
  assert.equal(report.mode, "saved");
  assert.equal(report.freshnessStatus, "stale");
  assert.equal(report.suggestedActions, "suppressed-for-stale-data");
  assert.equal(report.generatedAt, dataset.generatedAt);
  assert.equal(report.snapshotAgeHours, 72);
  assert.equal(report.sources.radolan.maximumAgeHours, 8);
  assert.equal(report.sources.ufz.maximumAgeHours, 96);
  assert.equal(JSON.stringify(dataset), original);
  assert.equal(checkLiveFreshness(dataset, now).status, "blocked");
});

test("saved publication still rejects future clocks, malformed date windows and incomplete basin data", async () => {
  const dataset = JSON.parse(await readFile(new URL("../assets/live/forecast.json", import.meta.url), "utf8"));
  const now = Date.parse(dataset.generatedAt) + 72 * 3_600_000;
  for (const damage of [
    (copy) => { copy.generatedAt = new Date(now + 3_600_000).toISOString(); },
    (copy) => { copy.forecast.dates[3] = copy.forecast.dates[2]; },
    (copy) => { copy.soilMoisture.ufz.validAt = new Date(now + 3 * 3_600_000).toISOString(); },
    (copy) => { copy.basins[0].context.ufzTopsoilSmi = null; }
  ]) {
    const copy = structuredClone(dataset);
    damage(copy);
    const report = await validateSavedSnapshot(copy, now);
    assert.equal(report.status, "blocked");
    assert.ok(report.issues.length);
  }
});

test("saved-data summary clearly reports reuse, original date and repository fallback", () => {
  const summary = formatRefreshSummary(null, {
    mode: "saved", status: "ready", generatedAt: "2026-10-22T20:12:46.515Z", freshnessStatus: "stale", sources: {}
  }, { refresh: "skipped", reuse: "success", publication: "success" }, {
    origin: "repository-fallback", fallbackReason: "Published snapshot returned HTTP 503"
  });
  assert.match(summary, /Reused saved snapshot/);
  assert.match(summary, /original generation time preserved/i);
  assert.match(summary, /2026-10-22T20:12:46.515Z/);
  assert.match(summary, /repository-fallback/);
  assert.match(summary, /HTTP 503/);
  assert.match(summary, /\*\*stale\*\*/);
  assert.doesNotMatch(summary, /No new site is published/);
});
