import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRefresh } from "../scripts/fetch-live-data.mjs";

test("failed refresh preserves the last snapshot and records the stale source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "heatlens-refresh-test-"));
  const outputPath = join(directory, "forecast.json");
  const reportPath = join(directory, "refresh-status.json");
  try {
    await writeFile(outputPath, '{"last":"validated"}\n');
    await assert.rejects(runRefresh({ outputPath, reportPath,
      now: () => new Date("2026-10-22T12:00:00Z"),
      buildDataset: async ({ onSource }) => {
        onSource("ufz", { status: "available", validAt: "2026-10-01T00:00:00Z", maximumAgeHours: 96 });
        const error = new Error("ufz source time is outside the 96-hour freshness policy");
        error.source = "ufz";
        throw error;
      }
    }), /ufz source time/);
    assert.equal(await readFile(outputPath, "utf8"), '{"last":"validated"}\n');
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.status, "failed");
    assert.equal(report.error.source, "ufz");
    assert.equal(report.sources.ufz.status, "stale");
    assert.equal(report.sources.ufz.ageHours, 516);
    assert.equal(report.generatedAt, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("successful refresh atomically replaces the snapshot and records its date window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "heatlens-refresh-test-"));
  const outputPath = join(directory, "forecast.json");
  const reportPath = join(directory, "refresh-status.json");
  const dataset = { generatedAt: "2026-10-22T12:00:00Z", forecast: { dates: ["2026-10-22"] } };
  try {
    await runRefresh({ outputPath, reportPath, buildDataset: async () => dataset });
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), dataset);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.status, "success");
    assert.equal(report.generatedAt, dataset.generatedAt);
    assert.deepEqual(report.forecastDates, dataset.forecast.dates);
    assert.equal(report.error, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
