import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AUDIENCES, MODEL_VERSION, aggregatePredictions, buildLiveBasinPrediction } from "../heatwave-model.js";
import { DEFAULT_CONTEXT } from "../heatwave-data.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const collection = (features) => ({ type: "FeatureCollection", features });
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

export function districtProfile(feature) {
  const name = String(feature.properties.NAME_LATN || feature.properties.NUTS_NAME || "");
  const city = /Kreisfreie Stadt|Stadtkreis|Berlin|Hamburg|Bremen/i.test(name);
  return { exposure: city ? 70 : 50, cropSensitivity: city ? 25 : 65 };
}

export function regionalMetrics(predictions, records, profile, audience) {
  const weighted = records.map((record) => {
    const prediction = predictions.get(String(record.HYBAS_ID));
    if (!prediction) throw new Error(`Missing basin prediction ${record.HYBAS_ID}`);
    return { ...prediction, area: record.overlap_km2 };
  });
  const metrics = aggregatePredictions(weighted, { audience, ...profile, ...DEFAULT_CONTEXT });
  const overlapArea = records.reduce((sum, record) => sum + record.overlap_km2, 0);
  const districtAreas = new Map(records.map((record) => [record.NUTS_ID, record.district_area_km2]));
  const targetArea = [...districtAreas.values()].reduce((sum, area) => sum + area, 0);
  metrics.spatialCoverage = Math.round(clamp(overlapArea / targetArea * 100, 0, 100));
  metrics.available = metrics.spatialCoverage >= 50 && metrics.completeness >= 85;
  if (!metrics.available) {
    for (const key of ["impactScore", "heatScore", "dryStressScore", "wetStressScore"]) metrics[key] = null;
  }
  return metrics;
}

export function createHeatlensPayloads({ dataset, states, districts, basins, crosswalk }) {
  if (dataset?.schema !== "heatlens-live/v3" || !dataset.forecast?.dates?.length || !dataset.basins?.length) {
    throw new Error("A validated HeatLens live/v3 snapshot is required to build assets");
  }
  const stateFeatures = states.features.filter((feature) => feature.properties.CNTR_CODE === "DE");
  const districtById = new Map(districts.features.map((feature) => [feature.properties.NUTS_ID, feature]));
  const basinById = new Map(basins.features.map((feature) => [String(feature.properties.HYBAS_ID), feature]));
  const liveById = new Map(dataset.basins.map((basin) => [String(basin.id), basin]));
  if (basinById.size !== liveById.size || [...basinById.keys()].some((id) => !liveById.has(id))) {
    throw new Error("Snapshot basins do not match the geometry");
  }
  for (const record of crosswalk) {
    if (!basinById.has(String(record.HYBAS_ID)) || !districtById.has(record.NUTS_ID) ||
        !(record.overlap_km2 > 0) || !(record.district_area_km2 > 0)) {
      throw new Error("Invalid exact-area spatial crosswalk");
    }
  }
  const { basins: ignoredBasins, ...metadata } = dataset;
  const identity = { modelVersion: MODEL_VERSION, generatedAt: dataset.generatedAt };
  const locations = [
    ...stateFeatures.map((feature) => ({ id: feature.properties.NUTS_ID, level: "state", stateId: feature.properties.NUTS_ID,
      name: feature.properties.NAME_LATN || feature.properties.NUTS_NAME })),
    ...districts.features.map((feature) => ({ id: feature.properties.NUTS_ID, level: "district", stateId: feature.properties.NUTS_ID.slice(0, 3),
      name: feature.properties.NAME_LATN || feature.properties.NUTS_NAME }))
  ];
  const primaryOverlap = new Map();
  for (const record of crosswalk) {
    const id = String(record.HYBAS_ID);
    if (!primaryOverlap.has(id) || record.overlap_km2 > primaryOverlap.get(id).overlap_km2) primaryOverlap.set(id, record);
  }
  const basinIndex = basins.features.map((feature) => {
    const id = String(feature.properties.HYBAS_ID);
    const record = primaryOverlap.get(id);
    return { id, stateId: record?.NUTS_ID.slice(0, 3) || null, districtId: record?.NUTS_ID || null };
  });
  const predictionsByDate = new Map(dataset.forecast.dates.map((date, index) => [date,
    new Map(dataset.basins.map((basin) => [String(basin.id), buildLiveBasinPrediction({ id: basin.id, properties: basinById.get(String(basin.id)).properties },
      { ...basin.context, ...basin.days[index] })]))]));
  const profiles = {};
  const metricsByState = {};
  const bundles = new Map();
  for (const stateFeature of stateFeatures) {
    const stateId = stateFeature.properties.NUTS_ID;
    const stateDistricts = districts.features.filter((feature) => feature.properties.NUTS_ID.startsWith(stateId));
    const records = crosswalk.filter((record) => record.NUTS_ID.startsWith(stateId));
    if (!records.length) throw new Error(`Missing exact overlap weights for ${stateId}`);
    const districtWeights = new Map();
    for (const record of records) districtWeights.set(record.NUTS_ID, (districtWeights.get(record.NUTS_ID) || 0) + record.overlap_km2);
    // Match the existing browser's district order, including floating-point sum order.
    const totalWeight = stateDistricts.reduce((sum, feature) => sum + (districtWeights.get(feature.properties.NUTS_ID) || 0), 0) || 1;
    profiles[stateId] = {
      exposure: stateDistricts.reduce((sum, feature) => sum + districtProfile(feature).exposure * (districtWeights.get(feature.properties.NUTS_ID) || 0), 0) / totalWeight,
      cropSensitivity: stateDistricts.reduce((sum, feature) => sum + districtProfile(feature).cropSensitivity * (districtWeights.get(feature.properties.NUTS_ID) || 0), 0) / totalWeight
    };
    metricsByState[stateId] = Object.fromEntries(Object.keys(AUDIENCES).map((audience) => [audience,
      Object.fromEntries([...predictionsByDate].map(([date, predictions]) => [date,
        regionalMetrics(predictions, records, profiles[stateId], audience)]))]));
    const basinIds = [...new Set(records.map((record) => String(record.HYBAS_ID)))];
    bundles.set(stateId, { schema: "heatlens-state/v1", ...identity, stateId,
      districts: collection(stateDistricts), basins: collection(basinIds.map((id) => basinById.get(id))),
      crosswalk: records, profiles: { [stateId]: profiles[stateId] },
      livePayload: { ...metadata, basins: basinIds.map((id) => liveById.get(id)) } });
  }
  const overview = { schema: "heatlens-overview/v1", ...identity, states: collection(stateFeatures),
    locations, basinIndex, metadata, defaultContext: DEFAULT_CONTEXT, profiles, metricsByState };
  // Hash the actual derived products: a builder change can never overwrite an
  // immutable URL even when the upstream snapshot and model version stay equal.
  const contentHash = digest(JSON.stringify({ overview, bundles: [...bundles] }));
  const snapshotId = `${dataset.generatedAt.replace(/\D/g, "").slice(0, 14)}-${contentHash.slice(0, 12)}`;
  overview.snapshotId = snapshotId;
  for (const payload of bundles.values()) payload.snapshotId = snapshotId;
  return { snapshotId, overview, bundles };
}

export async function buildHeatlensAssets({ root = ROOT, snapshotPath = resolve(root, "assets/live/forecast.json"),
  outputDirectory = resolve(root, "assets/live") } = {}) {
  const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
  const [dataset, states, districts, basins, crosswalk] = await Promise.all([
    readJson(snapshotPath), readJson(resolve(root, "assets/nuts1-de.geojson")), readJson(resolve(root, "assets/nuts3-de.geojson")),
    readJson(resolve(root, "assets/hydrobasins-de-level8.geojson")), readJson(resolve(root, "assets/basin-nuts3-crosswalk.json"))
  ]);
  const { snapshotId, overview, bundles } = createHeatlensPayloads({ dataset, states, districts, basins, crosswalk });
  const versionDirectory = resolve(outputDirectory, "snapshots", snapshotId);
  await mkdir(resolve(versionDirectory, "states"), { recursive: true });
  const writeAsset = async (relative, payload) => {
    const serialized = `${JSON.stringify(payload)}\n`;
    await writeFile(resolve(versionDirectory, relative), serialized, "utf8");
    return { url: `snapshots/${snapshotId}/${relative.replaceAll("\\", "/")}`,
      bytes: Buffer.byteLength(serialized), sha256: digest(serialized) };
  };
  const overviewReference = await writeAsset("overview.json", overview);
  const stateReferences = Object.fromEntries(await Promise.all([...bundles].map(async ([id, payload]) =>
    [id, await writeAsset(`states/${id}.json`, payload)])));
  const manifest = { schema: "heatlens-manifest/v1", snapshotId, modelVersion: MODEL_VERSION,
    generatedAt: dataset.generatedAt, forecastDates: dataset.forecast.dates,
    basinCount: dataset.basins.length, mappedBasinCount: new Set(crosswalk.map((record) => String(record.HYBAS_ID))).size,
    districtCount: districts.features.length,
    overview: overviewReference, states: stateReferences };
  const manifestPath = resolve(outputDirectory, "manifest.json");
  // Publish the pointer last: consumers can never discover half-written assets.
  await writeFile(`${manifestPath}.tmp`, `${JSON.stringify(manifest)}\n`, "utf8");
  await rename(`${manifestPath}.tmp`, manifestPath);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const manifest = await buildHeatlensAssets({ snapshotPath: process.argv[2] ? resolve(process.argv[2]) : undefined });
  console.log(`Built HeatLens ${manifest.snapshotId}: overview ${manifest.overview.bytes} bytes; ${Object.keys(manifest.states).length} regional bundles.`);
}
