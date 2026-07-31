import {
  AUDIENCES,
  FIELD_CONTEXTS,
  LAYERS,
  MODEL_VERSION,
  actionsFor,
  aggregatePredictions,
  buildLiveBasinPrediction,
  evidenceConfidence,
  fillColor,
  freshnessStatus,
  scoreForLayer,
  severity
} from "./heatwave-model.js";
import {
  PLAIN_SOURCE_SUMMARY,
  plainActionCategory,
  plainActionsFor,
  plainConfidenceLabel,
  plainDecisionNote,
  plainLanguageSignals,
  plainLanguageSummary
} from "./heatwave-language.js";
import {
  DEFAULT_VIEW,
  isRetrospectiveDate,
  parseViewState,
  resolveForecastDate,
  runtimeSourceFreshness,
  serializeViewState,
  warningAppliesToDate
} from "./heatwave-state.js";

const STATE_URL = "./assets/nuts1-de.geojson";
const DISTRICT_URL = "./assets/nuts3-de.geojson";
const BASIN_URL = "./assets/hydrobasins-de-level8.geojson";
const CROSSWALK_URL = "./assets/basin-nuts3-crosswalk.json";
const LIVE_DATA_URL = "./assets/live/forecast.json";
const SVG_NS = "http://www.w3.org/2000/svg";
const initialView = parseViewState(window.location.search);

const state = {
  ...initialView,
  stateFeatures: [],
  districtFeatures: [],
  basinFeatures: [],
  stateById: new Map(),
  districtById: new Map(),
  basinById: new Map(),
  basinsByDistrict: new Map(),
  basinsByState: new Map(),
  overlapsByDistrict: new Map(),
  overlapsByState: new Map(),
  districtProfile: new Map(),
  stateProfile: new Map(),
  crosswalk: [],
  liveData: null,
  liveByBasin: new Map(),
  availableDates: [],
  freshness: { label: "Unavailable", className: "unavailable", ageHours: null, stale: true },
  sourceFreshness: { sources: {}, staleSources: [], stale: true },
  predictionCache: new Map(),
  metricCache: new Map(),
  d3: null,
  leaflet: null,
  mapInstance: null,
  riskLayer: null,
  scopeOverlay: null,
  featureLayers: new Map(),
  mapFrameKey: null,
  ready: false
};

const elements = {
  coverage: document.querySelector("#coverage-value"),
  selectedDateValue: document.querySelector("#selected-date-value"),
  predictionUnit: document.querySelector("#prediction-unit-value"),
  dataStatus: document.querySelector("#data-status-value"),
  dateInput: document.querySelector("#forecast-date"),
  previousDay: document.querySelector("#previous-day"),
  nextDay: document.querySelector("#next-day"),
  scopeLabel: document.querySelector("#scope-label"),
  mapTitle: document.querySelector("#map-title"),
  scopeBack: document.querySelector("#scope-back"),
  regionSelect: document.querySelector("#region-select"),
  map: document.querySelector("#heat-map"),
  mapStatus: document.querySelector("#map-status"),
  mapLegend: document.querySelector("#map-legend"),
  detailPanel: document.querySelector(".detail-panel"),
  selectedKind: document.querySelector("#selected-kind"),
  regionTitle: document.querySelector("#region-title"),
  riskLevel: document.querySelector("#risk-level"),
  regionSummary: document.querySelector("#region-summary"),
  signalHeading: document.querySelector("#signal-heading"),
  detailModeNote: document.querySelector("#detail-mode-note"),
  signalList: document.querySelector("#signal-list"),
  trend: document.querySelector("#risk-trend"),
  trendLayer: document.querySelector("#trend-layer-label"),
  confidence: document.querySelector("#confidence-label"),
  actionHeadingLabel: document.querySelector("#action-heading-label"),
  actionList: document.querySelector("#action-list"),
  decisionNote: document.querySelector("#decision-note"),
  plainSourceSummary: document.querySelector("#plain-source-summary"),
  provenanceList: document.querySelector("#provenance-list"),
  resolutionNote: document.querySelector("#resolution-note"),
  retryLoad: document.querySelector("#retry-load"),
  shareView: document.querySelector("#share-view"),
  exportView: document.querySelector("#export-view"),
  viewFeedback: document.querySelector("#view-feedback"),
  modelVersion: document.querySelector("#model-version")
};
elements.trendDescription = document.querySelector("#trend-svg-desc");
elements.trendTitle = document.querySelector("#trend-title");
elements.dateNote = document.querySelector("#scenario-date-note");
elements.liveStatusBadge = document.querySelector("#live-status-badge");
elements.liveStatusText = document.querySelector("#live-status-text");
elements.officialHeatTitle = document.querySelector("#official-heat-title");
elements.officialHeatDetail = document.querySelector("#official-heat-detail");
elements.officialRainTitle = document.querySelector("#official-rain-title");
elements.officialRainDetail = document.querySelector("#official-rain-detail");
elements.officialWarningHeading = document.querySelector("#official-warning-heading");
elements.forcingSource = document.querySelector("#forcing-source");
elements.sourceUpdated = document.querySelector("#source-updated");
elements.operationalStatus = document.querySelector("#operational-status");
elements.fieldContext = document.querySelector("#field-context");
elements.cropSelect = document.querySelector("#crop-profile");
elements.stageSelect = document.querySelector("#crop-stage");
elements.soilSelect = document.querySelector("#soil-profile");
elements.legendLabels = [...document.querySelectorAll("[data-legend-label]")];

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function profileForDistrict(feature) {
  const name = String(feature.properties.NAME_LATN || feature.properties.NUTS_NAME || "");
  const city = /Kreisfreie Stadt|Stadtkreis|Berlin|Hamburg|Bremen/i.test(name);
  return {
    exposure: city ? 70 : 50,
    cropSensitivity: city ? 25 : 65
  };
}

function featureId(feature, level) {
  if (level === "basin") return String(feature.properties.HYBAS_ID);
  return feature.properties.NUTS_ID;
}

function featureName(feature, level) {
  if (level === "basin") return `Sub-basin ${feature.properties.PFAF_ID || feature.properties.HYBAS_ID}`;
  return feature.properties.NAME_LATN || feature.properties.NUTS_NAME || feature.properties.NUTS_ID;
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${date}T00:00:00Z`));
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "unavailable";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin", timeZoneName: "short"
  }).format(date);
}

function freshnessText() {
  if (!Number.isFinite(state.freshness.ageHours)) return "source time unavailable";
  if (state.freshness.ageHours < 1) return "updated less than 1 hour ago";
  return `updated ${Math.floor(state.freshness.ageHours)} hours ago`;
}

function updateOperationalFreshness() {
  const snapshotFreshness = freshnessStatus(state.liveData.generatedAt);
  state.sourceFreshness = runtimeSourceFreshness(state.liveData.sourceFreshness);
  state.freshness = state.sourceFreshness.stale
    ? {
        ...snapshotFreshness,
        label: "Source stale",
        className: "stale",
        stale: true,
        sourceStale: true
      }
    : snapshotFreshness;
}

function staleSourceNames() {
  const names = {
    radolan: "RADOLAN",
    dwdTemperature: "DWD temperature",
    ufz: "UFZ soil",
    dwdSoil: "DWD soil"
  };
  return state.sourceFreshness.staleSources.map((source) => names[source] || source).join(", ");
}

function validateLivePayload(payload, basinFeatures) {
  if (payload?.schema !== "heatlens-live/v3") throw new Error("Live forecast schema unavailable");
  const dates = payload.forecast?.dates;
  if (!Array.isArray(dates) || !dates.length || dates.some((date, index) => !/^\d{4}-\d{2}-\d{2}$/.test(date) || index && date <= dates[index - 1])) {
    throw new Error("Live forecast date window is invalid");
  }
  if (!Array.isArray(payload.basins) || payload.basins.length !== basinFeatures.length) {
    throw new Error("Live forecast basin coverage is incomplete");
  }
  const generatedFreshness = freshnessStatus(payload.generatedAt);
  if (!Number.isFinite(generatedFreshness.ageHours) || generatedFreshness.ageHours < -2) {
    throw new Error("Live forecast generation time is invalid");
  }
  const sourceFreshness = payload.sourceFreshness?.sources;
  for (const source of ["radolan", "dwdTemperature", "ufz", "dwdSoil"]) {
    const status = sourceFreshness?.[source];
    if (!status?.current || !Number.isFinite(status.ageHoursAtGeneration) ||
        !Number.isFinite(status.maximumAgeHours) ||
        status.ageHoursAtGeneration < -2 ||
        status.ageHoursAtGeneration > status.maximumAgeHours) {
      throw new Error(`Live ${source} source is outside its freshness policy`);
    }
  }
  const geometryIds = new Set(basinFeatures.map((feature) => String(feature.properties.HYBAS_ID)));
  const payloadIds = new Set();
  for (const basin of payload.basins) {
    const basinId = String(basin.id);
    if (payloadIds.has(basinId)) throw new Error(`Duplicate live forecast basin ${basinId}`);
    payloadIds.add(basinId);
    if (!geometryIds.has(basinId) || basin.days?.map((day) => day.date).join() !== dates.join()) {
      throw new Error(`Live forecast does not align with basin ${basin.id}`);
    }
    if (!basin.context || !Number.isFinite(basin.context.ufzTopsoilSmi) ||
        !Number.isFinite(basin.context.radolanPrecipitation24hMm) ||
        !Number.isFinite(basin.context.dwdLatestTemperatureC)) {
      throw new Error(`Observed context is incomplete for basin ${basin.id}`);
    }
    if (basin.days.some((day) => day.completeness < 85)) {
      throw new Error(`Live forecast is incomplete for basin ${basin.id}`);
    }
  }
  return payload;
}

function addToMap(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function assignSpatialHierarchy() {
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
    if (!state.overlapsByState.has(id)) throw new Error(`No hydrological overlap weights for state ${id}`);
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
  const cacheKey = `${date}|${state.audience}|${state.crop}|${state.stage}|${state.soil}|${level}|${id}`;
  if (state.metricCache.has(cacheKey)) return state.metricCache.get(cacheKey);
  const predictions = weightedPredictionsForUnit(level, id, date);
  if (!predictions.length) throw new Error(`No live prediction values for ${level} ${id} on ${date}`);
  const profile = profileForUnit(level, id);
  const metrics = aggregatePredictions(predictions, {
    audience: state.audience,
    exposure: profile.exposure,
    cropSensitivity: profile.cropSensitivity,
    crop: state.crop,
    stage: state.stage,
    soil: state.soil
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

function visibleFeatures() {
  if (state.level === "state") return state.stateFeatures;
  if (state.level === "district") {
    return state.districtFeatures.filter((feature) => !state.selectedState || featureId(feature, "district").startsWith(state.selectedState));
  }
  if (state.selectedBasin && !state.basinById.get(state.selectedBasin)?.__districtId) {
    return [state.basinById.get(state.selectedBasin)];
  }
  if (state.selectedDistrict) return state.basinsByDistrict.get(state.selectedDistrict) || [];
  if (state.selectedState) return state.basinsByState.get(state.selectedState) || [];
  return state.basinFeatures;
}

function selectedUnit() {
  if (state.level === "basin" && state.selectedBasin) {
    return { level: "basin", id: state.selectedBasin, feature: state.basinById.get(state.selectedBasin) };
  }
  if (state.selectedDistrict) {
    return { level: "district", id: state.selectedDistrict, feature: state.districtById.get(state.selectedDistrict) };
  }
  return { level: "state", id: state.selectedState, feature: state.stateById.get(state.selectedState) };
}

function basinIntersectsDistrict(basinId, districtId) {
  if (!basinId || !districtId) return false;
  return (state.overlapsByDistrict.get(districtId) || [])
    .some((record) => String(record.HYBAS_ID) === String(basinId));
}

function validateSelection() {
  if (!state.stateById.has(state.selectedState)) state.selectedState = DEFAULT_VIEW.selectedState;
  if (state.selectedDistrict && !state.districtById.has(state.selectedDistrict)) state.selectedDistrict = null;
  if (state.selectedBasin && !state.basinById.has(state.selectedBasin)) state.selectedBasin = null;

  if (state.selectedBasin) {
    const basin = state.basinById.get(state.selectedBasin);
    if (!basinIntersectsDistrict(state.selectedBasin, state.selectedDistrict)) {
      state.selectedDistrict = basin.__districtId || null;
    }
    if (state.selectedDistrict) {
      state.selectedState = state.selectedDistrict.slice(0, 3);
    } else if (basin.__stateId) {
      state.selectedState = basin.__stateId;
    }
  } else if (state.selectedDistrict) {
    state.selectedState = state.selectedDistrict.slice(0, 3);
  }
  if (state.level === "state") {
    state.selectedDistrict = null;
    state.selectedBasin = null;
  } else if (state.level === "district") {
    state.selectedBasin = null;
  }
}

function persistViewState() {
  const query = serializeViewState(state);
  const next = `${window.location.pathname}?${query}${window.location.hash}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== next) {
    window.history.replaceState(null, "", next);
  }
}

let feedbackTimer = null;
function setViewFeedback(message) {
  window.clearTimeout(feedbackTimer);
  elements.viewFeedback.textContent = message;
  feedbackTimer = window.setTimeout(() => {
    elements.viewFeedback.textContent = "";
  }, 4000);
}

function scopeFeature() {
  if (state.level === "basin" && state.selectedDistrict) return state.districtById.get(state.selectedDistrict);
  if (state.level !== "state" && state.selectedState) return state.stateById.get(state.selectedState);
  return null;
}

function renderControls() {
  document.querySelectorAll("[data-level]").forEach((button) => {
    const active = button.dataset.level === state.level;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  document.querySelectorAll("[data-audience]").forEach((button) => {
    const active = button.dataset.audience === state.audience;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  document.querySelectorAll("[data-layer]").forEach((button) => {
    const active = button.dataset.layer === state.layer;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  document.querySelectorAll("[data-detail]").forEach((button) => {
    const active = button.dataset.detail === state.detail;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  elements.dateInput.value = state.date;
  elements.dateInput.min = state.availableDates[0];
  elements.dateInput.max = state.availableDates.at(-1);
  const dateIndex = state.availableDates.indexOf(state.date);
  elements.previousDay.disabled = dateIndex <= 0;
  elements.nextDay.disabled = dateIndex < 0 || dateIndex >= state.availableDates.length - 1;
  elements.dateNote.textContent = `${formatDate(state.availableDates[0])} - ${formatDate(state.availableDates.at(-1))}`;
  elements.fieldContext.hidden = state.audience !== "farmers";
  elements.cropSelect.value = state.crop;
  elements.stageSelect.value = state.stage;
  elements.soilSelect.value = state.soil;
}

function renderSummary() {
  const plain = state.detail === "plain";
  const technicalLegendLabels = {
    low: "Low 0-34",
    moderate: "Moderate 35-54",
    high: "High 55-74",
    "very-high": "Very high 75-100",
    unavailable: "Insufficient coverage"
  };
  const plainLegendLabels = {
    low: "Low",
    moderate: "Moderate",
    high: "High",
    "very-high": "Very high",
    unavailable: "Insufficient coverage"
  };
  elements.mapLegend.setAttribute("aria-label", plain ? "Risk level legend" : "Risk score legend");
  elements.legendLabels.forEach((label) => {
    const labels = plain ? plainLegendLabels : technicalLegendLabels;
    label.textContent = labels[label.dataset.legendLabel];
  });
  elements.coverage.textContent = plain
    ? `${state.stateFeatures.length} states with district and local detail`
    : `${state.stateFeatures.length} states / ${state.districtFeatures.length} NUTS-3 / ${state.basinFeatures.length} basins`;
  elements.selectedDateValue.textContent = formatDate(state.date);
  elements.predictionUnit.textContent = plain ? "Local drainage areas" : "HydroBASINS L8 / observed + EPS";
  elements.dataStatus.textContent = plain
    ? state.freshness.stale ? "Out of date - advice paused" : `Updated ${freshnessText()}`
    : `${state.freshness.label} - ${freshnessText()}`;
  elements.modelVersion.textContent = `v${MODEL_VERSION}`;
  elements.liveStatusBadge.textContent = plain
    ? state.freshness.stale ? "Data out of date" : "Data ready"
    : `${state.freshness.label} model feed`;
  elements.liveStatusBadge.className = `scenario-badge ${state.freshness.className}`;
  elements.liveStatusText.textContent = plain
    ? state.freshness.stale
      ? "Some data is too old for current advice. Scores remain visible for review, but actions are paused until the next valid update."
      : "Weather, rain, and soil-water data are current enough for this planning view. HeatLens is guidance, not an official warning."
    : state.freshness.stale
    ? state.freshness.sourceStale
      ? `${staleSourceNames()} exceeded the runtime freshness policy. Scores remain visible for audit, but suggested actions are suppressed.`
      : "The last valid forecast snapshot is older than 36 hours. Scores remain visible for audit, but suggested actions are suppressed."
    : `Snapshot ${freshnessText()}. Baselines: RADOLAN to ${formatTimestamp(state.liveData.observations.radolan.periodEnd)}, ` +
      `DWD temperature to ${formatTimestamp(state.liveData.observations.dwdTemperature.observedAt)}, ` +
      `UFZ ${formatDate(state.liveData.soilMoisture.ufz.validAt.slice(0, 10))}, and ` +
      `DWD soil ${formatDate(state.liveData.soilMoisture.dwd.validAt.slice(0, 10))}. ` +
      "HeatLens remains decision support, not an official warning.";
  elements.forcingSource.textContent = `${state.liveData.forecast.sourceModel} via Open-Meteo`;
  elements.sourceUpdated.textContent = formatTimestamp(state.liveData.generatedAt);
  elements.operationalStatus.textContent = state.freshness.stale
    ? state.freshness.sourceStale
      ? "Source freshness limit exceeded - actions suppressed"
      : "Stale snapshot - actions suppressed"
    : "Live model data - screening only";
}

function updateRegionSelect(features) {
  const options = features
    .map((feature) => ({ id: featureId(feature, state.level), name: featureName(feature, state.level) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const selected = state.level === "state" ? state.selectedState : state.level === "district" ? state.selectedDistrict : state.selectedBasin;
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = `Choose ${state.level === "district" ? "district / urban district" : state.level}`;
  const nodes = options.map((option) => {
    const node = document.createElement("option");
    node.value = option.id;
    node.textContent = option.name;
    node.selected = option.id === selected;
    return node;
  });
  elements.regionSelect.replaceChildren(placeholder, ...nodes);
}

function selectMapUnit(level, id, drill = false) {
  if (level === "state") {
    state.selectedState = id;
    state.selectedDistrict = null;
    state.selectedBasin = null;
    if (drill) state.level = "district";
  } else if (level === "district") {
    state.selectedDistrict = id;
    state.selectedState = id.slice(0, 3);
    state.selectedBasin = null;
  } else {
    const basin = state.basinById.get(id);
    state.selectedBasin = id;
    if (!basinIntersectsDistrict(id, state.selectedDistrict)) {
      if (basin.__districtId) state.selectedDistrict = basin.__districtId;
      if (basin.__stateId) state.selectedState = basin.__stateId;
    }
  }
  renderAll();
}

function initializeMap() {
  if (state.mapInstance) return;
  const leaflet = globalThis.L;
  if (!leaflet?.map || !leaflet?.tileLayer || !leaflet?.geoJSON) {
    throw new Error("Bundled Leaflet library unavailable");
  }
  state.leaflet = leaflet;
  state.mapInstance = leaflet.map(elements.map, {
    attributionControl: true,
    keyboard: true,
    minZoom: 5,
    maxZoom: 14,
    preferCanvas: true,
    scrollWheelZoom: true,
    zoomControl: true,
    zoomSnap: 0.25
  });
  const tiles = leaflet.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
    noWrap: true
  });
  tiles.on("tileerror", () => elements.map.classList.add("basemap-unavailable"));
  tiles.on("tileload", () => elements.map.classList.remove("basemap-unavailable"));
  tiles.addTo(state.mapInstance);
  leaflet.control.scale({ imperial: false, maxWidth: 130 }).addTo(state.mapInstance);
}

function selectedMapId() {
  if (state.level === "state") return state.selectedState;
  if (state.level === "district") return state.selectedDistrict;
  return state.selectedBasin;
}

function mapStyle(feature) {
  const id = featureId(feature, state.level);
  const score = scoreForLayer(metricsForUnit(state.level, id), state.layer);
  const active = id === selectedMapId();
  const baseWeight = state.level === "state" ? 1.5 : state.level === "district" ? 1.15 : 0.9;
  const baseOpacity = state.level === "state" ? 0.52 : state.level === "district" ? 0.44 : 0.38;
  return {
    color: active ? "#081a23" : "#f9fbfb",
    fillColor: fillColor(score),
    fillOpacity: active ? 0.72 : baseOpacity,
    lineCap: "round",
    lineJoin: "round",
    opacity: active ? 1 : 0.9,
    weight: active ? 3.2 : baseWeight
  };
}

function tooltipContent(feature) {
  const id = featureId(feature, state.level);
  const score = scoreForLayer(metricsForUnit(state.level, id), state.layer);
  const level = severity(score);
  const scoreLabel = Number.isFinite(score) ? score : "no score";
  const content = document.createElement("span");
  const name = document.createElement("strong");
  const detail = document.createElement("span");
  name.textContent = featureName(feature, state.level);
  detail.textContent = state.detail === "plain"
    ? `${level.label} concern`
    : `${LAYERS[state.layer]}: ${level.label} ${scoreLabel}`;
  content.append(name, detail);
  return content;
}

function frameKey() {
  if (state.level === "state") return "state:germany";
  if (state.level === "district") return `district:${state.selectedState || "germany"}`;
  return `basin:${state.selectedDistrict || state.selectedState || "germany"}`;
}

function rebuildMapLayers(features, nextFrameKey) {
  const leaflet = state.leaflet;
  if (state.riskLayer) state.mapInstance.removeLayer(state.riskLayer);
  if (state.scopeOverlay) state.mapInstance.removeLayer(state.scopeOverlay);
  state.featureLayers.clear();
  const featureLevel = state.level;
  state.riskLayer = leaflet.geoJSON({ type: "FeatureCollection", features }, {
    style: mapStyle,
    onEachFeature: (feature, layer) => {
      const id = featureId(feature, featureLevel);
      layer.bindTooltip(tooltipContent(feature), { className: "heat-map-tooltip", direction: "top", sticky: true });
      layer.on("click", () => selectMapUnit(featureLevel, id, featureLevel === "state"));
      state.featureLayers.set(id, layer);
    }
  }).addTo(state.mapInstance);
  const scope = scopeFeature();
  if (scope) {
    state.scopeOverlay = leaflet.geoJSON(scope, {
      interactive: false,
      style: { color: "#142b38", fill: false, opacity: 0.88, weight: 3 }
    }).addTo(state.mapInstance);
  } else {
    state.scopeOverlay = null;
  }
  const bounds = state.scopeOverlay?.getBounds() || state.riskLayer.getBounds();
  if (bounds.isValid()) {
    const fitOptions = {
      animate: false,
      maxZoom: state.level === "state" ? 6.5 : state.level === "district" ? 8.5 : 10.5,
      padding: [18, 18]
    };
    const fitCurrentFrame = () => {
      state.mapInstance.invalidateSize({ animate: false, pan: false });
      state.mapInstance.fitBounds(bounds, fitOptions);
    };
    fitCurrentFrame();
    window.requestAnimationFrame(fitCurrentFrame);
  }
  state.mapFrameKey = nextFrameKey;
}

function renderMap() {
  const features = visibleFeatures();
  const nextFrameKey = frameKey();
  if (!state.riskLayer || state.mapFrameKey !== nextFrameKey) {
    rebuildMapLayers(features, nextFrameKey);
  } else {
    state.featureLayers.forEach((layer, id) => {
      layer.setStyle(mapStyle(layer.feature));
      layer.setTooltipContent(tooltipContent(layer.feature));
      if (id === selectedMapId()) layer.bringToFront();
    });
  }
  updateRegionSelect(features);

  const stateName = state.selectedState ? featureName(state.stateById.get(state.selectedState), "state") : "Germany";
  if (state.level === "state") {
    elements.scopeLabel.textContent = "National overview";
    elements.mapTitle.textContent = "Germany - states";
  } else if (state.level === "district") {
    elements.scopeLabel.textContent = "NUTS-3 administrative response layer";
    elements.mapTitle.textContent = `${stateName} - districts and urban districts`;
  } else {
    const districtName = state.selectedDistrict ? featureName(state.districtById.get(state.selectedDistrict), "district") : stateName;
    elements.scopeLabel.textContent = "Hydrological prediction layer";
    elements.mapTitle.textContent = `${districtName} - sub-basins`;
  }
  elements.scopeBack.hidden = state.level === "state";
  elements.scopeBack.textContent = state.level === "basin" && state.selectedDistrict ? "\u2190 District" : "\u2190 Germany";
  const unitLabel = state.level === "district" ? "district / urban-district regions" : `${state.level}s`;
  elements.mapStatus.textContent = `${features.length} visible ${unitLabel} for ${formatDate(state.date)} over OpenStreetMap.`;
  elements.map.setAttribute("aria-label", `${LAYERS[state.layer]} for ${formatDate(state.date)}. ${features.length} visible ${unitLabel}.`);
}

function appendSignal(label, value) {
  const row = document.createElement("div");
  row.className = "signal-row";
  const key = document.createElement("span");
  key.textContent = label;
  const data = document.createElement("strong");
  data.textContent = value;
  row.append(key, data);
  return row;
}

function renderTrend(unit) {
  const dates = state.availableDates;
  const values = dates.map((date) => scoreForLayer(metricsForUnit(unit.level, unit.id, date), state.layer));
  const width = 360;
  const height = 116;
  const padding = { left: 25, right: 10, top: 10, bottom: 22 };
  const x = (index) => padding.left + index * ((width - padding.left - padding.right) / (dates.length - 1));
  const y = (value) => padding.top + (100 - value) * ((height - padding.top - padding.bottom) / 100);
  const nodes = [];

  if (values.some((value) => !Number.isFinite(value))) {
    elements.trend.replaceChildren();
    elements.trendLayer.textContent = "Insufficient spatial coverage";
    elements.trendDescription.textContent = "No trend is shown because less than half of the selected region intersects the bundled hydrological geometry.";
    return;
  }

  [35, 55, 75].forEach((value) => {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", padding.left);
    line.setAttribute("x2", width - padding.right);
    line.setAttribute("y1", y(value));
    line.setAttribute("y2", y(value));
    line.setAttribute("class", "trend-grid");
    nodes.push(line);
  });

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", values.map((value, index) => `${index === 0 ? "M" : "L"}${x(index)},${y(value)}`).join(" "));
  path.setAttribute("class", "trend-line");
  nodes.push(path);

  values.forEach((value, index) => {
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", x(index));
    dot.setAttribute("cy", y(value));
    dot.setAttribute("r", dates[index] === state.date ? 4.5 : 3);
    dot.setAttribute("class", `trend-dot${dates[index] === state.date ? " is-active" : ""}`);
    const title = document.createElementNS(SVG_NS, "title");
    title.textContent = state.detail === "plain"
      ? `${formatDate(dates[index])}: ${severity(value).label} concern`
      : `${formatDate(dates[index])}: ${value}`;
    dot.append(title);
    nodes.push(dot);
  });

  [0, dates.indexOf(state.date), dates.length - 1].filter((value, index, array) => value >= 0 && array.indexOf(value) === index).forEach((index) => {
    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", x(index));
    label.setAttribute("y", height - 5);
    label.setAttribute("text-anchor", index === 0 ? "start" : index === dates.length - 1 ? "end" : "middle");
    label.setAttribute("class", "trend-label");
    label.textContent = dates[index].slice(5).replace("-", "/");
    nodes.push(label);
  });
  elements.trend.replaceChildren(...nodes);
  elements.trendLayer.textContent = state.detail === "plain" ? "Selected concern" : LAYERS[state.layer];
  elements.trendTitle.textContent = state.detail === "plain" ? "How the situation may change" : `${dates.length}-day risk profile`;
  const peak = Math.max(...values);
  const peakIndex = values.indexOf(peak);
  const currentIndex = dates.indexOf(state.date);
  elements.trendDescription.textContent = state.detail === "plain"
    ? `Concern ranges from ${severity(Math.min(...values)).label.toLowerCase()} to ${severity(peak).label.toLowerCase()}. The highest level occurs on ${formatDate(dates[peakIndex])}; the selected date is ${severity(values[currentIndex]).label.toLowerCase()}.`
    : `${LAYERS[state.layer]} ranges from ${Math.min(...values)} to ${peak}. Peak ${peak} on ${formatDate(dates[peakIndex])}; selected date ${formatDate(state.date)} is ${values[currentIndex]}.`;
}

function stateIdForUnit(unit) {
  if (unit.level === "state") return unit.id;
  if (unit.level === "district") return unit.id.slice(0, 3);
  return unit.feature.__stateId || state.selectedState;
}

function warningContextForUnit(unit) {
  const warningFeed = state.liveData.warnings;
  const stateId = stateIdForUnit(unit);
  return warningFeed.states?.[stateId] || { heatWarningCount: 0, rainWarningCount: 0, warnings: [] };
}

function renderOfficialWarning(unit) {
  const warningFeed = state.liveData.warnings;
  const regionWarnings = warningContextForUnit(unit);
  const currentModelDate = state.availableDates[state.liveData.forecast.pastDays];
  const isRetrospective = isRetrospectiveDate(state.date, currentModelDate);
  const plain = state.detail === "plain";
  elements.officialWarningHeading.textContent = isRetrospective
    ? "Current authoritative context - not a warning archive"
    : "Current authoritative context";
  const contextPrefix = isRetrospective
    ? `Current feed issued ${formatTimestamp(warningFeed.issuedAt)}; retrospective coverage may be incomplete for ${formatDate(state.date)}. `
    : "";
  if (warningFeed.status !== "available") {
    elements.officialHeatTitle.textContent = plain ? "Official warning feed unavailable" : "DWD feed unavailable";
    elements.officialHeatDetail.textContent = plain
      ? "Open the official weather-warning service before making a protective decision."
      : "Open the official DWD service before making a protective decision.";
    elements.officialRainTitle.textContent = "Rain warning context unavailable";
    elements.officialRainDetail.textContent = "Check DWD and the responsible state flood portal directly.";
    return;
  }
  const heatWarnings = (regionWarnings?.warnings || [])
    .filter((warning) => warning.isHeat && warningAppliesToDate(warning, state.date));
  if (heatWarnings.length) {
    elements.officialHeatTitle.textContent = heatWarnings[0].event || "Active DWD heat warning";
    elements.officialHeatDetail.textContent = `${contextPrefix}${heatWarnings[0].regionName}: ${heatWarnings[0].headline || "See DWD for details"}.`;
  } else {
    elements.officialHeatTitle.textContent = plain
      ? "No official heat warning overlaps the selected date"
      : "No published DWD heat warning overlaps the selected date";
    elements.officialHeatDetail.textContent = isRetrospective
      ? "The current feed is not a warning archive for this retrospective date."
      : "The current feed does not cover the full forecast horizon; this is not an all-clear.";
  }
  const rainWarnings = (regionWarnings?.warnings || [])
    .filter((warning) => warning.isRain && warningAppliesToDate(warning, state.date));
  if (rainWarnings.length) {
    elements.officialRainTitle.textContent = rainWarnings[0].event || "Active DWD rain warning";
    elements.officialRainDetail.textContent = `${contextPrefix}${rainWarnings[0].regionName}: ${rainWarnings[0].headline || "See DWD for details"}.`;
  } else {
    elements.officialRainTitle.textContent = plain
      ? "No official rain warning overlaps the selected date"
      : "No published DWD rain warning overlaps the selected date";
    elements.officialRainDetail.textContent = plain
      ? `The current feed was issued ${formatTimestamp(warningFeed.issuedAt)} and may not cover later dates. For river flooding, check the state flood service directly; this map does not predict flood probability.`
      : `Feed issued ${formatTimestamp(warningFeed.issuedAt)} and does not cover the full forecast horizon. River flooding requires state flood-portal information; the wet index is not a flood probability.`;
  }
}

function smiClass(value) {
  if (!Number.isFinite(value)) return "unavailable";
  if (value <= 0.02) return "exceptional drought";
  if (value <= 0.05) return "extreme drought";
  if (value <= 0.1) return "severe drought";
  if (value <= 0.2) return "moderate drought";
  if (value <= 0.3) return "unusual dryness";
  if (value >= 0.98) return "exceptionally wet";
  if (value >= 0.95) return "extremely wet";
  if (value >= 0.9) return "severely wet";
  if (value >= 0.8) return "moderately wet";
  if (value >= 0.7) return "unusually wet";
  return "normal range";
}

function observationText(metrics) {
  if (Number.isFinite(metrics.dwdObservedTmaxC)) {
    const kind = metrics.dwdObservationKind === "complete-day" ? "complete-day" : "day-so-far";
    const bias = metrics.temperatureValidationBiasC;
    const comparison = kind === "complete-day" ? "model bias" : "provisional forecast gap";
    const comparisonText = Number.isFinite(bias)
      ? `${comparison} ${bias >= 0 ? "+" : ""}${bias} °C`
      : "validation comparison unavailable";
    if (metrics.basinCount === 1) {
      const station = metrics.dwdStationName ? ` ${metrics.dwdStationName}` : "";
      const distance = Number.isFinite(metrics.dwdStationDistanceKm) ? ` | ${metrics.dwdStationDistanceKm} km away` : "";
      return `DWD${station} ${kind} Tmax ${metrics.dwdObservedTmaxC} °C | ${comparisonText}${distance}`;
    }
    const errorLabel = kind === "complete-day" ? "MAE" : "provisional absolute gap";
    const coverage = metrics.dwdObservedStationCount
      ? ` | ${metrics.dwdObservedStationCount} stations, farthest match ${metrics.dwdStationMaxDistanceKm} km`
      : "";
    const errorText = Number.isFinite(metrics.temperatureValidationMaeC)
      ? ` | ${errorLabel} ${metrics.temperatureValidationMaeC} °C`
      : "";
    return `DWD matched-station ${kind} Tmax ${metrics.dwdObservedTmaxC} °C, basin-weighted | ${comparisonText}${errorText}${coverage}`;
  }
  if (!Number.isFinite(metrics.dwdLatestTemperatureC) || !Number.isFinite(Date.parse(metrics.dwdObservedAt))) {
    return `No DWD matched-station temperature observation is valid for ${formatDate(state.date)}`;
  }
  if (metrics.basinCount === 1) {
    const distance = Number.isFinite(metrics.dwdStationDistanceKm) ? ` | ${metrics.dwdStationDistanceKm} km away` : "";
    return `latest DWD ${metrics.dwdStationName || "matched station"} temperature ${metrics.dwdLatestTemperatureC} °C at ${formatTimestamp(metrics.dwdObservedAt)}${distance}`;
  }
  const farthestMatch = Number.isFinite(metrics.dwdStationMaxDistanceKm)
    ? ` | farthest basin-station match ${metrics.dwdStationMaxDistanceKm} km`
    : "";
  return `latest DWD network temperature maximum ${metrics.dwdLatestTemperatureC} °C at ${formatTimestamp(metrics.dwdObservedAt)}${farthestMatch}`;
}

function ensembleText(metrics) {
  if (!Number.isFinite(metrics.ensemblePeakHourTemperatureSdC)) {
    return "No ICON ensemble-member dispersion is published for this retrospective date";
  }
  return `${metrics.ensembleModel} (${metrics.ensembleMemberCount} members) | member SD at hottest mean hour ${metrics.ensemblePeakHourTemperatureSdC} °C | max hourly precipitation member SD ${metrics.ensembleMaxHourlyPrecipitationSdMm} mm`;
}

function ufzText(metrics) {
  if (!Number.isFinite(metrics.ufzTopsoilSmi) || !Number.isFinite(metrics.ufzTotalSmi)) {
    return "No UFZ baseline is valid for this retrospective date";
  }
  const validDate = formatDate(state.liveData.soilMoisture.ufz.validAt.slice(0, 10));
  return `baseline ${validDate}: topsoil SMI ${metrics.ufzTopsoilSmi} (${smiClass(metrics.ufzTopsoilSmi)}) | total-soil SMI ${metrics.ufzTotalSmi} (${smiClass(metrics.ufzTotalSmi)})`;
}

function radolanText(metrics) {
  if (!Number.isFinite(metrics.radolanPrecipitation24hMm)) {
    return "No RADOLAN baseline is valid for this retrospective date";
  }
  const radolan = state.liveData.observations.radolan;
  return `${metrics.radolanPrecipitation24hMm} mm / rolling 24 h ending ${formatTimestamp(radolan.periodEnd)} | forecast ${metrics.precipitationMm} mm/day`;
}

function renderDetails() {
  const unit = selectedUnit();
  const metrics = metricsForUnit(unit.level, unit.id);
  const score = scoreForLayer(metrics, state.layer);
  const level = severity(score);
  const plain = state.detail === "plain";
  const kind = unit.level === "district" ? "district / urban district" : unit.level === "basin" ? "sub-basin" : "state";

  elements.signalHeading.textContent = plain ? "What this means" : "Technical evidence";
  elements.detailPanel.classList.toggle("is-plain", plain);
  elements.detailModeNote.textContent = plain ? "Plain language" : "Exact values and sources";
  elements.plainSourceSummary.textContent = PLAIN_SOURCE_SUMMARY;
  elements.plainSourceSummary.hidden = !plain;
  elements.provenanceList.hidden = plain;
  elements.selectedKind.textContent = `Selected ${kind}`;
  elements.regionTitle.textContent = featureName(unit.feature, unit.level);
  elements.riskLevel.textContent = plain ? level.label : `${level.label} ${score}`;
  elements.riskLevel.className = `risk-level ${level.className}`;
  renderOfficialWarning(unit);
  if (!metrics.available) {
    elements.riskLevel.textContent = "Unavailable";
    if (plain) {
      elements.regionSummary.textContent = "There is not enough reliable local information to translate this area into a decision signal.";
      elements.signalList.replaceChildren(
        appendSignal("What is missing", metrics.spatialCoverage < 50
          ? "Too little of this area matches the local drainage-area map."
          : "Too many of the required data inputs are missing."),
        appendSignal("What HeatLens does", "It hides the risk result and action suggestions instead of filling the gap with nearby values."),
        appendSignal("What to do", "Use current official information and observations from the selected area.")
      );
    } else {
      const coverageReason = metrics.spatialCoverage < 50
        ? `the exact basin overlay covers only ${metrics.spatialCoverage}% of this region`
        : `source completeness is only ${metrics.completeness}%`;
      elements.regionSummary.textContent = `${formatDate(state.date)} has no score because ${coverageReason}.`;
      elements.signalList.replaceChildren(
        appendSignal("Spatial coverage", `${metrics.spatialCoverage}% exact overlap`),
        appendSignal("Source completeness", `${metrics.completeness}%`),
        appendSignal("Status", "Risk and action outputs suppressed"),
        appendSignal("Official source", "Use DWD and the responsible local authority")
      );
    }
    elements.actionList.replaceChildren();
    elements.actionHeadingLabel.textContent = "Suggested next actions";
    elements.confidence.textContent = plain ? "Not enough local information" : "Insufficient input coverage";
    elements.decisionNote.textContent = plain
      ? "HeatLens does not guess when coverage is too low. Check the official services and local conditions directly."
      : "HeatLens fails closed below 50% spatial coverage or 85% source completeness; it does not substitute nearby values.";
    renderTrend(unit);
    return;
  }
  const warningContext = warningContextForUnit(unit);
  const datedWarnings = (warningContext.warnings || [])
    .filter((warning) => warningAppliesToDate(warning, state.date));
  const currentModelDate = state.availableDates[state.liveData.forecast.pastDays];
  const isRetrospective = isRetrospectiveDate(state.date, currentModelDate);
  const guidance = actionsFor(metrics, state.audience, {
    heatWarningCount: datedWarnings.filter((warning) => warning.isHeat).length,
    rainWarningCount: datedWarnings.filter((warning) => warning.isRain).length
  });
  const plainActions = plainActionsFor(metrics, state.audience, {
    heatWarningCount: datedWarnings.filter((warning) => warning.isHeat).length,
    rainWarningCount: datedWarnings.filter((warning) => warning.isRain).length
  });
  const confidence = evidenceConfidence(metrics);
  const dwdSoilDate = formatDate(state.liveData.soilMoisture.dwd.validAt.slice(0, 10));
  const fieldSignal = Number.isFinite(metrics.dwdNfkPct)
    ? `baseline ${dwdSoilDate}: ${metrics.cropLabel}, mean ${metrics.dwdNfkPct}% nFK across 10 cm layers to ${metrics.rootDepthCm} cm | ${metrics.dwdNfkCoveragePct}% area coverage | ${metrics.soilLabel}`
    : `${metrics.cropLabel}: DWD nFK baseline unavailable or below 85% area coverage (${metrics.dwdNfkCoveragePct}%) | ${metrics.soilLabel}`;
  elements.regionSummary.textContent = plain
    ? plainLanguageSummary(metrics, state.audience, state.layer, {
        regionName: featureName(unit.feature, unit.level),
        dateLabel: formatDate(state.date),
        stale: state.freshness.stale,
        isRetrospective
      })
    : `${AUDIENCES[state.audience]} screening estimate for ${formatDate(state.date)}: ${level.label.toLowerCase()} ${LAYERS[state.layer].toLowerCase()} based on ${metrics.basinCount} contributing sub-basin${metrics.basinCount === 1 ? "" : "s"}.`;
  const signals = plain
    ? plainLanguageSignals(metrics, state.audience, state.layer, { stale: state.freshness.stale, isRetrospective })
        .map((signal) => appendSignal(signal.label, signal.text))
    : [
        appendSignal("Thermal forecast", `Tmax ${metrics.tmaxC} \u00b0C | feels-like max ${metrics.apparentMaxC} \u00b0C | Tmin ${metrics.tminC} \u00b0C`),
        appendSignal("Measured check", observationText(metrics)),
        appendSignal("Ensemble dispersion", ensembleText(metrics)),
        appendSignal("UFZ percentile baseline", ufzText(metrics)),
        appendSignal("Plant-water baseline", `${Number.isFinite(metrics.ufzPlantAvailableWaterPct) ? `UFZ ${metrics.ufzPlantAvailableWaterPct}% nFK | ` : ""}${fieldSignal}`),
        appendSignal("Water forecast", `root-zone ${metrics.soilMoistureM3M3} m\u00b3/m\u00b3 | 3-day P-ET0 ${metrics.waterBalance3dMm} mm | ET0 ${metrics.et0Mm} mm/day`),
        appendSignal("RADOLAN baseline", radolanText(metrics)),
        appendSignal("Water screening", `dry ${metrics.dryStressScore}/100 | excess water ${metrics.wetStressScore}/100`),
        appendSignal("Evidence quality", `${confidence.score}/100 ${confidence.label.toLowerCase()} | ${metrics.completeness}% forcing completeness | ${metrics.spatialCoverage}% exact overlap`)
      ];
  elements.signalList.replaceChildren(...signals);
  const historicalInterpretation = plain ? [
    {
      category: "Retrospective",
      text: `${formatDate(state.date)} is a past-date reconstruction. It describes signals for that date and is not advice for today.`
    },
    {
      category: "Validate",
      text: "Compare it with archived official warnings, local measurements, and recorded outcomes before drawing conclusions."
    }
  ] : [
    {
      category: "Retrospective",
      text: `${formatDate(state.date)} is a historical screening reconstruction. It describes the dated heat and soil-water signals shown above; it is not current action guidance.`
    },
    {
      category: "Validate",
      text: "Compare the dated DWD station and RADOLAN observations with archived official warnings, local measurements, and recorded outcomes before drawing conclusions."
    }
  ];
  elements.actionHeadingLabel.textContent = isRetrospective ? "Historical interpretation" : "Suggested next actions";
  const actions = isRetrospective
    ? historicalInterpretation
    : state.freshness.stale
      ? []
      : plain
        ? plainActions
        : guidance.actions;
  elements.actionList.replaceChildren(...actions.map((action) => {
    const item = document.createElement("li");
    const category = document.createElement("strong");
    category.textContent = plain ? plainActionCategory(action.category) : action.category;
    const text = document.createElement("span");
    text.textContent = action.text;
    item.append(category, text);
    return item;
  }));
  elements.confidence.textContent = plain
    ? plainConfidenceLabel(metrics, { stale: state.freshness.stale, isRetrospective })
    : `${confidence.label} ${confidence.score}/100`;
  elements.decisionNote.textContent = plain
    ? plainDecisionNote(state.audience, { isRetrospective, stale: state.freshness.stale })
    : isRetrospective
    ? "Historical views support review and model evaluation only. They must not be read as present-day resident, farm, or municipal instructions; the current DWD feed is not a warning archive."
    : state.freshness.stale
    ? state.freshness.sourceStale
      ? `Suggested actions are suppressed because ${staleSourceNames()} exceeded the runtime freshness limit. Check current official and local sources.`
      : "Suggested actions are suppressed because the last valid source snapshot is stale. Check DWD and local official channels."
    : guidance.note;
  renderTrend(unit);
}

function renderResolutionNote() {
  if (state.detail === "plain") {
    if (state.level === "basin") {
      elements.resolutionNote.textContent = "This local view follows a drainage area rather than an administrative boundary.";
    } else if (state.level === "district") {
      elements.resolutionNote.textContent = "District colors combine smaller drainage areas, so conditions can still differ within a district.";
    } else {
      elements.resolutionNote.textContent = "State colors are broad overviews. Choose a district or local drainage area for more detail.";
    }
    return;
  }
  if (state.level === "basin") {
    elements.resolutionNote.textContent = "Sub-basin polygons are the prediction units. Each unit samples the DWD ICON grid at its centroid and combines daily heat, atmospheric-demand, soil-water, and water-balance fields.";
  } else if (state.level === "district") {
    elements.resolutionNote.textContent = "District indices use GISCO 2024 NUTS-3 1:1M boundaries and exact HydroBASINS Level 8 overlap areas in EPSG:3035. This represents Kreise and kreisfreie Stadte, not every municipality.";
  } else {
    elements.resolutionNote.textContent = "State indices aggregate the same live sub-basin values and exact basin-district overlap weights used by local views; the state layer is an overview, not the prediction resolution.";
  }
}

function renderAll() {
  if (!state.ready) return;
  updateOperationalFreshness();
  validateSelection();
  renderControls();
  renderSummary();
  renderMap();
  renderDetails();
  renderResolutionNote();
  persistViewState();
}

function resetSpatialState() {
  if (state.mapInstance && state.riskLayer) state.mapInstance.removeLayer(state.riskLayer);
  if (state.mapInstance && state.scopeOverlay) state.mapInstance.removeLayer(state.scopeOverlay);
  state.riskLayer = null;
  state.scopeOverlay = null;
  state.mapFrameKey = null;
  state.featureLayers.clear();
  state.stateFeatures = [];
  state.districtFeatures = [];
  state.basinFeatures = [];
  [state.stateById, state.districtById, state.basinById, state.basinsByDistrict, state.basinsByState,
    state.overlapsByDistrict, state.overlapsByState, state.districtProfile, state.stateProfile,
    state.predictionCache, state.metricCache]
    .forEach((map) => map.clear());
  state.crosswalk = [];
  state.liveData = null;
  state.liveByBasin.clear();
  state.availableDates = [];
}

function setLoading(loading) {
  elements.retryLoad.hidden = true;
  elements.map.setAttribute("aria-busy", String(loading));
  document.querySelectorAll("button, input, select").forEach((control) => {
    if (control !== elements.retryLoad) control.disabled = loading;
  });
  if (loading) {
    elements.mapStatus.textContent = "Loading boundaries and the latest validated forecast snapshot.";
    elements.riskLevel.textContent = "Loading";
  }
}

async function loadApplication() {
  state.ready = false;
  resetSpatialState();
  setLoading(true);
  elements.mapStatus.setAttribute("role", "status");
  try {
    initializeMap();
    const [states, districts, basins, crosswalk, livePayload] = await Promise.all([
      fetch(STATE_URL).then((response) => response.ok ? response.json() : Promise.reject(new Error("State boundaries unavailable"))),
      fetch(DISTRICT_URL).then((response) => response.ok ? response.json() : Promise.reject(new Error("District boundaries unavailable"))),
      fetch(BASIN_URL).then((response) => response.ok ? response.json() : Promise.reject(new Error("Basin boundaries unavailable"))),
      fetch(CROSSWALK_URL).then((response) => response.ok ? response.json() : Promise.reject(new Error("Spatial crosswalk unavailable"))),
      fetch(LIVE_DATA_URL, { cache: "no-store" }).then((response) => response.ok ? response.json() : Promise.reject(new Error("Live forecast snapshot unavailable")))
    ]);
    const d3 = globalThis.d3;
    if (!d3?.geoCentroid) throw new Error("Bundled D3 geography library unavailable");
    state.stateFeatures = states.features.filter((feature) => feature.properties.CNTR_CODE === "DE");
    state.districtFeatures = districts.features;
    state.basinFeatures = basins.features;
    state.crosswalk = crosswalk;
    state.liveData = validateLivePayload(livePayload, state.basinFeatures);
    state.availableDates = [...state.liveData.forecast.dates];
    const currentForecastDate = state.availableDates[Math.min(state.liveData.forecast.pastDays || 0, state.availableDates.length - 1)];
    state.date = resolveForecastDate(state.date, state.availableDates, currentForecastDate);
    updateOperationalFreshness();
    state.liveData.basins.forEach((basin) => {
      state.liveByBasin.set(String(basin.id), new Map(basin.days.map((day) => [
        day.date,
        { ...basin.context, ...day }
      ])));
    });
    state.d3 = d3;
    assignSpatialHierarchy();
    validateSelection();
    state.ready = true;
    setLoading(false);
    renderAll();
  } catch (error) {
    setLoading(false);
    state.ready = false;
    if (state.mapInstance && state.riskLayer) state.mapInstance.removeLayer(state.riskLayer);
    if (state.mapInstance && state.scopeOverlay) state.mapInstance.removeLayer(state.scopeOverlay);
    state.riskLayer = null;
    state.scopeOverlay = null;
    elements.signalList.replaceChildren();
    elements.actionList.replaceChildren();
    elements.trend.replaceChildren();
    elements.regionSummary.textContent = "Validated map or forecast data unavailable.";
    elements.mapStatus.textContent = "HeatLens could not load a complete validated snapshot. Check the connection or local server, then retry.";
    elements.mapStatus.setAttribute("role", "alert");
    elements.riskLevel.textContent = "Unavailable";
    elements.retryLoad.hidden = false;
    document.querySelectorAll("button, input, select").forEach((control) => {
      control.disabled = control !== elements.retryLoad;
    });
    elements.retryLoad.disabled = false;
    console.error(error);
  }
}

function currentSnapshot() {
  const unit = selectedUnit();
  const metrics = metricsForUnit(unit.level, unit.id);
  const score = scoreForLayer(metrics, state.layer);
  return {
    schema: "heatlens-live-snapshot/v1",
    exportedAt: new Date().toISOString(),
    model: {
      version: MODEL_VERSION,
      generatedAt: state.liveData.generatedAt,
      provider: state.liveData.forecast.provider,
      sourceModel: state.liveData.forecast.sourceModel,
      operationalData: true,
      calibratedWarningService: false,
      freshness: state.freshness.label
    },
    view: {
      date: state.date,
      spatialLevel: state.level,
      decisionLens: state.audience,
      riskLayer: state.layer,
      explanationMode: state.detail,
      fieldContext: {
        crop: state.crop,
        stage: state.stage,
        soil: state.soil
      }
    },
    region: { id: unit.id, name: featureName(unit.feature, unit.level), level: unit.level },
    risk: { score, severity: severity(score).label, metrics },
    officialWarnings: state.liveData.warnings,
    boundary: "Live model inputs with an uncalibrated screening index; not an official warning, clinical tool, or agronomic instruction."
  };
}

async function copyViewLink() {
  persistViewState();
  try {
    await navigator.clipboard.writeText(window.location.href);
    setViewFeedback("View link copied.");
  } catch {
    const input = document.createElement("textarea");
    input.value = window.location.href;
    input.setAttribute("readonly", "");
    input.className = "clipboard-fallback";
    document.body.append(input);
    input.select();
    const copied = document.execCommand("copy");
    input.remove();
    setViewFeedback(copied ? "View link copied." : "Copy failed; use the address bar to share this view.");
  }
}

function exportSnapshot() {
  const snapshot = currentSnapshot();
  const blob = new Blob([`${JSON.stringify(snapshot, null, 2)}\n`], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `heatlens-${snapshot.region.id}-${state.date}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
  setViewFeedback("Live forecast snapshot exported as JSON.");
}

document.querySelectorAll("[data-level]").forEach((button) => {
  button.addEventListener("click", () => {
    state.level = button.dataset.level;
    if (state.level === "state") {
      state.selectedDistrict = null;
      state.selectedBasin = null;
    } else if (state.level === "district") {
      state.selectedBasin = null;
    }
    renderAll();
  });
});

document.querySelectorAll("[data-audience]").forEach((button) => {
  button.addEventListener("click", () => {
    state.audience = button.dataset.audience;
    state.metricCache.clear();
    renderAll();
  });
});

document.querySelectorAll("[data-layer]").forEach((button) => {
  button.addEventListener("click", () => {
    state.layer = button.dataset.layer;
    renderAll();
  });
});

document.querySelectorAll("[data-detail]").forEach((button) => {
  button.addEventListener("click", () => {
    state.detail = button.dataset.detail;
    renderAll();
  });
});

[
  [elements.cropSelect, "crop", FIELD_CONTEXTS.crops],
  [elements.stageSelect, "stage", FIELD_CONTEXTS.stages],
  [elements.soilSelect, "soil", FIELD_CONTEXTS.soils]
].forEach(([select, key, options]) => {
  select.addEventListener("change", () => {
    if (Object.hasOwn(options, select.value)) {
      state[key] = select.value;
      state.metricCache.clear();
      renderAll();
    }
  });
});

elements.dateInput.addEventListener("change", () => {
  if (state.availableDates.includes(elements.dateInput.value)) {
    state.date = elements.dateInput.value;
    renderAll();
  } else {
    elements.dateInput.value = state.date;
    setViewFeedback(`Choose an available date between ${state.availableDates[0]} and ${state.availableDates.at(-1)}.`);
  }
});

elements.previousDay.addEventListener("click", () => {
  const index = state.availableDates.indexOf(state.date);
  if (index > 0) state.date = state.availableDates[index - 1];
  renderAll();
});

elements.nextDay.addEventListener("click", () => {
  const index = state.availableDates.indexOf(state.date);
  if (index >= 0 && index < state.availableDates.length - 1) state.date = state.availableDates[index + 1];
  renderAll();
});

elements.regionSelect.addEventListener("change", () => {
  if (elements.regionSelect.value) selectMapUnit(state.level, elements.regionSelect.value, false);
});

elements.scopeBack.addEventListener("click", () => {
  if (state.level === "basin" && state.selectedDistrict) {
    state.level = "district";
    state.selectedBasin = null;
  } else {
    state.level = "state";
    state.selectedDistrict = null;
    state.selectedBasin = null;
  }
  renderAll();
});

elements.retryLoad.addEventListener("click", loadApplication);
elements.shareView.addEventListener("click", copyViewLink);
elements.exportView.addEventListener("click", exportSnapshot);

window.addEventListener("popstate", () => {
  Object.assign(state, parseViewState(window.location.search));
  if (state.ready) {
    const currentForecastDate = state.availableDates[Math.min(state.liveData.forecast.pastDays || 0, state.availableDates.length - 1)];
    state.date = resolveForecastDate(state.date, state.availableDates, currentForecastDate);
    renderAll();
  }
});

window.setInterval(() => {
  if (!state.ready) return;
  const previousStatus = `${state.freshness.label}|${Math.floor(state.freshness.ageHours || 0)}|${state.sourceFreshness.staleSources.join()}`;
  updateOperationalFreshness();
  const nextStatus = `${state.freshness.label}|${Math.floor(state.freshness.ageHours || 0)}|${state.sourceFreshness.staleSources.join()}`;
  if (previousStatus !== nextStatus) {
    renderSummary();
    renderDetails();
  }
}, 60_000);

loadApplication();
