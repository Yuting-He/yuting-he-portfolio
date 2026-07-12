import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

test("bundled spatial layers have the expected Germany-wide coverage", async () => {
  const [states, districts, basins, crosswalk, manifest] = await Promise.all([
    readJson("../assets/nuts-rg-60m-2024-4326-levl-1.json"),
    readJson("../assets/nuts3-de.geojson"),
    readJson("../assets/hydrobasins-de-level8.geojson"),
    readJson("../assets/basin-nuts3-crosswalk.json"),
    readJson("../assets/spatial-data-manifest.json")
  ]);
  const stateObject = states.objects.NUTS_RG_60M_2024_4326;
  const germanStates = stateObject.geometries.filter((geometry) => geometry.properties.CNTR_CODE === "DE");
  assert.equal(germanStates.length, 16);
  assert.equal(districts.features.length, 400);
  assert.equal(basins.features.length, 614);
  assert.equal(crosswalk.length, manifest.crosswalk.records);
  assert.ok(crosswalk.length > 2000);
  assert.equal(manifest.crosswalk.basins, 614);
  assert.equal(manifest.crosswalk.districts, 400);
});

test("exact-area crosswalk references valid basin and district identifiers", async () => {
  const [districts, basins, crosswalk, manifest] = await Promise.all([
    readJson("../assets/nuts3-de.geojson"),
    readJson("../assets/hydrobasins-de-level8.geojson"),
    readJson("../assets/basin-nuts3-crosswalk.json"),
    readJson("../assets/spatial-data-manifest.json")
  ]);
  const districtIds = new Set(districts.features.map((feature) => feature.properties.NUTS_ID));
  const basinIds = new Set(basins.features.map((feature) => String(feature.properties.HYBAS_ID)));
  const crosswalkBasinIds = new Set(crosswalk.map((record) => String(record.HYBAS_ID)));
  const matched = crosswalk.filter((record) => record.NUTS_ID);
  assert.equal(basinIds.size, 614);
  assert.equal(crosswalkBasinIds.size + manifest.crosswalk.unmatched_basins.length, 614);
  assert.equal(new Set(crosswalk.map((record) => record.NUTS_ID)).size, 400);
  assert.equal(new Set(crosswalk.map((record) => record.NUTS_ID.slice(0, 3))).size, 16);
  assert.ok(matched.length > 2000);
  assert.ok(matched.every((record) => districtIds.has(record.NUTS_ID)));
  assert.ok(matched.every((record) => basinIds.has(String(record.HYBAS_ID))));
  assert.ok(matched.every((record) => record.overlap_km2 > 0 && record.basin_share > 0 && record.district_share > 0));
  assert.ok(matched.every((record) => record.basin_share <= 1.001 && record.district_share <= 1.001));
});

test("spatial manifest checksums match the published assets", async () => {
  const manifest = await readJson("../assets/spatial-data-manifest.json");
  for (const asset of manifest.assets) {
    const bytes = await readFile(new URL(`../${asset.path}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256);
  }
  const crosswalk = await readFile(new URL("../assets/basin-nuts3-crosswalk.json", import.meta.url));
  assert.equal(createHash("sha256").update(crosswalk).digest("hex"), manifest.crosswalk.sha256);
});
