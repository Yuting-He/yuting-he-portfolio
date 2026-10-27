import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHeatlensAssets } from "../scripts/build-heatlens-assets.mjs";
import { VERIFIED_BINARY_FILES, VERIFIED_FRONTEND_FILES, verifyLiveSite } from "../scripts/verify-live-site.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = resolve(ROOT, ".cache");
const BASE = "https://heatlens.example.test/portfolio/";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
let directory, manifest, defaults, sequence = 0;

test.before(async () => {
  await mkdir(CACHE, { recursive: true });
  directory = await mkdtemp(resolve(CACHE, "verify-live-test-"));
  manifest = await buildHeatlensAssets({ root: ROOT, outputDirectory: resolve(directory, "data") });
  defaults = new Map();
  for (const path of ["index.html", "heatwave-demo.html", "watt-hackathon/index.html", "watt-hackathon/schedule.html", ...VERIFIED_FRONTEND_FILES, ...VERIFIED_BINARY_FILES, "assets/live/forecast.json"]) {
    defaults.set(path, await readFile(resolve(ROOT, path)));
  }
  defaults.set("assets/live/manifest.json", Buffer.from(JSON.stringify(manifest)));
  for (const reference of [manifest.overview, manifest.states.DE2]) {
    defaults.set(`assets/live/${reference.url}`, await readFile(resolve(directory, "data", reference.url)));
  }
  defaults.set("build-info.json", Buffer.from(JSON.stringify({ schema: "heatlens-site-build/v1", commit: COMMIT,
    modelVersion: manifest.modelVersion, snapshotId: manifest.snapshotId, snapshotGeneratedAt: manifest.generatedAt,
    builtAt: manifest.generatedAt, publicationMode: "saved", savedDataFreshness: "stale" })));
});

test.after(async () => {
  if (!directory?.startsWith(`${CACHE}${sep}`)) throw new Error("Verification test cleanup must remain in the workspace cache");
  await rm(directory, { recursive: true, force: true });
});

const json = (files, path) => JSON.parse(files.get(path).toString("utf8"));
const setJson = (files, path, value) => files.set(path, Buffer.from(JSON.stringify(value)));

async function run({ files = new Map(defaults), now = Date.parse(manifest.generatedAt) + 72 * 3_600_000, override, ...options } = {}) {
  const requests = [];
  const delays = [];
  const reportPath = resolve(directory, "reports", `${++sequence}.json`);
  const report = await verifyLiveSite({ baseUrl: BASE, expectedCommit: COMMIT, expectedSnapshotId: manifest.snapshotId,
    root: ROOT, reportPath, now, attempts: 3, delayMs: 0,
    waitImpl: async (delay) => { delays.push(delay); },
    fetchImpl: async (address) => {
      const path = new URL(address).pathname.replace(/^\/portfolio\//, "");
      requests.push(path);
      const changed = override && await override(path, requests);
      if (changed) return changed;
      return files.has(path) ? new Response(files.get(path), { status: 200 }) : new Response("Not found", { status: 404 });
    }, ...options });
  return { report, requests, delays, savedReport: JSON.parse(await readFile(reportPath, "utf8")) };
}

test("deployed saved data verifies genuine builder hashes, pages and all modules without being marked fresh", async () => {
  const files = new Map(defaults);
  files.set("heatwave-demo.js", Buffer.from(files.get("heatwave-demo.js").toString("utf8").replaceAll("\r\n", "\n").replaceAll("\n", "\r\n")));
  const { report, savedReport } = await run({ files });
  assert.equal(report.status, "success");
  assert.equal(report.publicationMode, "saved");
  assert.equal(report.freshnessStatus, "stale");
  assert.equal(report.generatedAt, manifest.generatedAt);
  assert.equal(report.basinCount, 614);
  assert.equal(report.forecastDates.length, 9);
  assert.equal(report.files.filter((file) => file.path.endsWith(".js")).length, 11);
  assert.equal(report.overviewIntegrityVerified, true);
  assert.equal(report.regionalIntegrityVerified, true);
  assert.equal(report.binaryFiles.length, 7);
  assert.deepEqual(report.binaryFiles.map((file) => file.path), VERIFIED_BINARY_FILES);
  for (const binary of report.binaryFiles) {
    assert.equal(binary.matchesCheckout, true);
    assert.equal(binary.bytes, files.get(binary.path).byteLength);
    assert.equal(binary.sha256, createHash("sha256").update(files.get(binary.path)).digest("hex"));
  }
  assert.equal(report.freshness.sources.radolan.maximumAgeHours, 8);
  assert.equal(savedReport.status, "success");
});

test("a live deployment passes only with current source clocks", async () => {
  const files = new Map(defaults);
  setJson(files, "build-info.json", { ...json(files, "build-info.json"), publicationMode: "live" });
  assert.equal((await run({ files, now: Date.parse(manifest.generatedAt) + 30_000 })).report.status, "success");
  const stale = await run({ files });
  assert.equal(stale.report.status, "failed");
  assert.match(stale.report.error.message, /real-clock freshness/);
});

test("an old Pages commit is retried until the expected deployment is visible", async () => {
  let checks = 0;
  const outcome = await run({ override: (path) => path === "build-info.json" && ++checks === 1
    ? new Response(JSON.stringify({ ...json(defaults, path), commit: "previous-commit" }), { status: 200 }) : null });
  assert.equal(outcome.report.status, "success");
  assert.equal(outcome.report.attempts.length, 2);
  assert.equal(outcome.report.attempts[0].error.code, "COMMIT_NOT_PROPAGATED");
  assert.equal(outcome.delays.length, 1);
});

test("same-commit data refreshes also wait for the exact snapshot built by this run", async () => {
  let checks = 0;
  const outcome = await run({ override: (path) => path === "build-info.json" && ++checks === 1
    ? new Response(JSON.stringify({ ...json(defaults, path), snapshotId: "previous-snapshot" }), { status: 200 }) : null });
  assert.equal(outcome.report.status, "success");
  assert.equal(outcome.report.attempts[0].error.code, "SNAPSHOT_NOT_PROPAGATED");
});

test("commit propagation retries are bounded and retain the failure report", async () => {
  const files = new Map(defaults);
  setJson(files, "build-info.json", { ...json(files, "build-info.json"), commit: "previous-commit" });
  const { report, requests, savedReport } = await run({ files });
  assert.equal(report.status, "failed");
  assert.equal(report.attempts.length, 3);
  assert.deepEqual(requests, Array(3).fill("build-info.json"));
  assert.equal(savedReport.error.code, "COMMIT_NOT_PROPAGATED");
});

test("transient network failure can recover within the bounded verification retries", async () => {
  let checks = 0;
  const { report } = await run({ override: (path) => {
    if (path === "build-info.json" && ++checks === 1) throw new Error("temporary network failure");
  } });
  assert.equal(report.status, "success");
  assert.equal(report.attempts.length, 2);
});

test("a real 404 fails immediately rather than being reported as propagation success", async () => {
  const files = new Map(defaults);
  files.delete("heatwave-results.js");
  const { report } = await run({ files });
  assert.equal(report.status, "failed");
  assert.equal(report.attempts.length, 1);
  assert.match(report.error.message, /HTTP 404.*heatwave-results\.js/);
});

test("a corrupt project image fails even when UTF-8 decoding would hide the changed binary byte", async () => {
  const files = new Map(defaults);
  const path = "assets/portfolio/heatlens-workbench.webp";
  const original = files.get(path);
  const corrupt = Buffer.from(original);
  const index = corrupt.findIndex((byte, position) => position > 0 && byte >= 0x80 && byte <= 0xbf && corrupt[position - 1] < 0x80);
  assert.ok(index > 0, "The real WebP fixture contains a standalone invalid UTF-8 continuation byte");
  corrupt[index] ^= 1;
  assert.equal(corrupt.toString("utf8"), original.toString("utf8"), "Text decoding would conceal this binary corruption");
  files.set(path, corrupt);
  const { report, requests } = await run({ files });
  assert.equal(report.status, "failed");
  assert.equal(report.error.code, "BINARY_MISMATCH");
  assert.match(report.error.message, /heatlens-workbench\.webp/);
  assert.ok(requests.includes(path));
});

test("a missing public CV PDF fails verification even when all HTML and modules match", async () => {
  const files = new Map(defaults);
  files.delete("assets/Yuting_He_CV.pdf");
  const { report, requests } = await run({ files });
  assert.equal(report.status, "failed");
  assert.equal(report.error.code, "HTTP_ERROR");
  assert.match(report.error.message, /HTTP 404.*Yuting_He_CV\.pdf/);
  assert.ok(requests.includes("assets/Yuting_He_CV.pdf"));
});

test("served module drift and immutable-byte corruption both fail verification", async () => {
  const files = new Map(defaults);
  files.set("heatwave-results.js", Buffer.from("export const unexpected = true;"));
  const moduleResult = await run({ files });
  assert.equal(moduleResult.report.status, "failed");
  assert.equal(moduleResult.report.error.code, "FILE_MISMATCH");
  const corrupt = new Map(defaults);
  const path = `assets/live/${manifest.states.DE2.url}`;
  corrupt.set(path, Buffer.concat([corrupt.get(path), Buffer.from(" ")]));
  const integrity = await run({ files: corrupt });
  assert.equal(integrity.report.status, "failed");
  assert.match(integrity.report.error.message, /integrity/);
  assert.equal(integrity.report.attempts.length, 1);
});

test("validly hashed overview data still must retain the full snapshot's actual source metadata", async () => {
  const files = new Map(defaults);
  const path = `assets/live/${manifest.overview.url}`;
  const overview = json(files, path);
  overview.metadata.observations.radolan.periodEnd = "2000-01-01T00:00:00Z";
  setJson(files, path, overview);
  const changedManifest = structuredClone(manifest);
  changedManifest.overview.bytes = files.get(path).length;
  changedManifest.overview.sha256 = createHash("sha256").update(files.get(path)).digest("hex");
  setJson(files, "assets/live/manifest.json", changedManifest);
  const { report } = await run({ files });
  assert.equal(report.status, "failed");
  assert.match(report.error.message, /source metadata differs/);
});

test("missing basin records, relaxed source policy and future generation cannot pass saved publication verification", async () => {
  for (const change of [
    (dataset) => dataset.basins.pop(),
    (dataset) => { dataset.sourceFreshness.sources.radolan.maximumAgeHours = 1_000; }
  ]) {
    const files = new Map(defaults);
    const dataset = json(files, "assets/live/forecast.json");
    change(dataset);
    setJson(files, "assets/live/forecast.json", dataset);
    assert.equal((await run({ files })).report.status, "failed");
  }
  const future = await run({ now: Date.parse(manifest.generatedAt) - 3_600_000 });
  assert.equal(future.report.status, "failed");
  assert.match(future.report.error.message, /future generation/);
});
