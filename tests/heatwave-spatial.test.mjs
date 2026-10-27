import test from "node:test";
import assert from "node:assert/strict";
import { createSpatialModel } from "../heatwave-spatial.js";
import { DEFAULT_CONTEXT, effectiveContext, matchesDefaultContext } from "../heatwave-data.js";
import { aggregatePredictions, buildLiveBasinPrediction } from "../heatwave-model.js";
import { createHeatlensPayloads } from "../scripts/build-heatlens-assets.mjs";

const date = "2026-07-20";
const point = (properties) => ({ type: "Feature", properties, geometry: { type: "Point", coordinates: [11, 49] } });
const collection = (features) => ({ type: "FeatureCollection", features });
const states = collection([point({ NUTS_ID: "DE1", CNTR_CODE: "DE", NAME_LATN: "First state" }),
  point({ NUTS_ID: "DE2", CNTR_CODE: "DE", NAME_LATN: "Second state" })]);
const districts = collection([point({ NUTS_ID: "DE111", NAME_LATN: "First county" }),
  point({ NUTS_ID: "DE222", NAME_LATN: "Second county" })]);
const basins = collection([point({ HYBAS_ID: 1, SUB_AREA: 100 }), point({ HYBAS_ID: 2, SUB_AREA: 100 })]);
const crosswalk = [
  { HYBAS_ID: 1, NUTS_ID: "DE111", overlap_km2: 80, district_area_km2: 100 },
  { HYBAS_ID: 2, NUTS_ID: "DE111", overlap_km2: 20, district_area_km2: 100 },
  { HYBAS_ID: 1, NUTS_ID: "DE222", overlap_km2: 20, district_area_km2: 100 },
  { HYBAS_ID: 2, NUTS_ID: "DE222", overlap_km2: 80, district_area_km2: 100 }
];
const day = {
  date, tmaxC: 30, tminC: 18, apparentMaxC: 32, precipitationMm: 1, precipitation1hMaxMm: 1,
  et0Mm: 4, vpdMaxKpa: 1.4, soilMoistureM3M3: 0.22, waterBalance3dMm: -10,
  heatPersistenceDays: 2, dryPersistenceDays: 5, completeness: 100,
  dwdNfkDominant30Pct: 70, dwdNfkDominant60Pct: 70, dwdNfkDominant90Pct: 70,
  dwdNfkMaize30Pct: 5, dwdNfkMaize60Pct: 5, dwdNfkMaize90Pct: 20
};
const dataset = { schema: "heatlens-live/v3", generatedAt: "2026-07-20T12:00:00Z", forecast: { dates: [date] },
  basins: [1, 2].map((id) => ({ id: String(id), context: {}, days: [{ ...day, tmaxC: day.tmaxC + id }] })) };
const overview = createHeatlensPayloads({ dataset, states, districts, basins, crosswalk }).overview;

function fixture(audience, { useOverview = true } = {}) {
  const state = {
    ...DEFAULT_CONTEXT, audience, date, stateFeatures: structuredClone(states.features),
    districtFeatures: structuredClone(districts.features), basinFeatures: structuredClone(basins.features),
    crosswalk: structuredClone(crosswalk), loadedStates: new Set(["DE1", "DE2"]),
    overview: useOverview ? overview : { profiles: overview.profiles },
    liveByBasin: new Map(dataset.basins.map((basin) => [basin.id, new Map([[date, basin.days[0]]])]))
  };
  for (const key of ["stateById", "districtById", "basinById", "basinsByDistrict", "basinsByState",
    "overlapsByDistrict", "overlapsByState", "districtProfile", "stateProfile", "predictionCache", "metricCache"]) state[key] = new Map();
  state.d3 = { geoCentroid: () => [11, 49] };
  const spatial = createSpatialModel({ state, featureId: (feature, level) => level === "basin"
    ? String(feature.properties.HYBAS_ID) : feature.properties.NUTS_ID,
    clamp: (value, minimum, maximum) => Math.min(Math.max(value, minimum), maximum) });
  spatial.assignSpatialHierarchy();
  return { state, ...spatial };
}

const custom = {
  crop: "maize", stage: "flowering", soil: "clay", farmGoal: "fieldAccess",
  plant: "establishedWoody", gardenSetting: "rainShadow", gardenSoil: "poorDrainage", gardenGoal: "waterlogging"
};

test("resident and municipal state, district and basin results ignore hidden farm and garden settings", () => {
  const predictions = dataset.basins.map((basin) => buildLiveBasinPrediction({ id: basin.id }, basin.days[0]));
  // This fixture reproduces the original bug: hidden maize values really would
  // change the result if passed straight through the model's optional context.
  assert.notEqual(aggregatePredictions(predictions, { audience: "residents" }).dryStressScore,
    aggregatePredictions(predictions, { audience: "residents", crop: "maize" }).dryStressScore);
  for (const audience of ["residents", "municipal"]) {
    for (const useOverview of [true, false]) {
      const model = fixture(audience, { useOverview });
      const units = [["state", "DE1"], ["district", "DE111"], ["basin", "1"]];
      const expected = units.map(([level, id]) => structuredClone(model.metricsForUnit(level, id)));
      Object.assign(model.state, custom);
      model.state.metricCache.clear();
      units.forEach(([level, id], index) => assert.deepEqual(model.metricsForUnit(level, id), expected[index],
        `${audience}/${useOverview ? "overview" : "computed"}/${level}`));
      for (const [key, value] of Object.entries(custom)) assert.equal(model.state[key], value, "hidden choices remain available when returning to their role");
      assert.deepEqual(effectiveContext(model.state), DEFAULT_CONTEXT);
      assert.equal(matchesDefaultContext(model.state), true);
    }
  }
});

test("active farm and garden choices are applied without inheriting the other role's hidden inputs", () => {
  for (const audience of ["farmers", "gardeners"]) {
    const model = fixture(audience);
    Object.assign(model.state, custom);
    const actual = model.metricsForUnit("district", "DE111");
    if (audience === "farmers") {
      assert.equal(actual.crop, custom.crop);
      assert.equal(actual.stage, custom.stage);
      assert.equal(actual.soil, custom.soil);
      assert.equal(actual.plant, DEFAULT_CONTEXT.plant);
      assert.equal(actual.gardenSetting, DEFAULT_CONTEXT.gardenSetting);
    } else {
      assert.equal(actual.plant, custom.plant);
      assert.equal(actual.gardenSetting, custom.gardenSetting);
      assert.equal(actual.gardenSoil, custom.gardenSoil);
      assert.equal(actual.crop, DEFAULT_CONTEXT.crop);
      assert.equal(actual.soil, DEFAULT_CONTEXT.soil);
    }
    assert.equal(matchesDefaultContext(model.state), false);
    for (const [key, value] of Object.entries(custom)) assert.equal(model.state[key], value);
  }
});

test("a cross-border basin keeps its global primary context regardless of loaded state order", () => {
  const model = fixture("residents");
  model.state.districtFeatures = model.state.districtFeatures.filter((feature) => feature.properties.NUTS_ID === "DE222");
  model.state.crosswalk = model.state.crosswalk.filter((record) => record.NUTS_ID === "DE222");
  model.assignSpatialHierarchy();
  assert.equal(model.state.basinById.get("1").__districtId, "DE111");
  assert.equal(model.state.basinById.get("1").__stateId, "DE1");
  assert.equal(model.state.basinById.get("2").__districtId, "DE222");
  assert.equal(model.state.overlapsByDistrict.get("DE222").length, 2);
});
