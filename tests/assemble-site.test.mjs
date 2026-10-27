import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assembleSite, collectSiteFiles } from "../scripts/assemble-site.mjs";

async function fixture(t) {
  const prefix = resolve(tmpdir(), "heatlens-site-test-");
  const root = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(root.startsWith(prefix));
    await rm(root, { recursive: true, force: true });
  });
  const overview = JSON.stringify({ snapshotId: "fixture-v1", states: [] });
  const generatedAt = "2026-10-22T20:12:46.515Z";
  const files = {
    ".nojekyll": "",
    "LICENSE": "fixture",
    "THIRD_PARTY_NOTICES.md": "fixture",
    "index.html": '<link rel="stylesheet" href="./styles.css"><a href="./heatwave-demo.html">HeatLens</a>',
    "styles.css": 'body { background-image: url("./assets/background.svg"); }',
    "heatwave-demo.html": '<script type="module" src="./app.js"></script>',
    "app.js": 'import { value } from "./ui/control.js"; export { value as another } from "./ui/export.js";',
    "ui/control.js": 'import"./nested.mjs"; export const value = 1;',
    "ui/export.js": 'export const value = 2;',
    "ui/nested.mjs": 'export const complete = true;',
    "assets/background.svg": "<svg/>",
    "vendor/map.css": "body {}",
    "assets/live/forecast.json": JSON.stringify({ generatedAt }),
    "assets/live/snapshots/fixture-v1/overview.json": overview,
    "assets/live/manifest.json": JSON.stringify({
      schema: "heatlens-manifest/v1", snapshotId: "fixture-v1", modelVersion: "fixture-model", generatedAt,
      overview: { url: "snapshots/fixture-v1/overview.json", bytes: Buffer.byteLength(overview), sha256: createHash("sha256").update(overview).digest("hex") },
      states: {}
    }),
    "artifacts/publication-status.json": JSON.stringify({ mode: "saved", freshnessStatus: "stale" }),
    "watt-hackathon/index.html": '<script src="./web/showcase.js"></script>',
    "watt-hackathon/web/showcase.js": 'const labels = [\'export\', \'button\']; fetch("../artifacts/showcase_data.json");',
    "watt-hackathon/artifacts/showcase_data.json": "{}",
    "watt-hackathon/data/official/network_map.png": "fixture-png",
    "watt-hackathon/tests/test.js": 'throw new Error("not a static asset");',
    "watt-hackathon/docs/private.json": "{}",
    "watt-hackathon/__pycache__/cached.json": "{}",
    "watt-hackathon/node_modules/pkg/index.js": "{}",
    "watt-hackathon/backend.py": "print('not a public browser asset')"
  };
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

test("assembly follows transitive imports and static assets and publishes matching version metadata", async (t) => {
  const root = await fixture(t);
  const result = await assembleSite({ root, commit: "fixture-commit", now: Date.parse("2026-10-27T12:00:00Z") });
  for (const file of ["ui/nested.mjs", "assets/background.svg", "watt-hackathon/artifacts/showcase_data.json", "watt-hackathon/data/official/network_map.png"]) {
    assert.ok(result.files.includes(file));
    assert.equal(await readFile(join(result.outputDir, file), "utf8"), await readFile(join(root, file), "utf8"));
  }
  assert.ok(result.files.every((file) => !/(?:tests|docs|__pycache__|node_modules|backend\.py)/.test(file)));
  const info = JSON.parse(await readFile(join(result.outputDir, "build-info.json"), "utf8"));
  assert.equal(info.commit, "fixture-commit");
  assert.equal(info.modelVersion, "fixture-model");
  assert.equal(info.snapshotId, "fixture-v1");
  assert.equal(info.snapshotGeneratedAt, "2026-10-22T20:12:46.515Z");
  assert.equal(info.publicationMode, "saved");
  assert.equal(info.savedDataFreshness, "stale");
});

test("missing module dependencies fail assembly before replacing a prior artifact", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "_site"));
  await writeFile(join(root, "_site/sentinel.txt"), "previous artifact");
  await writeFile(join(root, "ui/control.js"), 'export { missing } from "./not-built.js";');
  await assert.rejects(assembleSite({ root }), /Missing site dependency: ui\/control\.js → ui\/not-built\.js/);
  assert.equal(await readFile(join(root, "_site/sentinel.txt"), "utf8"), "previous artifact");
});

test("assembly rejects mixed immutable snapshot assets and unsafe output locations", async (t) => {
  const root = await fixture(t);
  await assert.rejects(assembleSite({ root, outputDir: root }), /dedicated directory/);
  await assert.rejects(assembleSite({ root, outputDir: join(root, "assets/site") }), /dedicated directory/);
  await writeFile(join(root, "assets/live/snapshots/fixture-v1/overview.json"), "tampered");
  await assert.rejects(assembleSite({ root }), /does not match manifest/);
});

test("dependency paths cannot escape the source tree", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "ui/control.js"), 'import "../../outside.js";');
  await assert.rejects(collectSiteFiles(root), /escapes source root/);
});

test("manifest and legacy snapshot must keep the same genuine generation time", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "assets/live/forecast.json"), JSON.stringify({ generatedAt: "2026-10-26T22:43:54.007Z" }));
  await assert.rejects(assembleSite({ root }), /must describe the same snapshot/);
});
