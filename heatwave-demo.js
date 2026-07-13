import {
  ANALYSIS_DATE,
  AUDIENCES,
  LAYERS,
  MAX_DATE,
  MIN_DATE,
  MODEL_VERSION,
  SCENARIO_GENERATED_AT,
  actionsFor,
  aggregatePredictions,
  buildBasinPrediction,
  dataStatus,
  dateRange,
  fillColor,
  scoreForLayer,
  severity
} from "./heatwave-model.js";
import { DEFAULT_VIEW, parseViewState, serializeViewState } from "./heatwave-state.js";

const STATE_URL = "./assets/nuts1-de.geojson";
const DISTRICT_URL = "./assets/nuts3-de.geojson";
const BASIN_URL = "./assets/hydrobasins-de-level8.geojson";
const CROSSWALK_URL = "./assets/basin-nuts3-crosswalk.json";
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
  selectedKind: document.querySelector("#selected-kind"),
  regionTitle: document.querySelector("#region-title"),
  riskLevel: document.querySelector("#risk-level"),
  regionSummary: document.querySelector("#region-summary"),
  signalList: document.querySelector("#signal-list"),
  trend: document.querySelector("#risk-trend"),
  trendLayer: document.querySelector("#trend-layer-label"),
  confidence: document.querySelector("#confidence-label"),
  actionList: document.querySelector("#action-list"),
  decisionNote: document.querySelector("#decision-note"),
  resolutionNote: document.querySelector("#resolution-note"),
  retryLoad: document.querySelector("#retry-load"),
  shareView: document.querySelector("#share-view"),
  exportView: document.querySelector("#export-view"),
  viewFeedback: document.querySelector("#view-feedback"),
  modelVersion: document.querySelector("#model-version")
};
elements.trendDescription = document.querySelector("#trend-svg-desc");

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < String(value).length; index += 1) {
    hash = Math.imul(31, hash) + String(value).charCodeAt(index) | 0;
  }
  return Math.abs(hash);
}

function profileForDistrict(feature) {
  const id = feature.properties.NUTS_ID;
  const name = String(feature.properties.NAME_LATN || feature.properties.NUTS_NAME || "");
  const city = /Kreisfreie Stadt|Stadtkreis|Berlin|Hamburg|Bremen/i.test(name);
  const fingerprint = hashString(id) % 23;
  return {
    exposure: clamp(38 + fingerprint + (city ? 27 : 0), 28, 94),
    cropSensitivity: clamp(72 - fingerprint * 0.7 - (city ? 38 : 0), 20, 82)
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

function shiftDate(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
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
    predictions.set(id, buildBasinPrediction({
      id,
      centroid: feature.__centroid,
      properties: feature.properties
    }, date));
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
  return (records || []).map((record) => ({
    ...predictionMap.get(String(record.HYBAS_ID)),
    area: record.overlap_km2
  }));
}

function metricsForUnit(level, id, date = state.date) {
  const cacheKey = `${date}|${state.audience}|${level}|${id}`;
  if (state.metricCache.has(cacheKey)) return state.metricCache.get(cacheKey);
  const predictions = weightedPredictionsForUnit(level, id, date);
  const profile = profileForUnit(level, id);
  const metrics = aggregatePredictions(predictions, {
    audience: state.audience,
    exposure: profile.exposure,
    cropSensitivity: profile.cropSensitivity
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
  metrics.available = metrics.spatialCoverage >= 50;
  if (!metrics.available) {
    metrics.impactScore = Number.NaN;
    metrics.heatScore = Number.NaN;
    metrics.droughtScore = Number.NaN;
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
  elements.dateInput.value = state.date;
  elements.previousDay.disabled = state.date <= MIN_DATE;
  elements.nextDay.disabled = state.date >= MAX_DATE;
}

function renderSummary() {
  elements.coverage.textContent = `${state.stateFeatures.length} states / ${state.districtFeatures.length} NUTS-3 / ${state.basinFeatures.length} basins`;
  elements.selectedDateValue.textContent = formatDate(state.date);
  elements.predictionUnit.textContent = "HydroBASINS L8";
  elements.dataStatus.textContent = dataStatus(state.date);
  elements.modelVersion.textContent = `v${MODEL_VERSION}`;
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
  detail.textContent = `${LAYERS[state.layer]}: ${level.label} ${scoreLabel}`;
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
  const bounds = state.riskLayer.getBounds();
  if (bounds.isValid()) {
    state.mapInstance.invalidateSize();
    state.mapInstance.fitBounds(bounds, {
      animate: false,
      maxZoom: state.level === "state" ? 6.5 : state.level === "district" ? 8.5 : 10.5,
      padding: [18, 18]
    });
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
  const dates = dateRange();
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

  [50, 70, 85].forEach((value) => {
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
    title.textContent = `${formatDate(dates[index])}: ${value}`;
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
  elements.trendLayer.textContent = LAYERS[state.layer];
  const peak = Math.max(...values);
  const peakIndex = values.indexOf(peak);
  const currentIndex = dates.indexOf(state.date);
  elements.trendDescription.textContent = `${LAYERS[state.layer]} ranges from ${Math.min(...values)} to ${peak}. Peak ${peak} on ${formatDate(dates[peakIndex])}; selected date ${formatDate(state.date)} is ${values[currentIndex]}.`;
}

function renderDetails() {
  const unit = selectedUnit();
  const metrics = metricsForUnit(unit.level, unit.id);
  const score = scoreForLayer(metrics, state.layer);
  const level = severity(score);
  const kind = unit.level === "district" ? "district / urban district" : unit.level === "basin" ? "sub-basin" : "state";

  elements.selectedKind.textContent = `Selected ${kind}`;
  elements.regionTitle.textContent = featureName(unit.feature, unit.level);
  elements.riskLevel.textContent = `${level.label} ${score}`;
  elements.riskLevel.className = `risk-level ${level.className}`;
  if (!metrics.available) {
    elements.riskLevel.textContent = "Unavailable";
    elements.regionSummary.textContent = `${formatDate(state.date)} has no score because the exact basin overlay covers only ${metrics.spatialCoverage}% of this region.`;
    elements.signalList.replaceChildren(
      appendSignal("Spatial coverage", `${metrics.spatialCoverage}% exact overlap`),
      appendSignal("Status", "Risk and action outputs suppressed"),
      appendSignal("Official source", "Use DWD and the responsible local authority")
    );
    elements.actionList.replaceChildren();
    elements.confidence.textContent = "Insufficient coverage";
    elements.decisionNote.textContent = "HeatLens fails closed when spatial coverage is below 50%; it does not substitute nearby basin values.";
    renderTrend(unit);
    return;
  }
  const guidance = actionsFor(metrics, state.audience);
  elements.regionSummary.textContent = `${AUDIENCES[state.audience]} scenario estimate for ${formatDate(state.date)}: ${level.label.toLowerCase()} ${LAYERS[state.layer].toLowerCase()} based on ${metrics.basinCount} contributing sub-basin${metrics.basinCount === 1 ? "" : "s"}.`;
  elements.signalList.replaceChildren(
    appendSignal("Heat proxies", `Tmax-like ${metrics.tmaxProxy} | UTCI-like ${metrics.utciProxy} | persistence ${metrics.persistenceProxy}`),
    appendSignal("Drought proxies", `soil-water rank ${metrics.soilWaterProxy}/100 | SPI-like ${metrics.spi3Proxy} | ET-deficit-like ${metrics.etDeficitProxy}`),
    appendSignal("Hydrology proxies", `flow rank ${metrics.flowProxy}/100 | vegetation ${metrics.faparProxy} | VPD-like ${metrics.vpdProxy}`),
    appendSignal("Model", `${metrics.consistencyProxy}/100 scenario consistency | ${metrics.basinCount} basins | ${metrics.spatialCoverage}% spatial coverage`),
    appendSignal("Assumptions", `synthetic exposure ${metrics.exposure}/100 | crop sensitivity ${metrics.cropSensitivity}/100`)
  );
  elements.actionList.replaceChildren(...guidance.actions.map((action) => {
    const item = document.createElement("li");
    item.textContent = action;
    return item;
  }));
  elements.confidence.textContent = `${metrics.consistencyProxy}/100 scenario consistency proxy`;
  elements.decisionNote.textContent = guidance.note;
  renderTrend(unit);
}

function renderResolutionNote() {
  if (state.level === "basin") {
    elements.resolutionNote.textContent = "Sub-basin polygons are the model units. Click one to inspect its daily heat, soil-water, SPI-3, ET, vegetation, and low-flow signals.";
  } else if (state.level === "district") {
    elements.resolutionNote.textContent = "District indices use official GISCO 2024 NUTS-3 1:1M boundaries and exact HydroBASINS Level 8 overlap areas in EPSG:3035. This layer represents Kreise and kreisfreie Stadte, not every municipality.";
  } else {
    elements.resolutionNote.textContent = "State indices aggregate the same exact basin-district overlap weights used by local views; the state layer is an overview, not the prediction resolution.";
  }
}

function renderAll() {
  if (!state.ready) return;
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
}

function setLoading(loading) {
  elements.retryLoad.hidden = true;
  elements.map.setAttribute("aria-busy", String(loading));
  document.querySelectorAll("button, input, select").forEach((control) => {
    if (control !== elements.retryLoad) control.disabled = loading;
  });
  if (loading) {
    elements.mapStatus.textContent = "Loading administrative and hydrological boundaries.";
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
    const [states, districts, basins, crosswalk] = await Promise.all([
      fetch(STATE_URL).then((response) => response.ok ? response.json() : Promise.reject(new Error("State boundaries unavailable"))),
      fetch(DISTRICT_URL).then((response) => response.ok ? response.json() : Promise.reject(new Error("District boundaries unavailable"))),
      fetch(BASIN_URL).then((response) => response.ok ? response.json() : Promise.reject(new Error("Basin boundaries unavailable"))),
      fetch(CROSSWALK_URL).then((response) => response.ok ? response.json() : Promise.reject(new Error("Spatial crosswalk unavailable")))
    ]);
    const d3 = globalThis.d3;
    if (!d3?.geoCentroid) throw new Error("Bundled D3 geography library unavailable");
    state.stateFeatures = states.features.filter((feature) => feature.properties.CNTR_CODE === "DE");
    state.districtFeatures = districts.features;
    state.basinFeatures = basins.features;
    state.crosswalk = crosswalk;
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
    elements.regionSummary.textContent = "Map data unavailable.";
    elements.mapStatus.textContent = "The map could not be loaded. Check the connection or local server, then retry.";
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
    schema: "heatlens-scenario-snapshot/v1",
    exportedAt: new Date().toISOString(),
    model: { version: MODEL_VERSION, generatedAt: SCENARIO_GENERATED_AT, operational: false },
    view: {
      date: state.date,
      spatialLevel: state.level,
      decisionLens: state.audience,
      riskLayer: state.layer
    },
    region: { id: unit.id, name: featureName(unit.feature, unit.level), level: unit.level },
    risk: { score, severity: severity(score).label, metrics },
    boundary: "Deterministic research scenario; not a live warning, clinical tool, or agronomic instruction."
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
  setViewFeedback("Scenario snapshot exported as JSON.");
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

elements.dateInput.addEventListener("change", () => {
  if (elements.dateInput.value >= MIN_DATE && elements.dateInput.value <= MAX_DATE) {
    state.date = elements.dateInput.value;
    renderAll();
  } else {
    elements.dateInput.value = state.date;
    setViewFeedback(`Choose a date between ${MIN_DATE} and ${MAX_DATE}.`);
  }
});

elements.previousDay.addEventListener("click", () => {
  state.date = shiftDate(state.date, -1);
  renderAll();
});

elements.nextDay.addEventListener("click", () => {
  state.date = shiftDate(state.date, 1);
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
  if (state.ready) renderAll();
});

loadApplication();
