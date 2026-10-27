import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { reusePublishedData } from "../scripts/reuse-published-data.mjs";

const snapshot = JSON.parse(await readFile(new URL("../assets/live/forecast.json", import.meta.url), "utf8"));
const now = Date.parse(snapshot.generatedAt) + 72 * 3_600_000;

async function fixture(t, contents = snapshot) {
  const prefix = resolve(tmpdir(), "heatlens-reuse-test-");
  const root = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(root.startsWith(prefix));
    await rm(root, { recursive: true, force: true });
  });
  const outputPath = join(root, "assets/live/forecast.json");
  const reportPath = join(root, "artifacts/reuse-status.json");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(contents));
  return { outputPath, reportPath, now };
}

test("ordinary site edits reuse published data with unchanged generation and source timestamps", async (t) => {
  const options = await fixture(t);
  const published = { ...structuredClone(snapshot), reuseTestMarker: "downloaded" };
  const report = await reusePublishedData({ ...options, fetchImpl: async () => ({ ok: true, json: async () => published }) });
  assert.equal(report.status, "success");
  assert.equal(report.origin, "published");
  assert.equal(report.freshnessStatus, "stale");
  const written = JSON.parse(await readFile(options.outputPath, "utf8"));
  assert.deepEqual(written, published);
  assert.equal(written.generatedAt, snapshot.generatedAt);
  assert.deepEqual(written.sourceFreshness, snapshot.sourceFreshness);
});

test("a failed published download uses a validated repository fallback and records why", async (t) => {
  const options = await fixture(t);
  const original = await readFile(options.outputPath, "utf8");
  const report = await reusePublishedData({ ...options, fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(report.origin, "repository-fallback");
  assert.match(report.fallbackReason, /HTTP 503/);
  assert.equal(report.generatedAt, snapshot.generatedAt);
  assert.equal(await readFile(options.outputPath, "utf8"), original);
  assert.equal(JSON.parse(await readFile(options.reportPath, "utf8")).status, "success");
});

test("a malformed published snapshot cannot replace the last valid repository data", async (t) => {
  const options = await fixture(t);
  const report = await reusePublishedData({ ...options, fetchImpl: async () => ({ ok: true, json: async () => ({ schema: "invalid" }) }) });
  assert.equal(report.origin, "repository-fallback");
  assert.match(report.fallbackReason, /invalid|missing|must/i);
  assert.deepEqual(JSON.parse(await readFile(options.outputPath, "utf8")), snapshot);
});

test("reuse fails visibly when both published data and the repository fallback are invalid", async (t) => {
  const options = await fixture(t, { schema: "invalid" });
  await assert.rejects(reusePublishedData({ ...options, fetchImpl: async () => { throw new Error("offline"); } }), /repository fallback is invalid/);
  const report = JSON.parse(await readFile(options.reportPath, "utf8"));
  assert.equal(report.status, "failed");
  assert.match(report.error.message, /offline/);
  assert.deepEqual(JSON.parse(await readFile(options.outputPath, "utf8")), { schema: "invalid" });
});
