import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AUDIENCES, aggregatePredictions, buildLiveBasinPrediction } from "../heatwave-model.js";
import { DEFAULT_VIEW } from "../heatwave-state.js";
import { DEFAULT_CONTEXT, createHeatlensDataClient, matchesDefaultContext, validateHeatlensManifest } from "../heatwave-data.js";
import { buildHeatlensAssets, createHeatlensPayloads } from "../scripts/build-heatlens-assets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (relative) => JSON.parse(await readFile(resolve(root, relative), "utf8"));
const [dataset, states, districts, basins, crosswalk] = await Promise.all([
  readJson("assets/live/forecast.json"), readJson("assets/nuts1-de.geojson"), readJson("assets/nuts3-de.geojson"),
  readJson("assets/hydrobasins-de-level8.geojson"), readJson("assets/basin-nuts3-crosswalk.json")
]);
const input = { dataset, states, districts, basins, crosswalk };
const payloads = createHeatlensPayloads(input);
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const cacheRoot = resolve(root, ".cache");
  await mkdir(cacheRoot, { recursive: true });
  const directory = await mkdtemp(resolve(cacheRoot, "heatlens-assets-test-"));
  t.after(async () => {
    if (!resolve(directory).startsWith(`${cacheRoot}\\`) && !resolve(directory).startsWith(`${cacheRoot}/`)) {
      throw new Error("Test cleanup must stay within the workspace cache");
    }
    await rm(directory, { recursive: true, force: true });
  });
  const manifest = await buildHeatlensAssets({ root, outputDirectory: directory });
  return { directory, manifest };
}

function assetFetch(directory, requests, override = new Map()) {
  return async (address) => {
    const path = new URL(address).pathname.replace(/^\/data\//, "");
    requests.push(path);
    if (override.has(path)) return new Response(override.get(path), { status: 200 });
    try { return new Response(await readFile(resolve(directory, path)), { status: 200 }); }
    catch { return new Response("Not found", { status: 404 }); }
  };
}

test("default context respects the active role while retaining unrelated role settings", () => {
  for (const [key, value] of Object.entries(DEFAULT_CONTEXT)) assert.equal(DEFAULT_VIEW[key], value);
  assert.equal(matchesDefaultContext(DEFAULT_VIEW), true);
  assert.equal(matchesDefaultContext({ ...DEFAULT_VIEW, audience: "gardeners" }), true);
  assert.equal(matchesDefaultContext({ ...DEFAULT_VIEW, crop: "maize" }), true);
  assert.equal(matchesDefaultContext({ ...DEFAULT_VIEW, audience: "farmers", crop: "maize" }), false);
  assert.equal(matchesDefaultContext({ ...DEFAULT_VIEW, audience: "gardeners", gardenSetting: "rainShadow" }), false);
  assert.equal(matchesDefaultContext({ ...DEFAULT_VIEW, audience: "farmers", gardenSetting: "rainShadow" }), true);
  assert.equal(matchesDefaultContext({ crop: "maize" }), false);
});

test("precomputed state results preserve existing prediction, overlap and profile aggregation for every role and date", () => {
  const basinGeometry = new Map(basins.features.map((feature) => [String(feature.properties.HYBAS_ID), feature]));
  for (const state of payloads.overview.states.features) {
    const stateId = state.properties.NUTS_ID;
    const records = crosswalk.filter((record) => record.NUTS_ID.startsWith(stateId));
    const localDistricts = districts.features.filter((feature) => feature.properties.NUTS_ID.startsWith(stateId));
    const weights = localDistricts.map((district) => records.filter((record) => record.NUTS_ID === district.properties.NUTS_ID)
      .reduce((sum, record) => sum + record.overlap_km2, 0));
    const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
    const profiles = localDistricts.map((district) => /Kreisfreie Stadt|Stadtkreis|Berlin|Hamburg|Bremen/i.test(
      district.properties.NAME_LATN || district.properties.NUTS_NAME || "")
      ? { exposure: 70, cropSensitivity: 25 } : { exposure: 50, cropSensitivity: 65 });
    const profile = {
      exposure: profiles.reduce((sum, item, index) => sum + item.exposure * weights[index], 0) / total,
      cropSensitivity: profiles.reduce((sum, item, index) => sum + item.cropSensitivity * weights[index], 0) / total
    };
    assert.deepEqual(payloads.overview.profiles[stateId], profile);
    dataset.forecast.dates.forEach((date, index) => {
      const predictions = new Map(dataset.basins.map((basin) => [String(basin.id), buildLiveBasinPrediction({ id: basin.id,
        properties: basinGeometry.get(String(basin.id)).properties }, { ...basin.context, ...basin.days[index] })]));
      const weighted = records.map((record) => ({ ...predictions.get(String(record.HYBAS_ID)), area: record.overlap_km2 }));
      for (const audience of Object.keys(AUDIENCES)) {
        const expected = aggregatePredictions(weighted, { ...DEFAULT_CONTEXT, ...profile, audience });
        const overlap = records.reduce((sum, record) => sum + record.overlap_km2, 0);
        const target = [...new Map(records.map((record) => [record.NUTS_ID, record.district_area_km2])).values()]
          .reduce((sum, area) => sum + area, 0);
        expected.spatialCoverage = Math.round(Math.max(0, Math.min(100, overlap / target * 100)));
        expected.available = expected.spatialCoverage >= 50 && expected.completeness >= 85;
        assert.deepEqual(payloads.overview.metricsByState[stateId][audience][date], expected, `${stateId}/${audience}/${date}`);
      }
    });
  }
});

test("regional bundles retain every cross-border dependency and original exact-area record", () => {
  const originals = new Map(dataset.basins.map((basin) => [String(basin.id), basin]));
  const appearances = new Map();
  for (const [stateId, bundle] of payloads.bundles) {
    const records = crosswalk.filter((record) => record.NUTS_ID.startsWith(stateId));
    assert.deepEqual(bundle.crosswalk, records);
    const expectedIds = [...new Set(records.map((record) => String(record.HYBAS_ID)))].sort();
    assert.deepEqual(bundle.basins.features.map((feature) => String(feature.properties.HYBAS_ID)).sort(), expectedIds);
    assert.deepEqual(bundle.livePayload.basins.map((basin) => String(basin.id)).sort(), expectedIds);
    for (const basin of bundle.livePayload.basins) {
      assert.deepEqual(basin, originals.get(String(basin.id)));
      appearances.set(String(basin.id), (appearances.get(String(basin.id)) || 0) + 1);
    }
  }
  assert.equal(appearances.size, new Set(crosswalk.map((record) => String(record.HYBAS_ID))).size);
  assert.ok([...appearances.values()].some((count) => count > 1), "border basins must be included in all dependent states");
  assert.equal(payloads.overview.locations.length, 416);
  assert.equal(payloads.overview.basinIndex.length, 614);
  assert.equal(payloads.overview.basinIndex.filter((basin) => basin.stateId !== null).length, appearances.size);
  for (const basin of payloads.overview.basinIndex) {
    const records = crosswalk.filter((record) => String(record.HYBAS_ID) === basin.id);
    const primary = records.reduce((best, record) => !best || record.overlap_km2 > best.overlap_km2 ? record : best, null);
    assert.equal(basin.districtId, primary?.NUTS_ID || null);
  }
});

test("immutable asset references exist, match their hashes and reduce initial raw data by more than half", async (t) => {
  const { manifest, directory } = await fixture(t);
  assert.equal(validateHeatlensManifest(manifest), manifest);
  assert.equal(manifest.snapshotId, payloads.snapshotId);
  for (const reference of [manifest.overview, ...Object.values(manifest.states)]) {
    const bytes = await readFile(resolve(directory, reference.url));
    assert.equal(bytes.byteLength, reference.bytes);
    assert.equal(hash(bytes), reference.sha256);
    assert.equal(JSON.parse(bytes).snapshotId, manifest.snapshotId);
  }
  const baseline = await Promise.all(["assets/nuts1-de.geojson", "assets/nuts3-de.geojson", "assets/hydrobasins-de-level8.geojson",
    "assets/basin-nuts3-crosswalk.json", "assets/live/forecast.json"].map((path) => readFile(resolve(root, path))));
  assert.ok(manifest.overview.bytes + Buffer.byteLength(JSON.stringify(manifest)) < baseline.reduce((sum, bytes) => sum + bytes.byteLength, 0) / 2);
  const original = await readFile(resolve(directory, "manifest.json"), "utf8");
  const invalidPath = resolve(directory, "invalid-snapshot.json");
  await writeFile(invalidPath, JSON.stringify({ ...dataset, basins: dataset.basins.slice(1) }));
  await assert.rejects(buildHeatlensAssets({ root, snapshotPath: invalidPath, outputDirectory: directory }), /do not match/);
  assert.equal(await readFile(resolve(directory, "manifest.json"), "utf8"), original);
});

test("client starts with only manifest and overview, then caches one verified regional bundle", async (t) => {
  const { directory, manifest } = await fixture(t);
  const requests = [];
  const client = createHeatlensDataClient({ manifestUrl: "https://heatlens.test/data/manifest.json", fetchImpl: assetFetch(directory, requests) });
  const loaded = await client.loadOverview();
  assert.equal(loaded.manifest.snapshotId, manifest.snapshotId);
  assert.equal(loaded.metadata.generatedAt, dataset.generatedAt);
  assert.equal(loaded.states.features.length, 16);
  assert.equal(loaded.locations.length, 416);
  assert.deepEqual(requests, ["manifest.json", manifest.overview.url]);
  const state = await client.loadState("DE2", manifest);
  assert.equal(state.stateId, "DE2");
  assert.equal(state.livePayload.schema, dataset.schema);
  assert.equal(await client.loadState("DE2", manifest), state);
  assert.equal(requests.filter((path) => path === manifest.states.DE2.url).length, 1);
  assert.equal(requests.length, 3);
});

test("client rejects mixed versions and changed bytes while retaining the usable overview", async (t) => {
  const { directory, manifest } = await fixture(t);
  const requests = [];
  const mismatched = { ...payloads.bundles.get("DE2"), snapshotId: "20000101000000-000000000000" };
  const wrongBytes = `${JSON.stringify(mismatched)}\n`;
  const modifiedManifest = structuredClone(manifest);
  modifiedManifest.states.DE2.sha256 = hash(wrongBytes);
  modifiedManifest.states.DE2.bytes = Buffer.byteLength(wrongBytes);
  const overrides = new Map([[manifest.states.DE2.url, wrongBytes]]);
  const client = createHeatlensDataClient({ manifestUrl: "https://heatlens.test/data/manifest.json", fetchImpl: assetFetch(directory, requests, overrides) });
  const overview = await client.loadOverview(manifest);
  await assert.rejects(client.loadState("DE2", modifiedManifest), /different snapshot/);
  assert.equal((await client.loadOverview(manifest)).overview, overview.overview);
  overrides.set(manifest.states.DE2.url, "{}");
  await assert.rejects(client.loadState("DE2", manifest), /integrity check/);
  overrides.delete(manifest.states.DE2.url);
  assert.equal((await client.loadState("DE2", manifest)).stateId, "DE2");
});

test("cancelling one regional navigation does not poison a replacement request for the same state", async (t) => {
  const { directory, manifest } = await fixture(t);
  const requests = [];
  const normalFetch = assetFetch(directory, requests);
  let regionalRequests = 0;
  let markStarted;
  const started = new Promise((resolveStarted) => { markStarted = resolveStarted; });
  const client = createHeatlensDataClient({ manifestUrl: "https://heatlens.test/data/manifest.json",
    fetchImpl: (address, options) => {
      if (address.endsWith("/states/DE2.json") && ++regionalRequests === 1) {
        return new Promise((resolveRequest, rejectRequest) => {
          options.signal.addEventListener("abort", () => rejectRequest(options.signal.reason), { once: true });
          markStarted();
        });
      }
      return normalFetch(address, options);
    } });
  const controller = new AbortController();
  const first = client.loadState("DE2", { manifest, signal: controller.signal });
  const rejected = assert.rejects(first, { name: "AbortError" });
  await started;
  controller.abort();
  const replacement = client.loadState("DE2", { manifest, signal: new AbortController().signal });
  await rejected;
  assert.equal((await replacement).stateId, "DE2");
  assert.equal(regionalRequests, 2);
});

test("manual asset retry bypasses browser-cached 404 and corrupt bodies without evicting successful assets", async (t) => {
  const { directory, manifest } = await fixture(t);
  const validBytes = await readFile(resolve(directory, manifest.states.DE3.url));
  for (const failure of ["404", "hash"]) {
    const requests = [];
    const normalFetch = assetFetch(directory, requests);
    const modes = [];
    let restored = false;
    let cachedFailure = false;
    const fetchImpl = (address, options) => {
      if (!address.endsWith("/states/DE3.json")) return normalFetch(address, options);
      modes.push(options.cache);
      // Model a browser retaining the failed response even after the server
      // has recovered. Only reload/no-store can get the restored resource.
      if (!restored || cachedFailure && !["reload", "no-store"].includes(options.cache)) {
        cachedFailure = true;
        return Promise.resolve(failure === "404" ? new Response("Not found", { status: 404 })
          : new Response(Buffer.alloc(validBytes.byteLength, 32), { status: 200 }));
      }
      cachedFailure = false;
      return Promise.resolve(new Response(validBytes));
    };
    const client = createHeatlensDataClient({ manifestUrl: "https://heatlens.test/data/manifest.json", fetchImpl });
    const overview = await client.loadOverview(manifest);
    await assert.rejects(client.loadState("DE3", manifest), failure === "404" ? /HTTP 404/ : /integrity check/);
    restored = true;
    const recovered = await client.loadState("DE3", manifest);
    assert.equal(recovered.stateId, "DE3");
    assert.deepEqual(modes, ["force-cache", "reload"]);
    assert.equal((await client.loadOverview(manifest)).overview, overview.overview);
    assert.equal(await client.loadState("DE3", manifest), recovered);
    assert.equal(requests.filter((path) => path === manifest.overview.url).length, 1);
    assert.equal(modes.length, 2, "successful immutable assets stay in the verified memory cache");
    client.clearCache();
    assert.equal((await client.loadState("DE3", manifest)).stateId, "DE3");
    assert.equal(modes.at(-1), "force-cache", "successful recovery restores the immutable cache policy");
  }
});

test("automatic retry of an HTTP server failure bypasses a cached error response", async (t) => {
  const { directory, manifest } = await fixture(t);
  const bytes = await readFile(resolve(directory, manifest.states.DE3.url));
  const modes = [];
  const client = createHeatlensDataClient({ manifestUrl: "https://heatlens.test/data/manifest.json", retries: 1,
    fetchImpl: async (address, options) => {
      modes.push(options.cache);
      return options.cache === "reload" ? new Response(bytes) : new Response("Temporary failure", { status: 503 });
    } });
  assert.equal((await client.loadState("DE3", manifest)).stateId, "DE3");
  assert.deepEqual(modes, ["force-cache", "reload"]);
});

test("manifest and requests fail closed for unsupported models, paths, cancellation and bounded retries", async () => {
  const id = payloads.snapshotId;
  const reference = { url: `snapshots/${id}/overview.json`, bytes: 1, sha256: "0".repeat(64) };
  const manifest = { schema: "heatlens-manifest/v1", snapshotId: id, modelVersion: payloads.overview.modelVersion,
    generatedAt: dataset.generatedAt, forecastDates: dataset.forecast.dates, overview: reference, states: { DE2: reference } };
  assert.throws(() => validateHeatlensManifest({ ...manifest, modelVersion: "future-model" }), /model version changed/);
  assert.throws(() => validateHeatlensManifest({ ...manifest, overview: { ...reference, url: "https://other.test/data.json" } }), /asset reference/);
  assert.throws(() => validateHeatlensManifest({ ...manifest, forecastDates: ["2026-10-20", "2026-10-22"] }), /date window/);
  let attempts = 0;
  const client = createHeatlensDataClient({ manifestUrl: "https://heatlens.test/data/manifest.json", retries: 1,
    fetchImpl: async () => { attempts += 1; throw new TypeError("Network unavailable"); } });
  await assert.rejects(client.checkManifest(), /Network unavailable/);
  assert.equal(attempts, 2);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.checkManifest({ signal: controller.signal }), { name: "AbortError" });
  assert.equal(attempts, 2);
});
