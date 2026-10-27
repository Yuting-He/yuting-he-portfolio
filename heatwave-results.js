import { AUDIENCES, FARM_GOALS, LAYERS, actionsFor, evidenceConfidence, scoreForLayer, severity } from "./heatwave-model.js";
import { PLAIN_SOURCE_SUMMARY, plainActionCategory, plainActionsFor, plainConfidenceLabel,
  plainDecisionNote, plainLanguageSignals, plainLanguageSummary } from "./heatwave-language.js";
import { PLAIN_SOURCE_SUMMARY_DE, plainActionCategoryDe, plainActionsForDe, plainConfidenceLabelDe,
  plainDecisionNoteDe, plainLanguageSignalsDe, plainLanguageSummaryDe, technicalGuidanceForDe } from "./heatwave-language-de.js";
import { confidenceLabel } from "./heatwave-i18n.js";
import { isRetrospectiveDate } from "./heatwave-state.js";
import { warningContextForState, warningPresentation } from "./heatwave-warnings.js";

export function createResultsView({ state, elements, isGerman, ui, localizedProfile, localizedSeverity,
  formatDate, formatTimestamp, featureName, metricsForUnit, selectedUnit, berlinToday, staleSourceNames }) {
const SVG_NS = "http://www.w3.org/2000/svg";
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
    dot.dataset.date = dates[index];
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
  return warningContextForState(state.liveData.warnings, {
    stateId: stateIdForUnit(unit),
    unitLevel: unit.level,
    selectedDate: state.date
  });
}

function warningContextStatus(context) {
  return JSON.stringify([context.freshness.status, context.dateKind, context.actionOptions]);
}

function renderOfficialWarning(unit) {
  const context = warningContextForUnit(unit);
  const stateFeature = state.stateById.get(context.stateId);
  const presentation = warningPresentation(context, {
    language: state.language,
    stateName: stateFeature ? featureName(stateFeature, "state") : context.stateId
  });
  state.warningContextStatus = warningContextStatus(context);
  elements.officialWarningHeading.textContent = presentation.heading;
  elements.officialWarningContext.replaceChildren(...presentation.shared.map((text) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    return paragraph;
  }));
  elements.officialHeatTitle.textContent = presentation.heat.title;
  elements.officialHeatDetail.textContent = presentation.heat.detail;
  elements.officialHeatDetail.hidden = !presentation.heat.detail;
  elements.officialRainTitle.textContent = presentation.rain.title;
  elements.officialRainDetail.textContent = presentation.rain.detail;
  elements.officialRainDetail.hidden = !presentation.rain.detail;
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
  const currentModelDate = berlinToday();
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
  elements.provenanceList.hidden = false;
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
    elements.toggleActions.hidden = true;
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
  const actionOptions = warningContextForUnit(unit).actionOptions;
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
          ? `${confidenceLabel("de", confidence)} | ${metrics.completeness}% Vollständigkeit der Antriebsdaten | ${metrics.spatialCoverage}% exakte Überlagerung`
          : `${confidence.label} | ${metrics.completeness}% forcing completeness | ${metrics.spatialCoverage}% exact overlap`)
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
  actions.sort((a, b) => Number(b.focus === true) - Number(a.focus === true));
  elements.toggleActions.hidden = actions.length < 2;
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
    : `${isGerman() ? "Evidenzqualität" : "Evidence quality"}: ${confidenceLabel(state.language, confidence)}`;
  elements.decisionNote.textContent = plain
    ? (isGerman() ? plainDecisionNoteDe : plainDecisionNote)(state.audience, { isRetrospective, stale: state.freshness.stale })
    : isRetrospective
    ? isGerman()
      ? "Historische Ansichten dienen nur der Auswertung und Modellbewertung. Sie dürfen nicht als heutige Hinweise für Bevölkerung, Landwirtschaft oder Kommunen gelesen werden; der geladene DWD-Feed ist kein Warnarchiv."
      : "Historical views support review and model evaluation only. They must not be read as present-day resident, farm, or municipal instructions; the loaded DWD feed is not a warning archive."
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

return { renderDetails, warningContextForUnit, warningContextStatus };
}
