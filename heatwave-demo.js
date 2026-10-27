import {
  AUDIENCES,
  FARM_GOALS,
  FIELD_CONTEXTS,
  HORTICULTURE_CONTEXTS,
  LAYERS,
  MODEL_VERSION,
  fillColor,
  freshnessStatus,
  scoreForLayer,
  severity
} from "./heatwave-model.js";
import {
  LOCALE_CODES,
  applyDocumentLanguage,
  profileLabel,
  severityLabel,
  textFor
} from "./heatwave-i18n.js";
import {
  DEFAULT_VIEW,
  parseViewState,
  resolveForecastSelection,
  runtimeSourceFreshness,
  serializeViewState
} from "./heatwave-state.js";
import { warningFeedFreshness } from "./heatwave-warnings.js";
import { createHeatlensDataClient, matchesDefaultContext } from "./heatwave-data.js";
import { installLocationSearch } from "./heatwave-controls.js";
import { createSpatialModel } from "./heatwave-spatial.js";
import { createResultsView } from "./heatwave-results.js";

const dataClient = createHeatlensDataClient();
const preferredBrowserLanguage = navigator.languages?.[0] || navigator.language || "en";
const browserLanguage = String(preferredBrowserLanguage).toLowerCase().startsWith("de") ? "de" : "en";
const initialView = parseViewState(window.location.search, browserLanguage);

const state = {
  ...initialView,
  manifest: null,
  overview: null,
  locations: [],
  loadedStates: new Set(),
  loading: false,
  detailLoading: false,
  dateAdjustment: null,
  selectionNotice: false,
  requestedDate: new URLSearchParams(window.location.search).get("date"),
  pendingManifest: null,
  reloadRequired: false,
  updateStatus: "idle",
  panel: "results",
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
  warningContextStatus: "unavailable",
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
elements.officialWarningContext = document.querySelector("#official-warning-context");
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
for (const [name, id] of Object.entries({
  today: "today-date", dateWindow: "date-window", dateNotice: "requested-date-notice",
  locationSearch: "location-search", locationResults: "location-results", searchStatus: "location-search-status",
  breadcrumbs: "scope-breadcrumbs", updateCheck: "snapshot-update-check", updateApply: "snapshot-update-apply",
  updateStatus: "snapshot-update-status", resultsTab: "results-tab", mapTab: "map-tab",
  application: "application", settings: "personalisation-settings", settingsSummary: "personalisation-settings-summary",
  resetSettings: "reset-personalisation", toggleActions: "toggle-actions",
  filters: "workspace-filters", filterSummary: "workspace-filter-summary", filterContext: "workspace-filter-context"
})) elements[name] = document.getElementById(id);
const narrowWorkspace = window.matchMedia("(max-width: 700px)");
const syncFilterLayout = () => { elements.filters.open = !narrowWorkspace.matches; };
narrowWorkspace.addEventListener("change", syncFilterLayout);
syncFilterLayout();

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const isGerman = () => state.language === "de";
const ui = (key, values) => textFor(state.language, key, values);
const localizedProfile = (group, key, fallback) => profileLabel(state.language, group, key, fallback);
const localizedSeverity = (level) => severityLabel(state.language, level);
const { assignSpatialHierarchy, metricsForUnit } = createSpatialModel({ state, featureId, clamp });
const { renderDetails, warningContextForUnit, warningContextStatus } = createResultsView({
  state, elements, isGerman, ui, localizedProfile, localizedSeverity, formatDate, formatTimestamp,
  featureName, metricsForUnit, selectedUnit, berlinToday, staleSourceNames
});

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
  return isGerman() ? `vor ${hours} ${hours === 1 ? "Stunde" : "Stunden"} aktualisiert` : `updated ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
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
  if (state.selectedDistrict && !state.locations.some((item) => item.id === state.selectedDistrict)) state.selectedDistrict = null;
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
  renderWorkbenchControls();
  if (state.updateStatus === "applying") setDataControlsDisabled(true);
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
    label.textContent = label.dataset.legendLabel === "unavailable" && state.level === "state" && !matchesDefaultContext(state)
      ? isGerman() ? "Region für diese Auswahl laden" : "Load region for this configuration"
      : labels[label.dataset.legendLabel];
  });
  elements.coverage.textContent = plain
    ? isGerman()
      ? `${state.stateFeatures.length} Bundesländer mit Kreis- und lokaler Detailansicht`
      : `${state.stateFeatures.length} states with district and local detail`
    : isGerman()
      ? `${state.stateFeatures.length} Bundesländer / 400 NUTS-3 / ${state.manifest?.basinCount || 614} Einzugsgebiete`
      : `${state.stateFeatures.length} states / 400 NUTS-3 / ${state.manifest?.basinCount || 614} basins`;
  elements.selectedDateValue.textContent = formatDate(state.date);
  elements.predictionUnit.textContent = plain
    ? isGerman() ? "Lokale Einzugsgebiete" : "Local drainage areas"
    : isGerman() ? "HydroBASINS L8 / Beobachtungen + EPS" : "HydroBASINS L8 / observed + EPS";
  elements.dataStatus.textContent = plain
    ? state.freshness.stale
      ? isGerman() ? "Veraltet - Hinweise pausiert" : "Out of date - advice paused"
      : isGerman() ? `Aktuell, ${freshnessText()}` : `Current, ${freshnessText()}`
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
  const patch = level === "state"
    ? { selectedState: id, selectedDistrict: null, selectedBasin: null, level: drill ? "district" : "state" }
    : level === "district"
      ? { selectedState: id.slice(0, 3), selectedDistrict: id, selectedBasin: null, level: "district" }
      : { selectedBasin: id, level: "basin" };
  return applyViewPatch(patch);
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
  const metrics = metricsForUnit(state.level, id);
  const score = scoreForLayer(metrics, state.layer);
  const level = severity(score);
  const scoreLabel = Number.isFinite(score) ? score : isGerman() ? "kein Wert" : "no score";
  const content = document.createElement("span");
  const name = document.createElement("strong");
  const detail = document.createElement("span");
  name.textContent = featureName(feature, state.level);
  detail.textContent = metrics.pending
    ? isGerman() ? "Auswählen, um diese Konfiguration zu berechnen." : "Select to calculate this configuration."
    : state.detail === "plain"
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
      layer.on("click", () => selectMapUnit(featureLevel, id));
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

function setPanel(panel) {
  state.panel = panel;
  elements.application.dataset.view = panel;
  for (const [tab, name] of [[elements.resultsTab, "results"], [elements.mapTab, "map"]]) {
    tab.setAttribute("aria-selected", String(panel === name));
    tab.tabIndex = panel === name ? 0 : -1;
  }
  if (panel === "map") window.requestAnimationFrame(() => state.mapInstance?.invalidateSize({ animate: false, pan: false }));
}

function renderWorkbenchControls() {
  const selected = selectedUnit();
  elements.filterContext.textContent = `${featureName(selected.feature, selected.level)} · ${formatDate(state.date)} · ${localizedProfile("audiences", state.audience, AUDIENCES[state.audience])}`;
  const adjustment = state.dateAdjustment;
  elements.dateNotice.hidden = !adjustment && !state.selectionNotice;
  const dateMessage = adjustment ? ui(adjustment.reason === "invalid" ? "requestedDateInvalid" : "requestedDateAdjusted", {
    requested: adjustment.requestedDate, displayed: formatDate(adjustment.date)
  }) : "";
  elements.dateNotice.textContent = [dateMessage, state.selectionNotice ? isGerman()
    ? "Die Region aus dem Link ist nicht verfügbar. Die angezeigte Auswahl wurde auf eine unterstützte Region zurückgesetzt."
    : "The linked region is unavailable. The displayed selection has been reset to a supported region." : ""].filter(Boolean).join(" ");
  const today = berlinToday();
  const focusedDate = elements.dateWindow.contains(document.activeElement) ? document.activeElement.dataset.date : null;
  elements.dateWindow.replaceChildren(...state.availableDates.map((date) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.date = date;
    const kind = date < today ? "past" : date === today ? "today" : "forecast";
    button.dataset.kind = kind;
    button.setAttribute("aria-pressed", String(date === state.date));
    const kindLabel = ui(kind === "past" ? "datePast" : kind === "today" ? "dateToday" : "dateForecast");
    button.setAttribute("aria-label", `${formatDate(date)} · ${kindLabel}`);
    const day = document.createElement("strong");
    day.textContent = new Intl.DateTimeFormat(LOCALE_CODES[state.language], { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
    const label = document.createElement("span");
    label.textContent = kindLabel;
    button.append(day, label);
    button.addEventListener("click", () => selectDate(date));
    return button;
  }));
  if (focusedDate) [...elements.dateWindow.children].find((button) => button.dataset.date === focusedDate)?.focus({ preventScroll: true });
  elements.settings.hidden = !["farmers", "gardeners"].includes(state.audience);
  if (state.audience === "farmers") elements.settingsSummary.textContent = [
    localizedProfile("crops", state.crop, FIELD_CONTEXTS.crops[state.crop].label),
    localizedProfile("stages", state.stage, FIELD_CONTEXTS.stages[state.stage].label),
    localizedProfile("soils", state.soil, FIELD_CONTEXTS.soils[state.soil].label)
  ].join(" · ");
  else if (state.audience === "gardeners") elements.settingsSummary.textContent = [
    localizedProfile("plants", state.plant, HORTICULTURE_CONTEXTS.plants[state.plant].label),
    localizedProfile("settings", state.gardenSetting, HORTICULTURE_CONTEXTS.settings[state.gardenSetting].label)
  ].join(" · ");
  elements.toggleActions.textContent = ui(elements.toggleActions.getAttribute("aria-expanded") === "true" ? "fewerActions" : "moreActions");
  renderBreadcrumbs();
  renderUpdateStatus();
  setPanel(state.panel);
}

function renderBreadcrumbs() {
  const nodes = [];
  const add = (label, patch, current = false) => {
    if (nodes.length) { const separator = document.createElement("span"); separator.textContent = "›"; separator.setAttribute("aria-hidden", "true"); nodes.push(separator); }
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (current) button.setAttribute("aria-current", "location");
    button.addEventListener("click", () => applyViewPatch(patch));
    nodes.push(button);
  };
  add(isGerman() ? "Deutschland" : "Germany", { level: "state", selectedDistrict: null, selectedBasin: null }, state.level === "state");
  const stateFeature = state.stateById.get(state.selectedState);
  if (stateFeature) add(featureName(stateFeature, "state"), { level: "district", selectedDistrict: null, selectedBasin: null }, state.level === "district" && !state.selectedDistrict);
  const district = state.locations.find((item) => item.id === state.selectedDistrict);
  if (district) add(district.name, { level: "district", selectedBasin: null }, state.level === "district");
  if (state.selectedBasin && state.basinById.has(state.selectedBasin)) add(featureName(state.basinById.get(state.selectedBasin), "basin"), { level: "basin" }, true);
  const drill = document.createElement("button");
  drill.type = "button";
  drill.className = "scope-drill";
  drill.textContent = ui(state.level === "state" ? "viewDistricts" : "viewBasins");
  drill.hidden = state.level === "basin";
  drill.addEventListener("click", () => applyViewPatch({ level: state.level === "state" ? "district" : "basin" }));
  nodes.push(drill);
  elements.breadcrumbs.replaceChildren(...nodes);
}

function renderSourceHealth() {
  if (!elements.sourceHealth) {
    elements.sourceHealth = document.createElement("dl");
    elements.sourceHealth.className = "provenance-list source-health-list";
    document.getElementById("source-details").append(elements.sourceHealth);
  }
  const names = { radolan: "RADOLAN", dwdTemperature: isGerman() ? "DWD-Temperatur" : "DWD temperature", ufz: "UFZ", dwdSoil: isGerman() ? "DWD-Boden" : "DWD soil" };
  const rows = Object.entries(state.sourceFreshness.sources).map(([key, source]) => [names[key], `${source.current ? isGerman() ? "Aktuell" : "Current" : isGerman() ? "Veraltet / fehlt" : "Stale / missing"} · ${formatTimestamp(source.validAt)}`]);
  const warnings = warningFeedFreshness(state.liveData.warnings);
  rows.push([isGerman() ? "DWD-Warnfeed" : "DWD warning feed", `${warnings.current ? isGerman() ? "Aktuell" : "Current" : isGerman() ? "Gespeichert / nicht bestätigt" : "Saved / unverified"} · ${formatTimestamp(warnings.issuedAt)}`]);
  rows.push([isGerman() ? "Datenversion" : "Snapshot version", state.manifest.snapshotId]);
  elements.sourceHealth.replaceChildren(...rows.map(([label, text]) => {
    const row = document.createElement("div");
    const term = document.createElement("dt"); term.textContent = label;
    const value = document.createElement("dd"); value.textContent = text;
    row.append(term, value); return row;
  }));
}

function renderAll({ map = true } = {}) {
  if (!state.ready) return;
  applyDocumentLanguage(document, state.language);
  updateOperationalFreshness();
  validateSelection();
  renderControls();
  renderSummary();
  if (map) renderMap();
  renderDetails();
  renderResolutionNote();
  if (state.level === "state" && !matchesDefaultContext(state)) elements.resolutionNote.textContent += isGerman()
    ? " Angepasste Werte werden für geladene Regionen berechnet; weitere Bundesländer zum Laden auswählen."
    : " Custom values are calculated for loaded regions; select another state to load its values.";
  renderSourceHealth();
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
  state.loadedStates.clear();
}

function setDataControlsDisabled(disabled) {
  document.querySelectorAll("[data-level], [data-audience], [data-layer], [data-detail], .field-context-controls select, #date-window button, #scope-breadcrumbs button").forEach((control) => { control.disabled = disabled; });
  for (const control of [elements.dateInput, elements.previousDay, elements.nextDay, elements.today,
    elements.locationSearch, elements.regionSelect, elements.shareView, elements.exportView, elements.resetSettings]) control.disabled = disabled;
}

function setLoading(loading) {
  state.loading = loading;
  elements.map.setAttribute("aria-busy", String(loading));
  setDataControlsDisabled(loading);
  // Language, official-service links, view tabs and retry remain usable.
  elements.retryLoad.hidden = !loading;
  elements.retryLoad.disabled = false;
  if (loading) {
    elements.retryLoad.hidden = true;
    elements.mapStatus.textContent = isGerman() ? "Die Deutschlandübersicht wird geladen." : "Loading the Germany overview.";
    elements.riskLevel.textContent = ui("loading");
  }
}

let navigationSequence = 0;
let loadSequence = 0;
let updateCheckTime = 0;

function berlinToday() {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function mergeBundle(bundle) {
  validateLivePayload(bundle.livePayload, bundle.basins.features);
  const mergeFeatures = (current, next, key) => [...new Map([...current, ...next].map((feature) => [key(feature), feature])).values()];
  state.districtFeatures = mergeFeatures(state.districtFeatures, bundle.districts.features, (feature) => feature.properties.NUTS_ID);
  state.basinFeatures = mergeFeatures(state.basinFeatures, bundle.basins.features, (feature) => String(feature.properties.HYBAS_ID));
  state.crosswalk = [...new Map([...state.crosswalk, ...bundle.crosswalk].map((record) => [`${record.NUTS_ID}|${record.HYBAS_ID}`, record])).values()];
  for (const basin of bundle.livePayload.basins) {
    state.liveByBasin.set(String(basin.id), new Map(basin.days.map((day) => [day.date, { ...basin.context, ...day }])));
  }
  state.loadedStates.add(bundle.stateId);
  state.predictionCache.clear();
  state.metricCache.clear();
  assignSpatialHierarchy();
}

async function ensureState(stateId) {
  if (state.loadedStates.has(stateId)) return;
  const manifest = state.manifest;
  const bundle = await dataClient.loadState(stateId, manifest);
  if (state.manifest?.snapshotId !== manifest.snapshotId) throw new Error("The snapshot changed while loading this region");
  mergeBundle(bundle);
}

function detailStateFor(view) {
  return view.level !== "state" || !matchesDefaultContext(view)
    ? view.selectedDistrict?.slice(0, 3) || view.selectedState : null;
}

async function applyViewPatch(patch, { clearDateNotice = false, map = true } = {}) {
  if (state.updateStatus === "applying") return;
  const sequence = ++navigationSequence;
  const view = { ...state, ...patch };
  const neededState = detailStateFor(view);
  try {
    if (neededState && !state.loadedStates.has(neededState)) {
      state.detailLoading = true;
      elements.map.setAttribute("aria-busy", "true");
      elements.viewFeedback.textContent = isGerman() ? "Details werden geladen; die Übersicht bleibt verfügbar." : "Loading regional detail; the overview remains available.";
      await ensureState(neededState);
    }
    if (sequence !== navigationSequence) return;
    Object.assign(state, patch);
    if (clearDateNotice) state.dateAdjustment = null;
    state.detailLoading = false;
    state.failedPatch = null;
    state.selectionNotice = false;
    elements.retryLoad.hidden = true;
    delete elements.retryLoad.dataset.region;
    elements.map.setAttribute("aria-busy", "false");
    elements.viewFeedback.textContent = "";
    renderAll({ map });
    if (narrowWorkspace.matches && (patch.selectedState || patch.selectedDistrict || patch.selectedBasin)) {
      const hadFilterFocus = elements.filters.contains(document.activeElement);
      elements.filters.open = false;
      if (hadFilterFocus) elements.filterSummary.focus({ preventScroll: true });
    }
  } catch (error) {
    if (sequence !== navigationSequence) return;
    state.detailLoading = false;
    elements.map.setAttribute("aria-busy", "false");
    elements.retryLoad.hidden = false;
    elements.retryLoad.disabled = false;
    elements.retryLoad.dataset.region = neededState || "";
    elements.viewFeedback.textContent = isGerman()
      ? "Regionsdetails konnten nicht geladen werden. Die bisherige Ansicht bleibt erhalten. Erneut versuchen."
      : "Regional detail could not load. Your previous view is preserved. Retry to try again.";
    state.failedPatch = patch;
    console.error(error);
    // A deployment may have retired the old immutable URL. Offer the new
    // snapshot while keeping the already verified view on screen.
    checkForUpdates();
  }
}

function renderUpdateStatus() {
  const key = { idle: "snapshotUpdateHint", checking: "updateChecking", available: "updateAvailable", current: "updateCurrent", failed: "updateFailed", applying: "updatingSnapshot" }[state.updateStatus];
  elements.updateStatus.textContent = state.reloadRequired
    ? isGerman() ? "Eine neue Anwendungsversion ist verfügbar. Seite neu laden." : "A new application version is available. Reload the page."
    : ui(key || "snapshotUpdateHint");
  elements.updateStatus.dataset.state = state.updateStatus;
  elements.updateCheck.disabled = state.updateStatus === "checking" || state.updateStatus === "applying";
  elements.updateApply.hidden = !state.pendingManifest && !state.reloadRequired;
  elements.updateApply.textContent = state.reloadRequired ? isGerman() ? "Seite neu laden" : "Reload page" : ui("applyUpdate");
  elements.updateApply.disabled = ["checking", "applying"].includes(state.updateStatus);
}

async function checkForUpdates({ quiet = false } = {}) {
  if (state.loading || ["checking", "applying"].includes(state.updateStatus)) return;
  if (quiet && Date.now() - updateCheckTime < 5 * 60_000) return;
  updateCheckTime = Date.now();
  state.updateStatus = "checking";
  const sequence = loadSequence;
  renderUpdateStatus();
  try {
    const manifest = await dataClient.checkManifest();
    if (sequence !== loadSequence || state.updateStatus !== "checking") return;
    state.pendingManifest = manifest.snapshotId !== state.manifest?.snapshotId ? manifest : null;
    state.reloadRequired = false;
    state.updateStatus = state.pendingManifest ? "available" : quiet ? "idle" : "current";
  } catch (error) {
    if (sequence !== loadSequence || state.updateStatus !== "checking") return;
    state.updateStatus = "failed";
    state.reloadRequired = /model version changed/i.test(error.message);
    console.error(error);
  }
  renderUpdateStatus();
}

function renderLoadFailure() {
  const message = isGerman()
    ? "Die geprüfte Übersicht konnte nicht geladen werden. Verbindung prüfen und erneut versuchen. Amtliche Dienste bleiben erreichbar."
    : "The validated overview could not load. Check your connection and retry. Official services remain available.";
  elements.mapStatus.setAttribute("role", "alert");
  elements.mapStatus.textContent = message;
  elements.regionSummary.textContent = message;
  elements.riskLevel.textContent = isGerman() ? "Nicht verfügbar" : "Unavailable";
  elements.actionList.replaceChildren();
  elements.toggleActions.hidden = true;
  elements.decisionNote.textContent = isGerman()
    ? "Ohne geprüfte Daten werden keine Handlungshinweise erzeugt. Aktuelle amtliche und lokale Quellen prüfen."
    : "Advice is unavailable until validated data can be loaded. Check current official and local sources.";
  elements.officialWarningHeading.textContent = isGerman() ? "DWD-Warnfeed nicht geladen" : "DWD warning feed not loaded";
  for (const title of [elements.officialHeatTitle, elements.officialRainTitle]) title.textContent = isGerman() ? "Amtliche Warnlage direkt beim DWD prüfen" : "Check DWD directly for official warnings";
  elements.officialWarningContext.replaceChildren();
}

async function loadApplication({ manifest: suppliedManifest } = {}) {
  const sequence = ++loadSequence;
  ++navigationSequence;
  const hadOverview = state.ready;
  if (!hadOverview) setLoading(true);
  state.updateStatus = "applying";
  setDataControlsDisabled(true);
  elements.map.setAttribute("aria-busy", "true");
  renderUpdateStatus();
  try {
    initializeMap();
    const next = await dataClient.loadOverview(suppliedManifest || {});
    if (sequence !== loadSequence) return;
    const d3 = globalThis.d3;
    if (!d3?.geoCentroid) throw new Error("Bundled D3 geography library unavailable");
    const requested = hadOverview ? state.date : state.requestedDate;
    const intended = Object.fromEntries(Object.keys(DEFAULT_VIEW).map((key) => [key, state[key]]));
    let selectionAdjusted = false;
    if (!next.manifest.states[intended.selectedState]) { intended.selectedState = DEFAULT_VIEW.selectedState; selectionAdjusted = true; }
    const linkedDistrict = intended.selectedDistrict && next.locations.find((item) => item.level === "district" && item.id === intended.selectedDistrict);
    if (intended.selectedDistrict && !linkedDistrict) {
      intended.selectedDistrict = null; intended.selectedBasin = null; intended.level = "state"; selectionAdjusted = true;
    } else if (linkedDistrict) intended.selectedState = linkedDistrict.stateId;
    if (intended.selectedBasin && !next.overview.basinIndex?.some((item) => item.id === intended.selectedBasin && item.stateId)) {
      intended.selectedBasin = null; intended.level = intended.selectedDistrict ? "district" : "state"; selectionAdjusted = true;
    }
    if (intended.selectedBasin && !intended.selectedDistrict) {
      const basin = next.overview.basinIndex?.find((item) => item.id === intended.selectedBasin);
      if (basin?.districtId) { intended.selectedDistrict = basin.districtId; intended.selectedState = basin.stateId; }
    }
    const nextFallback = next.manifest.forecastDates.includes(berlinToday()) ? berlinToday()
      : next.manifest.forecastDates[next.metadata.forecast.pastDays || 0];
    const nextDate = resolveForecastSelection(requested, next.manifest.forecastDates, nextFallback);
    intended.date = nextDate.date;
    const neededState = detailStateFor(intended);
    const preparedBundle = hadOverview && neededState ? await dataClient.loadState(neededState, next.manifest) : null;
    if (sequence !== loadSequence) return;
    intended.language = state.language;
    // Only commit a complete, verified overview. Failed update downloads leave the current view intact.
    resetSpatialState();
    state.d3 = d3;
    state.manifest = next.manifest;
    state.overview = next.overview;
    state.locations = next.locations.map((item) => ({ ...item, stateName: next.locations.find((parent) => parent.level === "state" && parent.id === item.stateId)?.name || "" }));
    state.stateFeatures = next.states.features;
    state.liveData = { ...next.metadata, basins: [] };
    state.availableDates = [...state.liveData.forecast.dates];
    state.stateFeatures.forEach((feature) => state.stateById.set(featureId(feature, "state"), feature));
    for (const [id, profile] of Object.entries(next.profiles)) state.stateProfile.set(id, profile);
    state.date = nextDate.date;
    state.dateAdjustment = nextDate.adjusted ? nextDate : null;
    state.selectionNotice = selectionAdjusted;
    // Render the useful national view before downloading district or personalised detail.
    state.selectedState = intended.selectedState;
    state.level = "state";
    state.selectedDistrict = null;
    state.selectedBasin = null;
    if (preparedBundle) { mergeBundle(preparedBundle); Object.assign(state, intended); }
    else if (!matchesDefaultContext(state)) Object.assign(state, DEFAULT_CONTEXT_FOR_AUDIENCE(state.audience));
    state.ready = true;
    state.pendingManifest = null;
    state.reloadRequired = false;
    state.failedPatch = null;
    state.updateStatus = "current";
    setLoading(false);
    elements.retryLoad.hidden = true;
    renderAll();
    if (!preparedBundle && detailStateFor(intended)) await applyViewPatch(intended);
  } catch (error) {
    if (sequence !== loadSequence) return;
    setLoading(false);
    state.updateStatus = "failed";
    state.reloadRequired = /model version changed/i.test(error.message);
    state.failedPatch = null;
    elements.retryLoad.hidden = false;
    elements.retryLoad.disabled = false;
    if (!hadOverview) {
      state.ready = false;
      setDataControlsDisabled(true);
      renderLoadFailure();
    }
    console.error(error);
    if (hadOverview) renderControls();
  }
  renderUpdateStatus();
}

function DEFAULT_CONTEXT_FOR_AUDIENCE(audience) {
  const keys = audience === "farmers" ? ["crop", "stage", "soil", "farmGoal"]
    : audience === "gardeners" ? ["plant", "gardenSetting", "gardenSoil", "gardenGoal"] : [];
  return Object.fromEntries(keys.map((key) => [key, DEFAULT_VIEW[key]]));
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
      snapshotId: state.manifest?.snapshotId,
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
    warningContext: warningContextForUnit(unit),
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

installLocationSearch({
  input: elements.locationSearch, list: elements.locationResults, status: elements.searchStatus,
  getItems: () => state.locations,
  label: (item, count) => item
    ? `${item.name} · ${ui(item.level === "state" ? "searchStateType" : "searchDistrictType")}${item.level === "district" ? ` · ${item.stateName}` : ""}`
    : ui(count ? "searchResultsCount" : "searchNoResults", { count }),
  onSelect: (item) => selectMapUnit(item.level, item.id)
});

elements.languageButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (button.dataset.language === state.language) return;
    state.language = button.dataset.language;
    applyDocumentLanguage(document, state.language);
    if (state.ready) renderAll();
    else {
      if (state.loading) setLoading(true);
      else if (state.updateStatus === "failed") renderLoadFailure();
      persistViewState();
    }
    renderUpdateStatus();
  });
});

document.querySelectorAll("[data-level]").forEach((button) => button.addEventListener("click", () => {
  const level = button.dataset.level;
  applyViewPatch({ level, ...(level === "state" ? { selectedDistrict: null, selectedBasin: null }
    : level === "district" ? { selectedBasin: null } : {}) });
}));
document.querySelectorAll("[data-audience]").forEach((button) => button.addEventListener("click", () => applyViewPatch({ audience: button.dataset.audience })));
document.querySelectorAll("[data-layer]").forEach((button) => button.addEventListener("click", () => applyViewPatch({ layer: button.dataset.layer })));
document.querySelectorAll("[data-detail]").forEach((button) => button.addEventListener("click", () => applyViewPatch({ detail: button.dataset.detail }, { map: false })));

[
  [elements.cropSelect, "crop", FIELD_CONTEXTS.crops], [elements.stageSelect, "stage", FIELD_CONTEXTS.stages],
  [elements.soilSelect, "soil", FIELD_CONTEXTS.soils], [elements.farmGoalSelect, "farmGoal", FARM_GOALS],
  [elements.plantSelect, "plant", HORTICULTURE_CONTEXTS.plants], [elements.gardenSettingSelect, "gardenSetting", HORTICULTURE_CONTEXTS.settings],
  [elements.gardenSoilSelect, "gardenSoil", HORTICULTURE_CONTEXTS.soils], [elements.gardenGoalSelect, "gardenGoal", HORTICULTURE_CONTEXTS.goals]
].forEach(([select, key, options]) => select.addEventListener("change", () => {
  if (Object.hasOwn(options, select.value)) applyViewPatch({ [key]: select.value });
}));

function selectDate(date) {
  if (!state.availableDates.includes(date)) return;
  return applyViewPatch({ date }, { clearDateNotice: true });
}
elements.dateInput.addEventListener("change", () => {
  if (state.availableDates.includes(elements.dateInput.value)) selectDate(elements.dateInput.value);
  else { elements.dateInput.value = state.date; setViewFeedback(isGerman() ? "Ein Datum aus dem verfügbaren Zeitraum wählen." : "Choose a date within the available window."); }
});
elements.previousDay.addEventListener("click", () => selectDate(state.availableDates[state.availableDates.indexOf(state.date) - 1]));
elements.nextDay.addEventListener("click", () => selectDate(state.availableDates[state.availableDates.indexOf(state.date) + 1]));
elements.today.addEventListener("click", () => {
  const resolution = resolveForecastSelection(berlinToday(), state.availableDates, state.date);
  state.dateAdjustment = resolution.adjusted ? resolution : null;
  applyViewPatch({ date: resolution.date });
});
elements.regionSelect.addEventListener("change", () => { if (elements.regionSelect.value) selectMapUnit(state.level, elements.regionSelect.value); });
elements.scopeBack.addEventListener("click", () => applyViewPatch(state.level === "basin" && state.selectedDistrict
  ? { level: "district", selectedBasin: null } : { level: "state", selectedDistrict: null, selectedBasin: null }));
elements.retryLoad.addEventListener("click", () => {
  if (state.ready && state.failedPatch) { const patch = state.failedPatch; state.failedPatch = null; applyViewPatch(patch); }
  else loadApplication();
});
elements.shareView.addEventListener("click", copyViewLink);
elements.exportView.addEventListener("click", exportSnapshot);
elements.updateCheck.addEventListener("click", () => checkForUpdates());
elements.updateApply.addEventListener("click", () => state.reloadRequired ? window.location.reload() : loadApplication({ manifest: state.pendingManifest }));
elements.resultsTab.addEventListener("click", () => setPanel("results"));
elements.mapTab.addEventListener("click", () => setPanel("map"));
for (const tab of [elements.resultsTab, elements.mapTab]) tab.addEventListener("keydown", (event) => {
  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const panel = event.key === "Home" ? "results" : event.key === "End" ? "map" : state.panel === "results" ? "map" : "results";
    setPanel(panel);
    (panel === "map" ? elements.mapTab : elements.resultsTab).focus();
  }
});
elements.toggleActions.addEventListener("click", () => {
  const expanded = elements.toggleActions.getAttribute("aria-expanded") !== "true";
  elements.toggleActions.setAttribute("aria-expanded", String(expanded));
  elements.toggleActions.closest(".action-block").classList.toggle("is-expanded", expanded);
  elements.toggleActions.textContent = ui(expanded ? "fewerActions" : "moreActions");
});
elements.resetSettings.addEventListener("click", async () => {
  await applyViewPatch(DEFAULT_CONTEXT_FOR_AUDIENCE(state.audience));
  setViewFeedback(ui("resetPersonalisationFeedback"));
});
elements.trend.addEventListener("click", (event) => {
  const date = event.target.closest("circle[data-date]")?.dataset.date;
  if (date) selectDate(date);
});
window.addEventListener("popstate", () => {
  const view = parseViewState(window.location.search, browserLanguage);
  if (state.ready) {
    const resolution = resolveForecastSelection(new URLSearchParams(window.location.search).get("date"), state.availableDates, berlinToday());
    state.dateAdjustment = resolution.adjusted ? resolution : null;
    applyViewPatch({ ...view, date: resolution.date });
  } else Object.assign(state, view);
});
document.addEventListener("visibilitychange", () => { if (!document.hidden && state.ready) checkForUpdates({ quiet: true }); });
window.setInterval(() => {
  if (!state.ready) return;
  const previousStatus = `${state.freshness.label}|${Math.floor(state.freshness.ageHours || 0)}|${state.sourceFreshness.staleSources.join()}`;
  updateOperationalFreshness();
  const nextStatus = `${state.freshness.label}|${Math.floor(state.freshness.ageHours || 0)}|${state.sourceFreshness.staleSources.join()}`;
  const warningStatus = warningContextStatus(warningContextForUnit(selectedUnit()));
  if (previousStatus !== nextStatus || state.warningContextStatus !== warningStatus) renderAll({ map: false });
  if (!document.hidden) checkForUpdates({ quiet: true });
}, 60_000);

applyDocumentLanguage(document, state.language);
loadApplication();
