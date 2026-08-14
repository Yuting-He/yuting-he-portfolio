import {
  AUDIENCES,
  FARM_GOALS,
  FIELD_CONTEXTS,
  HORTICULTURE_CONTEXTS,
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
  PLAIN_SOURCE_SUMMARY_DE,
  plainActionCategoryDe,
  plainActionsForDe,
  plainConfidenceLabelDe,
  plainDecisionNoteDe,
  plainLanguageSignalsDe,
  plainLanguageSummaryDe,
  technicalGuidanceForDe
} from "./heatwave-language-de.js";
import {
  LOCALE_CODES,
  applyDocumentLanguage,
  confidenceLabel,
  profileLabel,
  severityLabel,
  textFor
} from "./heatwave-i18n.js";
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
const preferredBrowserLanguage = navigator.languages?.[0] || navigator.language || "en";
const browserLanguage = String(preferredBrowserLanguage).toLowerCase().startsWith("de") ? "de" : "en";
const initialView = parseViewState(window.location.search, browserLanguage);

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
  personalisationSummary: document.querySelector("#personalisation-summary"),
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
elements.trendSvgTitle = document.querySelector("#trend-svg-title");
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
elements.farmGoalSelect = document.querySelector("#farm-goal");
elements.gardenContext = document.querySelector("#garden-context");
elements.plantSelect = document.querySelector("#plant-profile");
elements.gardenSettingSelect = document.querySelector("#garden-setting");
elements.gardenSoilSelect = document.querySelector("#garden-soil");
elements.gardenGoalSelect = document.querySelector("#garden-goal");
elements.legendLabels = [...document.querySelectorAll("[data-legend-label]")];
elements.languageButtons = [...document.querySelectorAll("[data-language]")];

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const isGerman = () => state.language === "de";
const ui = (key, values) => textFor(state.language, key, values);
const localizedProfile = (group, key, fallback) => profileLabel(state.language, group, key, fallback);
const localizedSeverity = (level) => severityLabel(state.language, level);

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
  if (level === "basin") {
    const id = feature.properties.PFAF_ID || feature.properties.HYBAS_ID;
    return isGerman() ? `Teileinzugsgebiet ${id}` : `Sub-basin ${id}`;
  }
  return feature.properties.NAME_LATN || feature.properties.NUTS_NAME || feature.properties.NUTS_ID;
}

function formatDate(date) {
  return new Intl.DateTimeFormat(LOCALE_CODES[state.language], { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${date}T00:00:00Z`));
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return isGerman() ? "nicht verfügbar" : "unavailable";
  return new Intl.DateTimeFormat(LOCALE_CODES[state.language], {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin", timeZoneName: "short"
  }).format(date);
}

function freshnessText() {
  if (!Number.isFinite(state.freshness.ageHours)) return isGerman() ? "Quellzeit nicht verfügbar" : "source time unavailable";
  if (state.freshness.ageHours < 1) return isGerman() ? "vor weniger als 1 Stunde aktualisiert" : "updated less than 1 hour ago";
  const hours = Math.floor(state.freshness.ageHours);
  return isGerman() ? `vor ${hours} Stunden aktualisiert` : `updated ${hours} hours ago`;
}

function updateOperationalFreshness() {
  const snapshotFreshness = freshnessStatus(state.liveData.generatedAt);
  state.sourceFreshness = runtimeSourceFreshness(state.liveData.sourceFreshness);
  state.freshness = state.sourceFreshness.stale
    ? {
        ...snapshotFreshness,
        label: isGerman() ? "Quelle veraltet" : "Source stale",
        className: "stale",
        stale: true,
        sourceStale: true
      }
    : snapshotFreshness;
}

function staleSourceNames() {
  const names = {
    radolan: "RADOLAN",
    dwdTemperature: isGerman() ? "DWD-Temperatur" : "DWD temperature",
    ufz: isGerman() ? "UFZ-Boden" : "UFZ soil",
    dwdSoil: isGerman() ? "DWD-Boden" : "DWD soil"
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
  const contextKey = [
    state.crop, state.stage, state.soil, state.farmGoal,
    state.plant, state.gardenSetting, state.gardenSoil, state.gardenGoal
  ].join("|");
  const cacheKey = `${date}|${state.audience}|${contextKey}|${level}|${id}`;
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
    soil: state.soil,
    farmGoal: state.farmGoal,
    plant: state.plant,
    gardenSetting: state.gardenSetting,
    gardenSoil: state.gardenSoil,
    gardenGoal: state.gardenGoal
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
  elements.languageButtons.forEach((button) => {
    const active = button.dataset.language === state.language;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
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
  const availableDateRange = `${formatDate(state.availableDates[0])} - ${formatDate(state.availableDates.at(-1))}`;
  elements.dateNote.textContent = state.freshness.stale
    ? isGerman()
      ? `Abgelaufener Datenstand: ${availableDateRange}. Neuere Daten erfordern eine Aktualisierung.`
      : `Expired snapshot: ${availableDateRange}. Newer dates require a data refresh.`
    : isGerman()
      ? `In diesem Datenstand verfügbar: ${availableDateRange}`
      : `Available in this snapshot: ${availableDateRange}`;
  elements.fieldContext.hidden = state.audience !== "farmers";
  elements.gardenContext.hidden = state.audience !== "gardeners";
  elements.cropSelect.value = state.crop;
  elements.stageSelect.value = state.stage;
  elements.soilSelect.value = state.soil;
  elements.farmGoalSelect.value = state.farmGoal;
  elements.plantSelect.value = state.plant;
  elements.gardenSettingSelect.value = state.gardenSetting;
  elements.gardenSoilSelect.value = state.gardenSoil;
  elements.gardenGoalSelect.value = state.gardenGoal;
}

function renderSummary() {
  const plain = state.detail === "plain";
  const technicalLegendLabels = {
    low: `${ui("severityLow")} 0-34`,
    moderate: `${ui("severityModerate")} 35-54`,
    high: `${ui("severityHigh")} 55-74`,
    "very-high": `${ui("severityVeryHigh")} 75-100`,
    unavailable: ui("insufficientCoverage")
  };
  const plainLegendLabels = {
    low: ui("severityLow"),
    moderate: ui("severityModerate"),
    high: ui("severityHigh"),
    "very-high": ui("severityVeryHigh"),
    unavailable: ui("insufficientCoverage")
  };
  elements.mapLegend.setAttribute("aria-label", plain
    ? ui("riskLegend")
    : isGerman() ? "Legende der Risikowerte" : "Risk score legend");
  elements.legendLabels.forEach((label) => {
    const labels = plain ? plainLegendLabels : technicalLegendLabels;
    label.textContent = labels[label.dataset.legendLabel];
  });
  elements.coverage.textContent = plain
    ? isGerman()
      ? `${state.stateFeatures.length} Bundesländer mit Kreis- und lokaler Detailansicht`
      : `${state.stateFeatures.length} states with district and local detail`
    : isGerman()
      ? `${state.stateFeatures.length} Bundesländer / ${state.districtFeatures.length} NUTS-3 / ${state.basinFeatures.length} Einzugsgebiete`
      : `${state.stateFeatures.length} states / ${state.districtFeatures.length} NUTS-3 / ${state.basinFeatures.length} basins`;
  elements.selectedDateValue.textContent = formatDate(state.date);
  elements.predictionUnit.textContent = plain
    ? isGerman() ? "Lokale Einzugsgebiete" : "Local drainage areas"
    : isGerman() ? "HydroBASINS L8 / Beobachtungen + EPS" : "HydroBASINS L8 / observed + EPS";
  elements.dataStatus.textContent = plain
    ? state.freshness.stale
      ? isGerman() ? "Veraltet - Hinweise pausiert" : "Out of date - advice paused"
      : isGerman() ? `Aktuell, ${freshnessText()}` : `Updated ${freshnessText()}`
    : `${localizedFreshnessLabel()} - ${freshnessText()}`;
  elements.modelVersion.textContent = `v${MODEL_VERSION}`;
  elements.liveStatusBadge.textContent = plain
    ? state.freshness.stale
      ? isGerman() ? "Daten veraltet" : "Data out of date"
      : isGerman() ? "Daten bereit" : "Data ready"
    : isGerman() ? `Modelldaten: ${localizedFreshnessLabel()}` : `${state.freshness.label} model feed`;
  elements.liveStatusBadge.className = `scenario-badge ${state.freshness.className}`;
  elements.liveStatusText.textContent = plain
    ? state.freshness.stale
      ? isGerman()
        ? "Einige Daten sind für aktuelle Hinweise zu alt. Die Werte bleiben zur Auswertung sichtbar, Handlungsvorschläge pausieren bis zur nächsten gültigen Aktualisierung."
        : "Some data is too old for current advice. Scores remain visible for review, but actions are paused until the next valid update."
      : isGerman()
        ? "Wetter-, Niederschlags- und Bodenwasserdaten sind für diese Planungsansicht aktuell genug. HeatLens bietet Orientierung, aber keine amtliche Warnung."
        : "Weather, rain, and soil-water data are current enough for this planning view. HeatLens is guidance, not an official warning."
    : state.freshness.stale
    ? state.freshness.sourceStale
      ? isGerman()
        ? `${staleSourceNames()} überschreiten die Laufzeitgrenze für Aktualität. Werte bleiben zur Prüfung sichtbar, Handlungsvorschläge werden unterdrückt.`
        : `${staleSourceNames()} exceeded the runtime freshness policy. Scores remain visible for audit, but suggested actions are suppressed.`
      : isGerman()
        ? "Der letzte gültige Prognosedatenstand ist älter als 36 Stunden. Werte bleiben zur Prüfung sichtbar, Handlungsvorschläge werden unterdrückt."
        : "The last valid forecast snapshot is older than 36 hours. Scores remain visible for audit, but suggested actions are suppressed."
    : isGerman()
      ? `Datenstand ${freshnessText()}. Ausgangswerte: RADOLAN bis ${formatTimestamp(state.liveData.observations.radolan.periodEnd)}, ` +
        `DWD-Temperatur bis ${formatTimestamp(state.liveData.observations.dwdTemperature.observedAt)}, ` +
        `UFZ ${formatDate(state.liveData.soilMoisture.ufz.validAt.slice(0, 10))} und ` +
        `DWD-Boden ${formatDate(state.liveData.soilMoisture.dwd.validAt.slice(0, 10))}. ` +
        "HeatLens bleibt Entscheidungsunterstützung und ist keine amtliche Warnung."
      : `Snapshot ${freshnessText()}. Baselines: RADOLAN to ${formatTimestamp(state.liveData.observations.radolan.periodEnd)}, ` +
        `DWD temperature to ${formatTimestamp(state.liveData.observations.dwdTemperature.observedAt)}, ` +
        `UFZ ${formatDate(state.liveData.soilMoisture.ufz.validAt.slice(0, 10))}, and ` +
        `DWD soil ${formatDate(state.liveData.soilMoisture.dwd.validAt.slice(0, 10))}. ` +
        "HeatLens remains decision support, not an official warning.";
  elements.forcingSource.textContent = `${state.liveData.forecast.sourceModel} ${isGerman() ? "über" : "via"} Open-Meteo`;
  elements.sourceUpdated.textContent = formatTimestamp(state.liveData.generatedAt);
  elements.operationalStatus.textContent = state.freshness.stale
    ? state.freshness.sourceStale
      ? isGerman() ? "Aktualitätsgrenze überschritten - Maßnahmen unterdrückt" : "Source freshness limit exceeded - actions suppressed"
      : isGerman() ? "Veralteter Datenstand - Maßnahmen unterdrückt" : "Stale snapshot - actions suppressed"
    : isGerman() ? "Aktuelle Modelldaten - nur Screening" : "Live model data - screening only";
}

function localizedFreshnessLabel() {
  if (!isGerman()) return state.freshness.label;
  return {
    current: "Aktuell",
    delayed: "Verzögert",
    stale: state.freshness.sourceStale ? "Quelle veraltet" : "Veraltet",
    unavailable: "Nicht verfügbar"
  }[state.freshness.className] || state.freshness.label;
}

function updateRegionSelect(features) {
  const options = features
    .map((feature) => ({ id: featureId(feature, state.level), name: featureName(feature, state.level) }))
    .sort((left, right) => left.name.localeCompare(right.name, LOCALE_CODES[state.language]));
  const selected = state.level === "state" ? state.selectedState : state.level === "district" ? state.selectedDistrict : state.selectedBasin;
  const placeholder = document.createElement("option");
  placeholder.value = "";
  const type = state.level === "district"
    ? isGerman() ? "Kreis / kreisfreie Stadt" : "district / urban district"
    : state.level === "basin"
      ? isGerman() ? "Teileinzugsgebiet" : "sub-basin"
      : isGerman() ? "Bundesland" : "state";
  placeholder.textContent = isGerman() ? `${type} auswählen` : `Choose ${type}`;
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
  const scoreLabel = Number.isFinite(score) ? score : isGerman() ? "kein Wert" : "no score";
  const content = document.createElement("span");
  const name = document.createElement("strong");
  const detail = document.createElement("span");
  name.textContent = featureName(feature, state.level);
  detail.textContent = state.detail === "plain"
    ? isGerman() ? `Aufmerksamkeit: ${localizedSeverity(level)}` : `${level.label} concern`
    : `${localizedProfile("layers", state.layer, LAYERS[state.layer])}: ${localizedSeverity(level)} ${scoreLabel}`;
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

  const stateName = state.selectedState ? featureName(state.stateById.get(state.selectedState), "state") : isGerman() ? "Deutschland" : "Germany";
  if (state.level === "state") {
    elements.scopeLabel.textContent = ui("nationalOverview");
    elements.mapTitle.textContent = ui("germanyStates");
  } else if (state.level === "district") {
    elements.scopeLabel.textContent = isGerman() ? "Administrative NUTS-3-Handlungsebene" : "NUTS-3 administrative response layer";
    elements.mapTitle.textContent = isGerman()
      ? `${stateName} - Kreise und kreisfreie Städte`
      : `${stateName} - districts and urban districts`;
  } else {
    const districtName = state.selectedDistrict ? featureName(state.districtById.get(state.selectedDistrict), "district") : stateName;
    elements.scopeLabel.textContent = isGerman() ? "Hydrologische Prognoseebene" : "Hydrological prediction layer";
    elements.mapTitle.textContent = isGerman() ? `${districtName} - Teileinzugsgebiete` : `${districtName} - sub-basins`;
  }
  elements.scopeBack.hidden = state.level === "state";
  elements.scopeBack.textContent = state.level === "basin" && state.selectedDistrict
    ? isGerman() ? "\u2190 Kreis" : "\u2190 District"
    : ui("backGermany");
  const unitLabel = state.level === "district"
    ? isGerman() ? "Kreise / kreisfreie Städte" : "district / urban-district regions"
    : state.level === "basin"
      ? isGerman() ? "Teileinzugsgebiete" : "basins"
      : isGerman() ? "Bundesländer" : "states";
  elements.mapStatus.textContent = isGerman()
    ? `${features.length} sichtbare ${unitLabel} für ${formatDate(state.date)} auf OpenStreetMap.`
    : `${features.length} visible ${unitLabel} for ${formatDate(state.date)} over OpenStreetMap.`;
  elements.map.setAttribute("aria-label", isGerman()
    ? `${localizedProfile("layers", state.layer, LAYERS[state.layer])} für ${formatDate(state.date)}. ${features.length} sichtbare ${unitLabel}.`
    : `${LAYERS[state.layer]} for ${formatDate(state.date)}. ${features.length} visible ${unitLabel}.`);
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
  elements.trendSvgTitle.textContent = isGerman()
    ? "Screening-Risiko der ausgewählten Region über die verfügbaren Tage"
    : "Selected region screening risk across available dates";

  if (values.some((value) => !Number.isFinite(value))) {
    elements.trendLayer.textContent = isGerman() ? "Unzureichende räumliche Abdeckung" : "Insufficient spatial coverage";
    elements.trendDescription.textContent = isGerman()
      ? "Es wird kein Verlauf angezeigt, weil weniger als die Hälfte der ausgewählten Region die hinterlegte hydrologische Geometrie schneidet."
      : "No trend is shown because less than half of the selected region intersects the bundled hydrological geometry.";
    elements.trend.replaceChildren(elements.trendSvgTitle, elements.trendDescription);
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
      ? isGerman()
        ? `${formatDate(dates[index])}: Aufmerksamkeit ${localizedSeverity(severity(value))}`
        : `${formatDate(dates[index])}: ${severity(value).label} concern`
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
  elements.trend.replaceChildren(elements.trendSvgTitle, elements.trendDescription, ...nodes);
  elements.trendLayer.textContent = state.detail === "plain"
    ? isGerman() ? "Ausgewählte Aufmerksamkeit" : "Selected concern"
    : localizedProfile("layers", state.layer, LAYERS[state.layer]);
  elements.trendTitle.textContent = state.detail === "plain"
    ? isGerman() ? "Wie sich die Situation entwickeln kann" : "How the situation may change"
    : isGerman() ? `${dates.length}-Tage-Risikoverlauf` : `${dates.length}-day risk profile`;
  const peak = Math.max(...values);
  const peakIndex = values.indexOf(peak);
  const currentIndex = dates.indexOf(state.date);
  elements.trendDescription.textContent = state.detail === "plain"
    ? isGerman()
      ? `Die Aufmerksamkeit reicht von ${localizedSeverity(severity(Math.min(...values))).toLowerCase()} bis ${localizedSeverity(severity(peak)).toLowerCase()}. Der höchste Stand tritt am ${formatDate(dates[peakIndex])} auf; am ausgewählten Datum ist er ${localizedSeverity(severity(values[currentIndex])).toLowerCase()}.`
      : `Concern ranges from ${severity(Math.min(...values)).label.toLowerCase()} to ${severity(peak).label.toLowerCase()}. The highest level occurs on ${formatDate(dates[peakIndex])}; the selected date is ${severity(values[currentIndex]).label.toLowerCase()}.`
    : isGerman()
      ? `${localizedProfile("layers", state.layer, LAYERS[state.layer])} reicht von ${Math.min(...values)} bis ${peak}. Maximum ${peak} am ${formatDate(dates[peakIndex])}; ausgewähltes Datum ${formatDate(state.date)}: ${values[currentIndex]}.`
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
    ? isGerman() ? "Aktueller amtlicher Kontext - kein Warnarchiv" : "Current authoritative context - not a warning archive"
    : isGerman() ? "Aktueller amtlicher Kontext" : "Current authoritative context";
  const contextPrefix = isRetrospective
    ? isGerman()
      ? `Aktueller Feed ausgegeben am ${formatTimestamp(warningFeed.issuedAt)}; die rückblickende Abdeckung für ${formatDate(state.date)} kann unvollständig sein. `
      : `Current feed issued ${formatTimestamp(warningFeed.issuedAt)}; retrospective coverage may be incomplete for ${formatDate(state.date)}. `
    : "";
  if (warningFeed.status !== "available") {
    elements.officialHeatTitle.textContent = isGerman()
      ? plain ? "Amtlicher Warnfeed nicht verfügbar" : "DWD-Feed nicht verfügbar"
      : plain ? "Official warning feed unavailable" : "DWD feed unavailable";
    elements.officialHeatDetail.textContent = plain
      ? isGerman() ? "Vor einer Schutzentscheidung den amtlichen Wetterwarndienst öffnen." : "Open the official weather-warning service before making a protective decision."
      : isGerman() ? "Vor einer Schutzentscheidung den amtlichen DWD-Dienst öffnen." : "Open the official DWD service before making a protective decision.";
    elements.officialRainTitle.textContent = isGerman() ? "Regenwarnkontext nicht verfügbar" : "Rain warning context unavailable";
    elements.officialRainDetail.textContent = isGerman()
      ? "DWD und zuständige Hochwasserzentrale direkt prüfen."
      : "Check DWD and the responsible state flood portal directly.";
    return;
  }
  const heatWarnings = (regionWarnings?.warnings || [])
    .filter((warning) => warning.isHeat && warningAppliesToDate(warning, state.date));
  if (heatWarnings.length) {
    elements.officialHeatTitle.textContent = heatWarnings[0].event || (isGerman() ? "Aktive DWD-Hitzewarnung" : "Active DWD heat warning");
    elements.officialHeatDetail.textContent = `${contextPrefix}${heatWarnings[0].regionName}: ${heatWarnings[0].headline || (isGerman() ? "Details beim DWD" : "See DWD for details")}.`;
  } else {
    elements.officialHeatTitle.textContent = isGerman()
      ? plain ? "Keine amtliche Hitzewarnung überschneidet das ausgewählte Datum" : "Keine veröffentlichte DWD-Hitzewarnung überschneidet das ausgewählte Datum"
      : plain ? "No official heat warning overlaps the selected date" : "No published DWD heat warning overlaps the selected date";
    elements.officialHeatDetail.textContent = isRetrospective
      ? isGerman() ? "Der aktuelle Feed ist kein Warnarchiv für dieses vergangene Datum." : "The current feed is not a warning archive for this retrospective date."
      : isGerman() ? "Der aktuelle Feed deckt nicht den gesamten Prognosezeitraum ab; dies ist keine Entwarnung." : "The current feed does not cover the full forecast horizon; this is not an all-clear.";
  }
  const rainWarnings = (regionWarnings?.warnings || [])
    .filter((warning) => warning.isRain && warningAppliesToDate(warning, state.date));
  if (rainWarnings.length) {
    elements.officialRainTitle.textContent = rainWarnings[0].event || (isGerman() ? "Aktive DWD-Regenwarnung" : "Active DWD rain warning");
    elements.officialRainDetail.textContent = `${contextPrefix}${rainWarnings[0].regionName}: ${rainWarnings[0].headline || (isGerman() ? "Details beim DWD" : "See DWD for details")}.`;
  } else {
    elements.officialRainTitle.textContent = isGerman()
      ? plain ? "Keine amtliche Regenwarnung überschneidet das ausgewählte Datum" : "Keine veröffentlichte DWD-Regenwarnung überschneidet das ausgewählte Datum"
      : plain ? "No official rain warning overlaps the selected date" : "No published DWD rain warning overlaps the selected date";
    elements.officialRainDetail.textContent = isGerman()
      ? plain
        ? `Der aktuelle Feed wurde am ${formatTimestamp(warningFeed.issuedAt)} ausgegeben und deckt spätere Daten möglicherweise nicht ab. Bei Flusshochwasser die zuständige Hochwasserzentrale direkt prüfen; diese Karte prognostiziert keine Hochwasserwahrscheinlichkeit.`
        : `Feed vom ${formatTimestamp(warningFeed.issuedAt)}; der vollständige Prognosezeitraum ist nicht abgedeckt. Flusshochwasser erfordert Informationen der Hochwasserzentralen; der Nässeindex ist keine Hochwasserwahrscheinlichkeit.`
      : plain
        ? `The current feed was issued ${formatTimestamp(warningFeed.issuedAt)} and may not cover later dates. For river flooding, check the state flood service directly; this map does not predict flood probability.`
        : `Feed issued ${formatTimestamp(warningFeed.issuedAt)} and does not cover the full forecast horizon. River flooding requires state flood-portal information; the wet index is not a flood probability.`;
  }
}

function smiClass(value) {
  if (!Number.isFinite(value)) return isGerman() ? "nicht verfügbar" : "unavailable";
  if (value <= 0.02) return isGerman() ? "außergewöhnliche Dürre" : "exceptional drought";
  if (value <= 0.05) return isGerman() ? "extreme Dürre" : "extreme drought";
  if (value <= 0.1) return isGerman() ? "schwere Dürre" : "severe drought";
  if (value <= 0.2) return isGerman() ? "mäßige Dürre" : "moderate drought";
  if (value <= 0.3) return isGerman() ? "ungewöhnliche Trockenheit" : "unusual dryness";
  if (value >= 0.98) return isGerman() ? "außergewöhnlich nass" : "exceptionally wet";
  if (value >= 0.95) return isGerman() ? "extrem nass" : "extremely wet";
  if (value >= 0.9) return isGerman() ? "stark nass" : "severely wet";
  if (value >= 0.8) return isGerman() ? "mäßig nass" : "moderately wet";
  if (value >= 0.7) return isGerman() ? "ungewöhnlich nass" : "unusually wet";
  return isGerman() ? "Normalbereich" : "normal range";
}

function observationText(metrics) {
  if (Number.isFinite(metrics.dwdObservedTmaxC)) {
    const completeDay = metrics.dwdObservationKind === "complete-day";
    const kind = isGerman()
      ? completeDay ? "vollständiger Tag" : "bisheriger Tagesverlauf"
      : completeDay ? "complete-day" : "day-so-far";
    const bias = metrics.temperatureValidationBiasC;
    const comparison = isGerman()
      ? completeDay ? "Modellabweichung" : "vorläufige Prognosedifferenz"
      : completeDay ? "model bias" : "provisional forecast gap";
    const comparisonText = Number.isFinite(bias)
      ? `${comparison} ${bias >= 0 ? "+" : ""}${bias} °C`
      : isGerman() ? "Validierungsvergleich nicht verfügbar" : "validation comparison unavailable";
    if (metrics.basinCount === 1) {
      const station = metrics.dwdStationName ? ` ${metrics.dwdStationName}` : "";
      const distance = Number.isFinite(metrics.dwdStationDistanceKm)
        ? isGerman() ? ` | ${metrics.dwdStationDistanceKm} km entfernt` : ` | ${metrics.dwdStationDistanceKm} km away`
        : "";
      return `DWD${station} ${kind} Tmax ${metrics.dwdObservedTmaxC} °C | ${comparisonText}${distance}`;
    }
    const errorLabel = isGerman()
      ? completeDay ? "MAE" : "vorläufige absolute Differenz"
      : completeDay ? "MAE" : "provisional absolute gap";
    const coverage = metrics.dwdObservedStationCount
      ? isGerman()
        ? ` | ${metrics.dwdObservedStationCount} Stationen, weiteste Zuordnung ${metrics.dwdStationMaxDistanceKm} km`
        : ` | ${metrics.dwdObservedStationCount} stations, farthest match ${metrics.dwdStationMaxDistanceKm} km`
      : "";
    const errorText = Number.isFinite(metrics.temperatureValidationMaeC)
      ? ` | ${errorLabel} ${metrics.temperatureValidationMaeC} °C`
      : "";
    return isGerman()
      ? `DWD-Stationszuordnung, ${kind}, Tmax ${metrics.dwdObservedTmaxC} °C, einzugsgebietsgewichtet | ${comparisonText}${errorText}${coverage}`
      : `DWD matched-station ${kind} Tmax ${metrics.dwdObservedTmaxC} °C, basin-weighted | ${comparisonText}${errorText}${coverage}`;
  }
  if (!Number.isFinite(metrics.dwdLatestTemperatureC) || !Number.isFinite(Date.parse(metrics.dwdObservedAt))) {
    return isGerman()
      ? `Für ${formatDate(state.date)} ist keine gültige Temperaturbeobachtung einer zugeordneten DWD-Station verfügbar`
      : `No DWD matched-station temperature observation is valid for ${formatDate(state.date)}`;
  }
  if (metrics.basinCount === 1) {
    const distance = Number.isFinite(metrics.dwdStationDistanceKm)
      ? isGerman() ? ` | ${metrics.dwdStationDistanceKm} km entfernt` : ` | ${metrics.dwdStationDistanceKm} km away`
      : "";
    return isGerman()
      ? `neueste DWD-Temperatur an ${metrics.dwdStationName || "zugeordneter Station"}: ${metrics.dwdLatestTemperatureC} °C am ${formatTimestamp(metrics.dwdObservedAt)}${distance}`
      : `latest DWD ${metrics.dwdStationName || "matched station"} temperature ${metrics.dwdLatestTemperatureC} °C at ${formatTimestamp(metrics.dwdObservedAt)}${distance}`;
  }
  const farthestMatch = Number.isFinite(metrics.dwdStationMaxDistanceKm)
    ? isGerman() ? ` | weiteste Einzugsgebiet-Stations-Zuordnung ${metrics.dwdStationMaxDistanceKm} km` : ` | farthest basin-station match ${metrics.dwdStationMaxDistanceKm} km`
    : "";
  return isGerman()
    ? `neueste maximale DWD-Netzwerktemperatur ${metrics.dwdLatestTemperatureC} °C am ${formatTimestamp(metrics.dwdObservedAt)}${farthestMatch}`
    : `latest DWD network temperature maximum ${metrics.dwdLatestTemperatureC} °C at ${formatTimestamp(metrics.dwdObservedAt)}${farthestMatch}`;
}

function ensembleText(metrics) {
  if (!Number.isFinite(metrics.ensemblePeakHourTemperatureSdC)) {
    return isGerman()
      ? "Für dieses vergangene Datum ist keine Streuung der ICON-Ensemblemitglieder veröffentlicht"
      : "No ICON ensemble-member dispersion is published for this retrospective date";
  }
  return isGerman()
    ? `${metrics.ensembleModel} (${metrics.ensembleMemberCount} Mitglieder) | Mitglieder-SD zur heißesten mittleren Stunde ${metrics.ensemblePeakHourTemperatureSdC} °C | maximale stündliche Niederschlags-SD ${metrics.ensembleMaxHourlyPrecipitationSdMm} mm`
    : `${metrics.ensembleModel} (${metrics.ensembleMemberCount} members) | member SD at hottest mean hour ${metrics.ensemblePeakHourTemperatureSdC} °C | max hourly precipitation member SD ${metrics.ensembleMaxHourlyPrecipitationSdMm} mm`;
}

function ufzText(metrics) {
  if (!Number.isFinite(metrics.ufzTopsoilSmi) || !Number.isFinite(metrics.ufzTotalSmi)) {
    return isGerman() ? "Für dieses vergangene Datum ist kein gültiger UFZ-Ausgangswert verfügbar" : "No UFZ baseline is valid for this retrospective date";
  }
  const validDate = formatDate(state.liveData.soilMoisture.ufz.validAt.slice(0, 10));
  return isGerman()
    ? `Ausgangswert ${validDate}: Oberboden-SMI ${metrics.ufzTopsoilSmi} (${smiClass(metrics.ufzTopsoilSmi)}) | Gesamtboden-SMI ${metrics.ufzTotalSmi} (${smiClass(metrics.ufzTotalSmi)})`
    : `baseline ${validDate}: topsoil SMI ${metrics.ufzTopsoilSmi} (${smiClass(metrics.ufzTopsoilSmi)}) | total-soil SMI ${metrics.ufzTotalSmi} (${smiClass(metrics.ufzTotalSmi)})`;
}

function radolanText(metrics) {
  if (!Number.isFinite(metrics.radolanPrecipitation24hMm)) {
    return isGerman() ? "Für dieses vergangene Datum ist kein gültiger RADOLAN-Ausgangswert verfügbar" : "No RADOLAN baseline is valid for this retrospective date";
  }
  const radolan = state.liveData.observations.radolan;
  return isGerman()
    ? `${metrics.radolanPrecipitation24hMm} mm / gleitende 24 h bis ${formatTimestamp(radolan.periodEnd)} | Prognose ${metrics.precipitationMm} mm/Tag`
    : `${metrics.radolanPrecipitation24hMm} mm / rolling 24 h ending ${formatTimestamp(radolan.periodEnd)} | forecast ${metrics.precipitationMm} mm/day`;
}

function renderDetails() {
  const unit = selectedUnit();
  const metrics = metricsForUnit(unit.level, unit.id);
  const score = scoreForLayer(metrics, state.layer);
  const level = severity(score);
  const plain = state.detail === "plain";
  const kind = unit.level === "district"
    ? isGerman() ? "Kreis / kreisfreie Stadt" : "district / urban district"
    : unit.level === "basin"
      ? isGerman() ? "Teileinzugsgebiet" : "sub-basin"
      : isGerman() ? "Bundesland" : "state";
  const currentModelDate = state.availableDates[state.liveData.forecast.pastDays];
  const isRetrospective = isRetrospectiveDate(state.date, currentModelDate);

  elements.signalHeading.textContent = plain
    ? ui("whatThisMeans")
    : isGerman() ? "Technische Evidenz" : "Technical evidence";
  elements.detailPanel.classList.toggle("is-plain", plain);
  elements.detailModeNote.textContent = plain
    ? ui("plainLanguage")
    : isGerman() ? "Exakte Werte und Quellen" : "Exact values and sources";
  elements.plainSourceSummary.textContent = isGerman() ? PLAIN_SOURCE_SUMMARY_DE : PLAIN_SOURCE_SUMMARY;
  elements.plainSourceSummary.hidden = !plain;
  elements.provenanceList.hidden = plain;
  elements.selectedKind.textContent = isGerman() ? `Ausgewählt: ${kind}` : `Selected ${kind}`;
  elements.regionTitle.textContent = featureName(unit.feature, unit.level);
  elements.riskLevel.textContent = plain ? localizedSeverity(level) : `${localizedSeverity(level)} ${score}`;
  elements.riskLevel.className = `risk-level ${level.className}`;
  const focusStatus = isRetrospective
    ? isGerman()
      ? "Diese historische Ansicht behält die Auswahl bei, erzeugt aber keine aktuellen Handlungshinweise."
      : "This historical view keeps the selection but does not generate current action guidance."
    : state.freshness.stale
      ? isGerman()
        ? "Die Auswahl ist aktiv, Handlungshinweise pausieren jedoch bis zur Datenaktualisierung."
        : "The selection is active, but action guidance is paused until the data refreshes."
      : isGerman()
        ? "Dies ändert die Priorität der Empfehlungen, nicht den zugrunde liegenden Umweltindex."
        : "This changes the recommendation priority, not the underlying environmental score.";
  if (state.audience === "farmers") {
    elements.personalisationSummary.hidden = false;
    elements.personalisationSummary.textContent = isGerman()
      ? `Schwerpunkt: ${localizedProfile("farmGoals", metrics.farmGoal, FARM_GOALS[metrics.farmGoal].label)}. ` +
        `Angepasst für ${localizedProfile("crops", metrics.crop, metrics.cropLabel)}, ` +
        `${localizedProfile("stages", metrics.stage, metrics.stageLabel)}${metrics.stageAuto ? " aus dem ausgewählten Datum geschätzt" : " manuell ausgewählt"}. ${focusStatus}`
      : `Advice focus: ${FARM_GOALS[metrics.farmGoal].label}. Personalised for ${metrics.cropLabel}, ` +
        `${metrics.stageLabel.toLowerCase()}${metrics.stageAuto ? " estimated from the selected date" : " selected manually"}. ${focusStatus}`;
  } else if (state.audience === "gardeners") {
    elements.personalisationSummary.hidden = false;
    elements.personalisationSummary.textContent = isGerman()
      ? `Schwerpunkt: ${localizedProfile("gardenGoals", metrics.gardenGoal, metrics.gardenGoalLabel)}. ` +
        `Angepasst für ${localizedProfile("plants", metrics.plant, metrics.plantLabel)}; Standort: ` +
        `${localizedProfile("settings", metrics.gardenSetting, metrics.gardenSettingLabel)}; Entwässerung: ${localizedProfile("gardenSoils", metrics.gardenSoil, metrics.gardenSoilLabel)}. ${focusStatus}`
      : `Advice focus: ${metrics.gardenGoalLabel}. Personalised for ${metrics.plantLabel.toLowerCase()} in ` +
        `${metrics.gardenSettingLabel.toLowerCase()} with ${metrics.gardenSoilLabel.toLowerCase()} drainage. ${focusStatus}`;
  } else {
    elements.personalisationSummary.hidden = true;
    elements.personalisationSummary.textContent = "";
  }
  renderOfficialWarning(unit);
  if (!metrics.available) {
    elements.riskLevel.textContent = isGerman() ? "Nicht verfügbar" : "Unavailable";
    if (plain) {
      elements.regionSummary.textContent = isGerman()
        ? "Es liegen nicht genügend verlässliche lokale Informationen vor, um für dieses Gebiet ein Entscheidungssignal abzuleiten."
        : "There is not enough reliable local information to translate this area into a decision signal.";
      elements.signalList.replaceChildren(
        appendSignal(isGerman() ? "Was fehlt" : "What is missing", metrics.spatialCoverage < 50
          ? isGerman() ? "Zu wenig Fläche dieses Gebiets stimmt mit der lokalen Einzugsgebietskarte überein." : "Too little of this area matches the local drainage-area map."
          : isGerman() ? "Zu viele der erforderlichen Eingangsdaten fehlen." : "Too many of the required data inputs are missing."),
        appendSignal(isGerman() ? "Was HeatLens tut" : "What HeatLens does", isGerman()
          ? "Das Risikoergebnis und die Handlungshinweise werden ausgeblendet, statt die Lücke mit Werten benachbarter Gebiete zu füllen."
          : "It hides the risk result and action suggestions instead of filling the gap with nearby values."),
        appendSignal(isGerman() ? "Was jetzt zu tun ist" : "What to do", isGerman()
          ? "Aktuelle amtliche Informationen und Beobachtungen aus dem ausgewählten Gebiet nutzen."
          : "Use current official information and observations from the selected area.")
      );
    } else {
      const coverageReason = metrics.spatialCoverage < 50
        ? isGerman() ? `die exakte Einzugsgebietsüberlagerung nur ${metrics.spatialCoverage}% der Region abdeckt` : `the exact basin overlay covers only ${metrics.spatialCoverage}% of this region`
        : isGerman() ? `die Quellenvollständigkeit nur ${metrics.completeness}% beträgt` : `source completeness is only ${metrics.completeness}%`;
      elements.regionSummary.textContent = isGerman()
        ? `Für ${formatDate(state.date)} wird kein Wert ausgegeben, weil ${coverageReason}.`
        : `${formatDate(state.date)} has no score because ${coverageReason}.`;
      elements.signalList.replaceChildren(
        appendSignal(isGerman() ? "Räumliche Abdeckung" : "Spatial coverage", isGerman() ? `${metrics.spatialCoverage}% exakte Überlagerung` : `${metrics.spatialCoverage}% exact overlap`),
        appendSignal(isGerman() ? "Quellenvollständigkeit" : "Source completeness", `${metrics.completeness}%`),
        appendSignal("Status", isGerman() ? "Risiko- und Handlungsausgaben unterdrückt" : "Risk and action outputs suppressed"),
        appendSignal(isGerman() ? "Amtliche Quelle" : "Official source", isGerman() ? "DWD und zuständige lokale Behörde nutzen" : "Use DWD and the responsible local authority")
      );
    }
    elements.actionList.replaceChildren();
    elements.actionHeadingLabel.textContent = ui("suggestedActions");
    elements.confidence.textContent = plain
      ? isGerman() ? "Nicht genügend lokale Informationen" : "Not enough local information"
      : isGerman() ? "Unzureichende Eingangsabdeckung" : "Insufficient input coverage";
    elements.decisionNote.textContent = plain
      ? isGerman() ? "HeatLens schätzt nicht, wenn die Abdeckung zu gering ist. Amtliche Dienste und lokale Bedingungen direkt prüfen." : "HeatLens does not guess when coverage is too low. Check the official services and local conditions directly."
      : isGerman() ? "Unter 50% räumlicher Abdeckung oder 85% Quellenvollständigkeit unterdrückt HeatLens die Ausgabe; benachbarte Werte werden nicht als Ersatz verwendet." : "HeatLens fails closed below 50% spatial coverage or 85% source completeness; it does not substitute nearby values.";
    renderTrend(unit);
    return;
  }
  const warningContext = warningContextForUnit(unit);
  const datedWarnings = (warningContext.warnings || [])
    .filter((warning) => warningAppliesToDate(warning, state.date));
  const actionOptions = {
    heatWarningCount: datedWarnings.filter((warning) => warning.isHeat).length,
    rainWarningCount: datedWarnings.filter((warning) => warning.isRain).length
  };
  const guidance = isGerman()
    ? technicalGuidanceForDe(metrics, state.audience, actionOptions)
    : actionsFor(metrics, state.audience, actionOptions);
  const plainActions = isGerman()
    ? plainActionsForDe(metrics, state.audience, actionOptions)
    : plainActionsFor(metrics, state.audience, actionOptions);
  const confidence = evidenceConfidence(metrics);
  const dwdSoilDate = formatDate(state.liveData.soilMoisture.dwd.validAt.slice(0, 10));
  const waterSubject = state.audience === "gardeners"
    ? localizedProfile("plants", metrics.plant, metrics.plantLabel)
    : localizedProfile("crops", metrics.crop, metrics.cropLabel);
  const waterProfile = state.audience === "gardeners"
    ? isGerman() ? "DWD-Pflanzenwasser-Referenzprofil" : metrics.waterProfileLabel
    : localizedProfile("waterProfiles", metrics.crop, metrics.cropWaterProfileLabel);
  const fieldSignal = Number.isFinite(metrics.dwdNfkPct)
    ? isGerman()
      ? `Ausgangswert ${dwdSoilDate}: ${waterSubject}, im Mittel ${metrics.dwdNfkPct}% nFK über 10-cm-Schichten bis ${metrics.rootDepthCm} cm | ${metrics.dwdNfkCoveragePct}% Flächenabdeckung | ${waterProfile}${state.audience === "farmers" ? ` | ${localizedProfile("soils", metrics.soil, metrics.soilLabel)}` : ""}`
      : `baseline ${dwdSoilDate}: ${waterSubject}, mean ${metrics.dwdNfkPct}% nFK across 10 cm layers to ${metrics.rootDepthCm} cm | ${metrics.dwdNfkCoveragePct}% area coverage | ${waterProfile}${state.audience === "farmers" ? ` | ${metrics.soilLabel}` : ""}`
    : isGerman()
      ? `${waterSubject}: DWD-nFK-Ausgangswert nicht verfügbar oder unter 85% Flächenabdeckung (${metrics.dwdNfkCoveragePct}%) | ${waterProfile}`
      : `${waterSubject}: DWD nFK baseline unavailable or below 85% area coverage (${metrics.dwdNfkCoveragePct}%) | ${waterProfile}`;
  const selectedContextSignal = state.audience === "farmers"
    ? isGerman()
      ? `${localizedProfile("crops", metrics.crop, metrics.cropLabel)} | ${localizedProfile("stages", metrics.stage, metrics.stageLabel)}${metrics.stageAuto ? " (aus Datum geschätzt)" : " (manuell)"} | ${localizedProfile("soils", metrics.soil, metrics.soilLabel)} | ${localizedProfile("farmGoals", metrics.farmGoal, FARM_GOALS[metrics.farmGoal].label)}`
      : `${metrics.cropLabel} | ${metrics.stageLabel}${metrics.stageAuto ? " (date-estimated)" : " (manual)"} | ${metrics.soilLabel} | ${FARM_GOALS[metrics.farmGoal].label}`
    : state.audience === "gardeners"
      ? isGerman()
        ? `${localizedProfile("plants", metrics.plant, metrics.plantLabel)} | ${localizedProfile("settings", metrics.gardenSetting, metrics.gardenSettingLabel)} | ${localizedProfile("gardenSoils", metrics.gardenSoil, metrics.gardenSoilLabel)} | ${localizedProfile("gardenSeasons", metrics.gardenSeason, metrics.gardenSeasonLabel)} | ${localizedProfile("gardenGoals", metrics.gardenGoal, metrics.gardenGoalLabel)}`
        : `${metrics.plantLabel} | ${metrics.gardenSettingLabel} | ${metrics.gardenSoilLabel} | ${metrics.gardenSeasonLabel} | ${metrics.gardenGoalLabel}`
      : null;
  elements.regionSummary.textContent = plain
    ? (isGerman() ? plainLanguageSummaryDe : plainLanguageSummary)(metrics, state.audience, state.layer, {
        regionName: featureName(unit.feature, unit.level),
        dateLabel: formatDate(state.date),
        stale: state.freshness.stale,
        isRetrospective
      })
    : isGerman()
      ? `${localizedProfile("audiences", state.audience, AUDIENCES[state.audience])}-Screening für ${formatDate(state.date)}: ${localizedSeverity(level).toLowerCase()} bei ${localizedProfile("layers", state.layer, LAYERS[state.layer]).toLowerCase()}, basierend auf ${metrics.basinCount} beitragenden Teileinzugsgebiet${metrics.basinCount === 1 ? "" : "en"}.`
      : `${AUDIENCES[state.audience]} screening estimate for ${formatDate(state.date)}: ${level.label.toLowerCase()} ${LAYERS[state.layer].toLowerCase()} based on ${metrics.basinCount} contributing sub-basin${metrics.basinCount === 1 ? "" : "s"}.`;
  const signals = plain
    ? (isGerman() ? plainLanguageSignalsDe : plainLanguageSignals)(metrics, state.audience, state.layer, { stale: state.freshness.stale, isRetrospective })
        .map((signal) => appendSignal(signal.label, signal.text))
    : [
        ...(selectedContextSignal ? [appendSignal(isGerman() ? "Ausgewählter Kontext" : "Selected context", selectedContextSignal)] : []),
        appendSignal(isGerman() ? "Thermische Prognose" : "Thermal forecast", isGerman()
          ? `Tmax ${metrics.tmaxC} \u00b0C | max. gefühlte Temperatur ${metrics.apparentMaxC} \u00b0C | Tmin ${metrics.tminC} \u00b0C`
          : `Tmax ${metrics.tmaxC} \u00b0C | feels-like max ${metrics.apparentMaxC} \u00b0C | Tmin ${metrics.tminC} \u00b0C`),
        appendSignal(isGerman() ? "Messabgleich" : "Measured check", observationText(metrics)),
        appendSignal(isGerman() ? "Ensemblestreuung" : "Ensemble dispersion", ensembleText(metrics)),
        appendSignal(isGerman() ? "UFZ-Perzentil-Ausgangswert" : "UFZ percentile baseline", ufzText(metrics)),
        appendSignal(isGerman() ? "Pflanzenwasser-Ausgangswert" : "Plant-water baseline", `${Number.isFinite(metrics.ufzPlantAvailableWaterPct) ? `UFZ ${metrics.ufzPlantAvailableWaterPct}% nFK | ` : ""}${fieldSignal}`),
        appendSignal(isGerman() ? "Wasserprognose" : "Water forecast", isGerman()
          ? `Wurzelzone ${metrics.soilMoistureM3M3} m\u00b3/m\u00b3 | 3-Tage P-ET0 ${metrics.waterBalance3dMm} mm | ET0 ${metrics.et0Mm} mm/Tag`
          : `root-zone ${metrics.soilMoistureM3M3} m\u00b3/m\u00b3 | 3-day P-ET0 ${metrics.waterBalance3dMm} mm | ET0 ${metrics.et0Mm} mm/day`),
        appendSignal(isGerman() ? "RADOLAN-Ausgangswert" : "RADOLAN baseline", radolanText(metrics)),
        appendSignal(isGerman() ? "Wasser-Screening" : "Water screening", isGerman()
          ? `Trockenstress ${metrics.dryStressScore}/100 | überschüssiges Wasser ${metrics.wetStressScore}/100`
          : `dry ${metrics.dryStressScore}/100 | excess water ${metrics.wetStressScore}/100`),
        appendSignal(isGerman() ? "Evidenzqualität" : "Evidence quality", isGerman()
          ? `${confidence.score}/100 ${confidenceLabel("de", confidence).toLowerCase()} | ${metrics.completeness}% Vollständigkeit der Antriebsdaten | ${metrics.spatialCoverage}% exakte Überlagerung`
          : `${confidence.score}/100 ${confidence.label.toLowerCase()} | ${metrics.completeness}% forcing completeness | ${metrics.spatialCoverage}% exact overlap`)
      ];
  elements.signalList.replaceChildren(...signals);
  const historicalInterpretation = isGerman() ? [
    {
      category: "Retrospective",
      text: plain
        ? `${formatDate(state.date)} ist eine Rekonstruktion eines vergangenen Datums. Sie beschreibt die damaligen Signale und ist keine Empfehlung für heute.`
        : `${formatDate(state.date)} ist eine historische Screening-Rekonstruktion. Sie beschreibt die oben gezeigten datierten Hitze- und Bodenwassersignale und ist kein aktueller Handlungshinweis.`
    },
    {
      category: "Validate",
      text: plain
        ? "Vor Schlussfolgerungen mit archivierten amtlichen Warnungen, lokalen Messungen und dokumentierten Folgen vergleichen."
        : "Datierte DWD-Stations- und RADOLAN-Beobachtungen mit archivierten amtlichen Warnungen, lokalen Messungen und dokumentierten Folgen vergleichen."
    }
  ] : plain ? [
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
  const activeFocusLabel = state.audience === "farmers"
    ? localizedProfile("farmGoals", metrics.farmGoal, FARM_GOALS[metrics.farmGoal].label)
    : state.audience === "gardeners" ? localizedProfile("gardenGoals", metrics.gardenGoal, metrics.gardenGoalLabel) : null;
  elements.actionHeadingLabel.textContent = isRetrospective
    ? isGerman() ? "Historische Einordnung" : "Historical interpretation"
    : activeFocusLabel
      ? isGerman() ? `Empfohlene Schritte: ${activeFocusLabel}` : `Suggested actions: ${activeFocusLabel}`
      : ui("suggestedActions");
  const actions = isRetrospective
    ? historicalInterpretation
    : state.freshness.stale
      ? []
      : plain
        ? plainActions
        : guidance.actions;
  elements.actionList.replaceChildren(...actions.map((action) => {
    const item = document.createElement("li");
    item.classList.toggle("is-focused-action", action.focus === true);
    const category = document.createElement("strong");
    category.textContent = isGerman()
      ? plainActionCategoryDe(action.category)
      : plain ? plainActionCategory(action.category) : action.category;
    const text = document.createElement("span");
    text.textContent = action.text;
    item.append(category, text);
    return item;
  }));
  elements.confidence.textContent = plain
    ? (isGerman() ? plainConfidenceLabelDe : plainConfidenceLabel)(metrics, { stale: state.freshness.stale, isRetrospective })
    : `${confidenceLabel(state.language, confidence)} ${confidence.score}/100`;
  elements.decisionNote.textContent = plain
    ? (isGerman() ? plainDecisionNoteDe : plainDecisionNote)(state.audience, { isRetrospective, stale: state.freshness.stale })
    : isRetrospective
    ? isGerman()
      ? "Historische Ansichten dienen nur der Auswertung und Modellbewertung. Sie dürfen nicht als heutige Hinweise für Bevölkerung, Landwirtschaft oder Kommunen gelesen werden; der aktuelle DWD-Feed ist kein Warnarchiv."
      : "Historical views support review and model evaluation only. They must not be read as present-day resident, farm, or municipal instructions; the current DWD feed is not a warning archive."
    : state.freshness.stale
    ? state.freshness.sourceStale
      ? isGerman()
        ? `Empfohlene Schritte werden unterdrückt, weil ${staleSourceNames()} die Laufzeitgrenze für Aktualität überschreiten. Aktuelle amtliche und lokale Quellen prüfen.`
        : `Suggested actions are suppressed because ${staleSourceNames()} exceeded the runtime freshness limit. Check current official and local sources.`
      : isGerman()
        ? "Empfohlene Schritte werden unterdrückt, weil der letzte gültige Datenstand veraltet ist. DWD und lokale amtliche Kanäle prüfen."
        : "Suggested actions are suppressed because the last valid source snapshot is stale. Check DWD and local official channels."
    : guidance.note;
  renderTrend(unit);
}

function renderResolutionNote() {
  if (state.detail === "plain") {
    if (state.level === "basin") {
      elements.resolutionNote.textContent = isGerman()
        ? "Diese lokale Ansicht folgt einem Einzugsgebiet und nicht einer Verwaltungsgrenze."
        : "This local view follows a drainage area rather than an administrative boundary.";
    } else if (state.level === "district") {
      elements.resolutionNote.textContent = isGerman()
        ? "Die Kreisfarben fassen kleinere Einzugsgebiete zusammen; die Bedingungen können deshalb innerhalb eines Kreises variieren."
        : "District colors combine smaller drainage areas, so conditions can still differ within a district.";
    } else {
      elements.resolutionNote.textContent = isGerman()
        ? "Bundeslandfarben sind eine grobe Übersicht. Für mehr Details einen Kreis oder ein lokales Einzugsgebiet wählen."
        : "State colors are broad overviews. Choose a district or local drainage area for more detail.";
    }
    return;
  }
  if (state.level === "basin") {
    elements.resolutionNote.textContent = isGerman()
      ? "Polygone der Teileinzugsgebiete sind die Prognoseeinheiten. Jede Einheit beprobt das DWD-ICON-Gitter am Schwerpunkt und kombiniert tägliche Hitze-, atmosphärische Nachfrage-, Bodenwasser- und Wasserbilanzfelder."
      : "Sub-basin polygons are the prediction units. Each unit samples the DWD ICON grid at its centroid and combines daily heat, atmospheric-demand, soil-water, and water-balance fields.";
  } else if (state.level === "district") {
    elements.resolutionNote.textContent = isGerman()
      ? "Kreisindizes verwenden GISCO-2024-NUTS-3-Grenzen im Maßstab 1:1 Mio. und exakte HydroBASINS-Level-8-Überlagerungsflächen in EPSG:3035. Dargestellt sind Kreise und kreisfreie Städte, nicht jede Gemeinde."
      : "District indices use GISCO 2024 NUTS-3 1:1M boundaries and exact HydroBASINS Level 8 overlap areas in EPSG:3035. This represents Kreise and kreisfreie Stadte, not every municipality.";
  } else {
    elements.resolutionNote.textContent = isGerman()
      ? "Bundeslandindizes aggregieren dieselben aktuellen Teileinzugsgebietswerte und exakten Überlagerungsgewichte wie die lokalen Ansichten; die Bundeslandebene ist eine Übersicht, nicht die Prognoseauflösung."
      : "State indices aggregate the same live sub-basin values and exact basin-district overlap weights used by local views; the state layer is an overview, not the prediction resolution.";
  }
}

function renderAll() {
  if (!state.ready) return;
  applyDocumentLanguage(document, state.language);
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
    elements.mapStatus.textContent = isGerman()
      ? "Grenzen und der neueste validierte Prognosedatenstand werden geladen."
      : "Loading boundaries and the latest validated forecast snapshot.";
    elements.riskLevel.textContent = ui("loading");
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
    elements.trendDescription.textContent = isGerman()
      ? "Der Risikoverlauf ist nicht verfügbar, weil kein vollständiger validierter Datenstand geladen werden konnte."
      : "The risk trend is unavailable because a complete validated snapshot could not be loaded.";
    elements.trend.replaceChildren(elements.trendSvgTitle, elements.trendDescription);
    elements.regionSummary.textContent = isGerman()
      ? "Validierte Karten- oder Prognosedaten sind nicht verfügbar."
      : "Validated map or forecast data unavailable.";
    elements.mapStatus.textContent = isGerman()
      ? "HeatLens konnte keinen vollständigen validierten Datenstand laden. Verbindung oder lokalen Server prüfen und erneut versuchen."
      : "HeatLens could not load a complete validated snapshot. Check the connection or local server, then retry.";
    elements.mapStatus.setAttribute("role", "alert");
    elements.riskLevel.textContent = isGerman() ? "Nicht verfügbar" : "Unavailable";
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
      language: state.language,
      date: state.date,
      spatialLevel: state.level,
      decisionLens: state.audience,
      riskLayer: state.layer,
      explanationMode: state.detail,
      fieldContext: {
        crop: state.crop,
        stage: state.stage,
        soil: state.soil,
        adviceFocus: state.farmGoal
      },
      gardenContext: {
        plant: state.plant,
        setting: state.gardenSetting,
        drainage: state.gardenSoil,
        adviceFocus: state.gardenGoal
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
    setViewFeedback(isGerman() ? "Link zur Ansicht kopiert." : "View link copied.");
  } catch {
    const input = document.createElement("textarea");
    input.value = window.location.href;
    input.setAttribute("readonly", "");
    input.className = "clipboard-fallback";
    document.body.append(input);
    input.select();
    const copied = document.execCommand("copy");
    input.remove();
    setViewFeedback(copied
      ? isGerman() ? "Link zur Ansicht kopiert." : "View link copied."
      : isGerman() ? "Kopieren fehlgeschlagen; zum Teilen die Adresse aus der Browserleiste verwenden." : "Copy failed; use the address bar to share this view.");
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
  setViewFeedback(isGerman() ? "Aktueller Prognosedatenstand als JSON exportiert." : "Live forecast snapshot exported as JSON.");
}

elements.languageButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (button.dataset.language === state.language) return;
    state.language = button.dataset.language;
    applyDocumentLanguage(document, state.language);
    if (state.ready) renderAll();
    else persistViewState();
  });
});

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
  [elements.soilSelect, "soil", FIELD_CONTEXTS.soils],
  [elements.farmGoalSelect, "farmGoal", FARM_GOALS],
  [elements.plantSelect, "plant", HORTICULTURE_CONTEXTS.plants],
  [elements.gardenSettingSelect, "gardenSetting", HORTICULTURE_CONTEXTS.settings],
  [elements.gardenSoilSelect, "gardenSoil", HORTICULTURE_CONTEXTS.soils],
  [elements.gardenGoalSelect, "gardenGoal", HORTICULTURE_CONTEXTS.goals]
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
    setViewFeedback(isGerman()
      ? `Ein verfügbares Datum zwischen ${state.availableDates[0]} und ${state.availableDates.at(-1)} wählen.`
      : `Choose an available date between ${state.availableDates[0]} and ${state.availableDates.at(-1)}.`);
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
  Object.assign(state, parseViewState(window.location.search, browserLanguage));
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

applyDocumentLanguage(document, state.language);
loadApplication();
