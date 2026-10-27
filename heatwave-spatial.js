import { aggregatePredictions, buildLiveBasinPrediction } from "./heatwave-model.js";
import { effectiveContext, matchesDefaultContext } from "./heatwave-data.js";

// Exact-area aggregation stays separate from map display and request lifecycles.
export function createSpatialModel({ state, featureId, clamp }) {
function profileForDistrict(feature) {
  const name = String(feature.properties.NAME_LATN || feature.properties.NUTS_NAME || "");
  const city = /Kreisfreie Stadt|Stadtkreis|Berlin|Hamburg|Bremen/i.test(name);
  return {
    exposure: city ? 70 : 50,
    cropSensitivity: city ? 25 : 65
  };
}

function addToMap(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function assignSpatialHierarchy() {
  for (const collection of [state.stateById, state.districtById, state.basinById, state.basinsByDistrict,
    state.basinsByState, state.overlapsByDistrict, state.overlapsByState, state.districtProfile, state.stateProfile]) collection.clear();
  state.districtFeatures.forEach((feature) => {
    const id = featureId(feature, "district");
    feature.__centroid = state.d3.geoCentroid(feature);
    state.districtById.set(id, feature);
    state.districtProfile.set(id, profileForDistrict(feature));
  });

  state.basinFeatures.forEach((feature) => {
    const id = featureId(feature, "basin");
    feature.__centroid = state.d3.geoCentroid(feature);
    feature.__districtId = null;
    feature.__stateId = null;
    feature.__primaryOverlap = 0;
    state.basinById.set(id, feature);
  });

  const districtBasinIds = new Map();
  const stateBasinIds = new Map();
  state.crosswalk.forEach((record) => {
    const basinId = String(record.HYBAS_ID);
    const districtId = record.NUTS_ID;
    const stateId = districtId.slice(0, 3);
    const basin = state.basinById.get(basinId);
    if (!basin || !state.districtById.has(districtId) || !(record.overlap_km2 > 0)) return;
    addToMap(state.overlapsByDistrict, districtId, record);
    addToMap(state.overlapsByState, stateId, record);
    if (!districtBasinIds.has(districtId)) districtBasinIds.set(districtId, new Set());
    if (!stateBasinIds.has(stateId)) stateBasinIds.set(stateId, new Set());
    districtBasinIds.get(districtId).add(basinId);
    stateBasinIds.get(stateId).add(basinId);
    if (record.overlap_km2 > basin.__primaryOverlap) {
      basin.__primaryOverlap = record.overlap_km2;
      basin.__districtId = districtId;
      basin.__stateId = stateId;
    }
  });

  // Primary administrative context is global and must not depend on which
  // neighbouring state happened to finish loading first.
  for (const entry of state.overview?.basinIndex || []) {
    const basin = state.basinById.get(entry.id);
    if (basin) { basin.__districtId = entry.districtId; basin.__stateId = entry.stateId; }
  }
  districtBasinIds.forEach((ids, districtId) => {
    state.basinsByDistrict.set(districtId, [...ids].map((id) => state.basinById.get(id)));
  });
  stateBasinIds.forEach((ids, stateId) => {
    state.basinsByState.set(stateId, [...ids].map((id) => state.basinById.get(id)));
  });

  state.districtFeatures.forEach((district) => {
    const id = featureId(district, "district");
    if (!state.overlapsByDistrict.has(id)) throw new Error(`No hydrological overlap weights for ${id}`);
  });

  state.stateFeatures.forEach((feature) => {
    const id = featureId(feature, "state");
    state.stateById.set(id, feature);
    const profiles = state.districtFeatures
      .filter((district) => featureId(district, "district").startsWith(id))
      .map((district) => state.districtProfile.get(featureId(district, "district")));
    const districts = state.districtFeatures.filter((district) => featureId(district, "district").startsWith(id));
    const weights = districts.map((district) => (state.overlapsByDistrict.get(featureId(district, "district")) || [])
      .reduce((sum, record) => sum + record.overlap_km2, 0));
    const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;
    state.stateProfile.set(id, {
      exposure: profiles.reduce((sum, profile, index) => sum + profile.exposure * weights[index], 0) / totalWeight,
      cropSensitivity: profiles.reduce((sum, profile, index) => sum + profile.cropSensitivity * weights[index], 0) / totalWeight
    });
    if (state.overview?.profiles?.[id]) state.stateProfile.set(id, state.overview.profiles[id]);
  });
}

function predictionsForDate(date) {
  if (state.predictionCache.has(date)) return state.predictionCache.get(date);
  const predictions = new Map();
  state.basinFeatures.forEach((feature) => {
    const id = featureId(feature, "basin");
    const day = state.liveByBasin.get(id)?.get(date);
    if (day) predictions.set(id, buildLiveBasinPrediction({ id, properties: feature.properties }, day));
  });
  state.predictionCache.set(date, predictions);
  return predictions;
}

function profileForUnit(level, id) {
  if (level === "district") return state.districtProfile.get(id);
  if (level === "state") return state.stateProfile.get(id);
  return { exposure: 48, cropSensitivity: 64 };
}

function weightedPredictionsForUnit(level, id, date) {
  const predictionMap = predictionsForDate(date);
  if (level === "basin") {
    const prediction = predictionMap.get(id);
    return prediction ? [prediction] : [];
  }
  const records = level === "state" ? state.overlapsByState.get(id) : state.overlapsByDistrict.get(id);
  return (records || []).flatMap((record) => {
    const prediction = predictionMap.get(String(record.HYBAS_ID));
    return prediction ? [{ ...prediction, area: record.overlap_km2 }] : [];
  });
}

function metricsForUnit(level, id, date = state.date) {
  const overview = state.overview?.metricsByState?.[id]?.[state.audience]?.[date];
  if (level === "state" && overview && matchesDefaultContext(state)) return overview;
  if (level === "state" && overview && !state.loadedStates.has(id)) {
    return { ...overview, available: false, pending: true, impactScore: NaN,
      heatScore: NaN, dryStressScore: NaN, wetStressScore: NaN };
  }
  const context = effectiveContext(state);
  const contextKey = Object.values(context).join("|");
  const cacheKey = `${date}|${state.audience}|${contextKey}|${level}|${id}`;
  if (state.metricCache.has(cacheKey)) return state.metricCache.get(cacheKey);
  const predictions = weightedPredictionsForUnit(level, id, date);
  if (!predictions.length) throw new Error(`No live prediction values for ${level} ${id} on ${date}`);
  const profile = profileForUnit(level, id);
  const metrics = aggregatePredictions(predictions, {
    audience: state.audience,
    exposure: profile.exposure,
    cropSensitivity: profile.cropSensitivity,
    ...context
  });
  if (level === "basin") {
    metrics.spatialCoverage = 100;
  } else {
    const records = level === "state" ? state.overlapsByState.get(id) : state.overlapsByDistrict.get(id);
    const overlapArea = records.reduce((sum, record) => sum + record.overlap_km2, 0);
    const districtAreas = new Map(records.map((record) => [record.NUTS_ID, record.district_area_km2]));
    const targetArea = [...districtAreas.values()].reduce((sum, area) => sum + area, 0);
    metrics.spatialCoverage = Math.round(clamp(overlapArea / targetArea * 100, 0, 100));
  }
  metrics.available = metrics.spatialCoverage >= 50 && metrics.completeness >= 85;
  if (!metrics.available) {
    metrics.impactScore = Number.NaN;
    metrics.heatScore = Number.NaN;
    metrics.dryStressScore = Number.NaN;
    metrics.wetStressScore = Number.NaN;
  }
  state.metricCache.set(cacheKey, metrics);
  return metrics;
}

return { assignSpatialHierarchy, metricsForUnit };
}
