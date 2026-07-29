export const MODEL_VERSION = "0.7.0-observed-eps";
export const RECOMMENDATION_POLICY_VERSION = "0.7.0";

export const AUDIENCES = {
  residents: "Residents",
  farmers: "Farmers",
  municipal: "Municipal"
};

export const LAYERS = {
  impact: "Decision impact",
  heat: "Heat stress",
  dry: "Dry stress",
  wet: "Excess-water stress"
};

export const FIELD_CONTEXTS = Object.freeze({
  crops: Object.freeze({
    dominant: Object.freeze({ label: "Local dominant land use", fieldPrefix: "dwdNfkDominant", sensitivity: 55 }),
    grass: Object.freeze({ label: "Grassland", fieldPrefix: "dwdNfkGrass", sensitivity: 45 }),
    maize: Object.freeze({ label: "Maize", fieldPrefix: "dwdNfkMaize", sensitivity: 75 }),
    winterWheat: Object.freeze({ label: "Winter wheat", fieldPrefix: "dwdNfkWinterWheat", sensitivity: 65 })
  }),
  stages: Object.freeze({
    establishment: Object.freeze({ label: "Establishment", sensitivity: 70, rootDepthCm: 30 }),
    vegetative: Object.freeze({ label: "Vegetative", sensitivity: 55, rootDepthCm: 60 }),
    flowering: Object.freeze({ label: "Flowering / yield formation", sensitivity: 85, rootDepthCm: 90 }),
    maturity: Object.freeze({ label: "Maturity", sensitivity: 35, rootDepthCm: 90 })
  }),
  soils: Object.freeze({
    local: Object.freeze({ label: "DWD / BUEK local profile", dryAdjustment: 0, wetAdjustment: 0 }),
    sand: Object.freeze({ label: "Sandy override", dryAdjustment: 7, wetAdjustment: -4 }),
    loam: Object.freeze({ label: "Loamy override", dryAdjustment: 1, wetAdjustment: 1 }),
    clay: Object.freeze({ label: "Clayey override", dryAdjustment: -2, wetAdjustment: 8 })
  })
});

const PREDICTION_FIELDS = [
  "area", "tmaxC", "tminC", "apparentMaxC", "precipitationMm", "precipitation1hMaxMm",
  "et0Mm", "vpdMaxKpa", "soilMoistureM3M3", "waterBalance3dMm", "heatPersistenceDays",
  "dryPersistenceDays", "completeness", "heatScore", "dryStressScore", "wetStressScore"
];
const OPTIONAL_PREDICTION_FIELDS = [
  "ufzTopsoilSmi", "ufzTotalSmi", "ufzPlantAvailableWaterPct",
  "dwdNfkDominantPct", "dwdNfkGrassPct", "dwdNfkMaizePct", "dwdNfkWinterWheatPct",
  "dwdNfkDominant30Pct", "dwdNfkDominant60Pct", "dwdNfkDominant90Pct",
  "dwdNfkGrass30Pct", "dwdNfkGrass60Pct", "dwdNfkGrass90Pct",
  "dwdNfkMaize30Pct", "dwdNfkMaize60Pct", "dwdNfkMaize90Pct",
  "dwdNfkWinterWheat30Pct", "dwdNfkWinterWheat60Pct", "dwdNfkWinterWheat90Pct",
  "radolanPrecipitation24hMm", "dwdObservedTmaxC", "dwdLatestTemperatureC",
  "dwdStationDistanceKm", "ensembleDailyTmaxMeanC", "ensemblePeakHourTemperatureSdC",
  "ensembleDailyPrecipitationMeanMm", "ensembleMaxHourlyPrecipitationSdMm", "ensembleMemberCount"
];

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const round = (value, digits = 0) => Number(value.toFixed(digits));
const normalized = (value, min, max) => clamp((value - min) / (max - min), 0, 1) * 100;
const reverseNormalized = (value, wet, dry) => normalized(wet - value, 0, wet - dry);
const action = (category, text) => ({ category, text });
const optionalNumber = (value, digits = 1) => Number.isFinite(value) ? round(value, digits) : null;

function weightedBlend(parts) {
  const available = parts.filter((part) => Number.isFinite(part.score));
  const totalWeight = available.reduce((sum, part) => sum + part.weight, 0);
  if (!totalWeight) return 0;
  return available.reduce((sum, part) => sum + part.score * part.weight, 0) / totalWeight;
}

export function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function freshnessStatus(generatedAt, now = Date.now()) {
  const generated = Date.parse(generatedAt);
  if (!Number.isFinite(generated)) {
    return { label: "Unavailable", className: "unavailable", ageHours: null, stale: true };
  }
  const ageHours = Math.max(0, (now - generated) / 3_600_000);
  if (ageHours <= 18) return { label: "Current", className: "current", ageHours, stale: false };
  if (ageHours <= 36) return { label: "Delayed", className: "delayed", ageHours, stale: false };
  return { label: "Stale", className: "stale", ageHours, stale: true };
}

export function buildLiveBasinPrediction(basin, day) {
  const id = String(basin.id ?? basin.properties?.HYBAS_ID ?? "");
  const inputs = [
    day?.tmaxC, day?.tminC, day?.apparentMaxC, day?.precipitationMm, day?.precipitation1hMaxMm,
    day?.et0Mm, day?.vpdMaxKpa, day?.soilMoistureM3M3, day?.waterBalance3dMm,
    day?.heatPersistenceDays, day?.dryPersistenceDays, day?.completeness
  ];
  if (!id || !isIsoDate(day?.date) || !inputs.every(Number.isFinite)) {
    throw new TypeError("Live basin prediction requires a basin id, ISO date, and finite source values");
  }

  const heatScore = clamp(
    0.34 * normalized(day.tmaxC, 25, 40) +
    0.30 * normalized(day.apparentMaxC, 26, 42) +
    0.18 * normalized(day.tminC, 16, 26) +
    0.10 * normalized(day.heatPersistenceDays, 0, 4) +
    0.08 * normalized(day.vpdMaxKpa, 0.8, 3.6),
    0,
    100
  );
  const dryStressScore = clamp(weightedBlend([
    { weight: 0.28, score: reverseNormalized(day.soilMoistureM3M3, 0.36, 0.12) },
    { weight: 0.20, score: normalized(-day.waterBalance3dMm, 0, 18) },
    { weight: 0.10, score: normalized(day.et0Mm, 2, 7) },
    { weight: 0.08, score: normalized(day.vpdMaxKpa, 0.8, 3.6) },
    { weight: 0.06, score: normalized(day.dryPersistenceDays, 0, 7) },
    { weight: 0.16, score: Number.isFinite(day.ufzTopsoilSmi) ? reverseNormalized(day.ufzTopsoilSmi, 0.4, 0.02) : null },
    { weight: 0.12, score: Number.isFinite(day.ufzTotalSmi) ? reverseNormalized(day.ufzTotalSmi, 0.35, 0.02) : null }
  ]), 0, 100);
  const wetStressScore = clamp(weightedBlend([
    { weight: 0.30, score: normalized(day.soilMoistureM3M3, 0.30, 0.48) },
    { weight: 0.23, score: normalized(day.waterBalance3dMm, 5, 45) },
    { weight: 0.23, score: normalized(day.precipitationMm, 10, 55) },
    { weight: 0.12, score: normalized(day.precipitation1hMaxMm, 5, 25) },
    { weight: 0.07, score: Number.isFinite(day.ufzTopsoilSmi) ? normalized(day.ufzTopsoilSmi, 0.7, 0.98) : null },
    { weight: 0.05, score: Number.isFinite(day.ufzTotalSmi) ? normalized(day.ufzTotalSmi, 0.7, 0.98) : null }
  ]), 0, 100);

  return {
    id,
    date: day.date,
    area: Math.max(Number(basin.properties?.SUB_AREA) || Number(basin.area) || 1, 0.001),
    tmaxC: round(day.tmaxC, 1),
    tminC: round(day.tminC, 1),
    apparentMaxC: round(day.apparentMaxC, 1),
    precipitationMm: round(day.precipitationMm, 1),
    precipitation1hMaxMm: round(day.precipitation1hMaxMm, 1),
    et0Mm: round(day.et0Mm, 1),
    vpdMaxKpa: round(day.vpdMaxKpa, 2),
    soilMoistureM3M3: round(day.soilMoistureM3M3, 3),
    waterBalance3dMm: round(day.waterBalance3dMm, 1),
    heatPersistenceDays: round(day.heatPersistenceDays),
    dryPersistenceDays: round(day.dryPersistenceDays),
    completeness: round(day.completeness),
    heatScore: round(heatScore),
    dryStressScore: round(dryStressScore),
    wetStressScore: round(wetStressScore),
    ...Object.fromEntries(OPTIONAL_PREDICTION_FIELDS.map((field) => [
      field,
      optionalNumber(day[field], field.includes("Smi") ? 3 : field.includes("Spread") ? 2 : 1)
    ])),
    dwdObservationKind: day.dwdObservationKind || null,
    ensembleModel: day.ensembleModel || null,
    dwdStationId: day.dwdStationId || null,
    dwdStationName: day.dwdStationName || null,
    dwdObservedAt: day.dwdObservedAt || null
  };
}

function weightedAverage(predictions, key) {
  const totalWeight = predictions.reduce((sum, prediction) => sum + prediction.area, 0) || 1;
  return predictions.reduce((sum, prediction) => sum + prediction[key] * prediction.area, 0) / totalWeight;
}

function weightedAverageOptional(predictions, key) {
  const available = predictions.filter((prediction) => Number.isFinite(prediction[key]));
  if (!available.length) return null;
  const totalWeight = available.reduce((sum, prediction) => sum + prediction.area, 0) || 1;
  return available.reduce((sum, prediction) => sum + prediction[key] * prediction.area, 0) / totalWeight;
}

function weightedCoverage(predictions, key) {
  const totalWeight = predictions.reduce((sum, prediction) => sum + prediction.area, 0) || 1;
  const availableWeight = predictions
    .filter((prediction) => Number.isFinite(prediction[key]))
    .reduce((sum, prediction) => sum + prediction.area, 0);
  return availableWeight / totalWeight * 100;
}

export function aggregatePredictions(predictions, {
  audience = "residents",
  exposure = 50,
  cropSensitivity = 55,
  crop = "dominant",
  stage = "vegetative",
  soil = "local"
} = {}) {
  if (!predictions.length) throw new Error("At least one basin prediction is required");
  if (!Object.hasOwn(AUDIENCES, audience)) throw new RangeError(`Unknown audience: ${audience}`);
  const dates = new Set(predictions.map((prediction) => prediction.date));
  if (dates.size !== 1) throw new Error("Basin predictions must share one forecast date");
  if (predictions.some((prediction) => PREDICTION_FIELDS.some((key) => !Number.isFinite(prediction[key])) || prediction.area <= 0)) {
    throw new TypeError("Basin predictions must contain finite live values and positive overlap weights");
  }
  if (!Object.hasOwn(FIELD_CONTEXTS.crops, crop)) throw new RangeError(`Unknown crop profile: ${crop}`);
  if (!Object.hasOwn(FIELD_CONTEXTS.stages, stage)) throw new RangeError(`Unknown crop stage: ${stage}`);
  if (!Object.hasOwn(FIELD_CONTEXTS.soils, soil)) throw new RangeError(`Unknown soil profile: ${soil}`);
  const cropProfile = FIELD_CONTEXTS.crops[crop];
  const stageProfile = FIELD_CONTEXTS.stages[stage];
  const soilProfile = FIELD_CONTEXTS.soils[soil];

  const metrics = {
    basinCount: new Set(predictions.map((item) => item.id)).size,
    coverageAreaKm2: round(predictions.reduce((sum, item) => sum + item.area, 0), 1),
    tmaxC: round(Math.max(...predictions.map((item) => item.tmaxC)), 1),
    tminC: round(weightedAverage(predictions, "tminC"), 1),
    apparentMaxC: round(Math.max(...predictions.map((item) => item.apparentMaxC)), 1),
    precipitationMm: round(weightedAverage(predictions, "precipitationMm"), 1),
    precipitation1hMaxMm: round(Math.max(...predictions.map((item) => item.precipitation1hMaxMm)), 1),
    et0Mm: round(weightedAverage(predictions, "et0Mm"), 1),
    vpdMaxKpa: round(weightedAverage(predictions, "vpdMaxKpa"), 2),
    soilMoistureM3M3: round(weightedAverage(predictions, "soilMoistureM3M3"), 3),
    waterBalance3dMm: round(weightedAverage(predictions, "waterBalance3dMm"), 1),
    heatPersistenceDays: round(Math.max(...predictions.map((item) => item.heatPersistenceDays))),
    dryPersistenceDays: round(weightedAverage(predictions, "dryPersistenceDays")),
    completeness: round(weightedAverage(predictions, "completeness")),
    heatScore: round(weightedAverage(predictions, "heatScore")),
    dryStressScore: round(weightedAverage(predictions, "dryStressScore")),
    wetStressScore: round(weightedAverage(predictions, "wetStressScore")),
    exposure: round(clamp(exposure, 0, 100)),
    cropSensitivity: round(clamp(
      audience === "farmers"
        ? (cropProfile.sensitivity + stageProfile.sensitivity) / 2
        : cropSensitivity,
      0,
      100
    )),
    crop,
    stage,
    soil,
    cropLabel: cropProfile.label,
    stageLabel: stageProfile.label,
    soilLabel: soilProfile.label
  };
  for (const field of OPTIONAL_PREDICTION_FIELDS) {
    const value = weightedAverageOptional(predictions, field);
    metrics[field] = optionalNumber(value, field.includes("Smi") ? 3 : field.includes("Spread") ? 2 : 1);
  }
  const stationDistances = predictions
    .map((prediction) => prediction.dwdStationDistanceKm)
    .filter(Number.isFinite);
  metrics.dwdStationMaxDistanceKm = stationDistances.length
    ? round(Math.max(...stationDistances), 1)
    : null;
  const observedPairs = predictions.filter((prediction) => Number.isFinite(prediction.dwdObservedTmaxC));
  const latestTemperatures = predictions.map((prediction) => prediction.dwdLatestTemperatureC).filter(Number.isFinite);
  if (observedPairs.length) {
    const observedArea = observedPairs.reduce((sum, prediction) => sum + prediction.area, 0);
    const areaWeighted = (valueFor) => observedPairs.reduce(
      (sum, prediction) => sum + valueFor(prediction) * prediction.area,
      0
    ) / observedArea;
    metrics.dwdObservedTmaxC = round(areaWeighted((prediction) => prediction.dwdObservedTmaxC), 1);
    metrics.temperatureValidationBiasC = round(areaWeighted(
      (prediction) => prediction.tmaxC - prediction.dwdObservedTmaxC
    ), 1);
    metrics.temperatureValidationMaeC = round(areaWeighted(
      (prediction) => Math.abs(prediction.tmaxC - prediction.dwdObservedTmaxC)
    ), 1);
    metrics.dwdObservedStationCount = new Set(
      observedPairs.map((prediction) => prediction.dwdStationId).filter(Boolean)
    ).size;
  }
  if (latestTemperatures.length) metrics.dwdLatestTemperatureC = round(Math.max(...latestTemperatures), 1);
  metrics.rootDepthCm = stageProfile.rootDepthCm;
  const selectedDwdNfkField = `${cropProfile.fieldPrefix}${stageProfile.rootDepthCm}Pct`;
  metrics.dwdNfkCoveragePct = round(weightedCoverage(predictions, selectedDwdNfkField));
  metrics.dwdNfkPct = metrics.dwdNfkCoveragePct >= 85 ? metrics[selectedDwdNfkField] : null;
  metrics.ensembleModel = predictions.find((prediction) => prediction.ensembleModel)?.ensembleModel || null;
  metrics.dwdObservationKind = observedPairs.length && observedPairs.every(
    (prediction) => prediction.dwdObservationKind === "complete-day"
  ) ? "complete-day" : predictions.find((prediction) => prediction.dwdObservationKind)?.dwdObservationKind || null;
  metrics.dwdStationName = predictions.find((prediction) => prediction.dwdStationName)?.dwdStationName || null;
  metrics.dwdObservedAt = predictions.map((prediction) => prediction.dwdObservedAt).filter(Boolean).sort().at(-1) || null;
  if (Number.isFinite(metrics.dwdNfkPct)) {
    const cropDrySignal = normalized(50 - metrics.dwdNfkPct, 0, 40);
    const cropWetSignal = normalized(metrics.dwdNfkPct, 90, 135);
    metrics.dryStressScore = round(clamp(0.82 * metrics.dryStressScore + 0.18 * cropDrySignal +
      soilProfile.dryAdjustment, 0, 100));
    metrics.wetStressScore = round(clamp(0.88 * metrics.wetStressScore + 0.12 * cropWetSignal +
      soilProfile.wetAdjustment, 0, 100));
  } else {
    metrics.dryStressScore = round(clamp(metrics.dryStressScore + soilProfile.dryAdjustment, 0, 100));
    metrics.wetStressScore = round(clamp(metrics.wetStressScore + soilProfile.wetAdjustment, 0, 100));
  }
  metrics.temperatureValidationErrorC = metrics.temperatureValidationBiasC ?? null;

  const audienceScores = {
    residents: 0.72 * metrics.heatScore + 0.13 * metrics.exposure +
      0.07 * metrics.dryStressScore + 0.08 * metrics.wetStressScore,
    farmers: 0.34 * metrics.dryStressScore + 0.28 * metrics.wetStressScore +
      0.20 * metrics.heatScore + 0.18 * metrics.cropSensitivity,
    municipal: 0.50 * metrics.heatScore + 0.22 * metrics.wetStressScore +
      0.18 * metrics.exposure + 0.05 * metrics.dryStressScore +
      0.05 * normalized(metrics.heatPersistenceDays, 0, 4)
  };
  metrics.impactScore = round(clamp(audienceScores[audience], 0, 100));
  return metrics;
}

export function scoreForLayer(metrics, layer) {
  if (layer === "heat") return metrics.heatScore;
  if (layer === "dry") return metrics.dryStressScore;
  if (layer === "wet") return metrics.wetStressScore;
  if (layer === "impact") return metrics.impactScore;
  throw new RangeError(`Unknown risk layer: ${layer}`);
}

export function severity(score) {
  if (!Number.isFinite(score)) return { label: "Unavailable", className: "unavailable" };
  if (score >= 75) return { label: "Very high", className: "extreme" };
  if (score >= 55) return { label: "High", className: "severe" };
  if (score >= 35) return { label: "Moderate", className: "elevated" };
  return { label: "Low", className: "watch" };
}

export function fillColor(score) {
  if (!Number.isFinite(score)) return "#9aa7ac";
  if (score >= 75) return "#a83b35";
  if (score >= 55) return "#d56a2d";
  if (score >= 35) return "#d5ab3a";
  return "#6f9f99";
}

export function evidenceConfidence(metrics) {
  let score = 0.55 * clamp(metrics.completeness ?? 0, 0, 100) +
    0.25 * clamp(metrics.spatialCoverage ?? 100, 0, 100) +
    20;
  const reasons = [];
  if (Number.isFinite(metrics.ensemblePeakHourTemperatureSdC)) {
    score -= 0.22 * normalized(metrics.ensemblePeakHourTemperatureSdC, 0.8, 4.5);
    score -= 0.10 * normalized(metrics.ensembleMaxHourlyPrecipitationSdMm, 0.5, 8);
    reasons.push(`${metrics.ensembleMemberCount || "ICON"}-member standard deviations included`);
  } else {
    reasons.push("no ensemble dispersion for this date");
  }
  if (Number.isFinite(metrics.temperatureValidationMaeC)) {
    if (metrics.dwdObservationKind === "complete-day") {
      score -= 0.18 * normalized(metrics.temperatureValidationMaeC, 1, 6);
      reasons.push(`${metrics.dwdObservedStationCount || 1} DWD temperature station${metrics.dwdObservedStationCount === 1 ? "" : "s"} validated`);
    } else {
      score -= 8;
      reasons.push("provisional DWD day-so-far check");
    }
  } else if (!Number.isFinite(metrics.ensemblePeakHourTemperatureSdC)) {
    score -= 18;
    reasons.push("no matched temperature observation");
  }
  const stationDistance = metrics.dwdStationMaxDistanceKm ?? metrics.dwdStationDistanceKm;
  if (Number.isFinite(stationDistance) && stationDistance > 35) {
    score -= Math.min(12, (stationDistance - 35) * 0.25);
    reasons.push("some matched temperature stations are not local");
  }
  score = round(clamp(score, 0, 100));
  if (score >= 78) return { label: "Stronger evidence", className: "strong", score, reason: reasons.join("; ") };
  if (score >= 58) return { label: "Moderate evidence", className: "moderate", score, reason: reasons.join("; ") };
  return { label: "Limited evidence", className: "limited", score, reason: reasons.join("; ") };
}

function officialCheck(options) {
  const heat = options?.heatWarningCount > 0;
  const rain = options?.rainWarningCount > 0;
  if (heat && rain) return "Active DWD heat and rain warnings are present; open the official warning details before acting.";
  if (heat) return "An active DWD heat warning is present; open the official warning details before acting.";
  if (rain) return "An active DWD rain warning is present; open the official warning details and the state flood portal before acting.";
  return "Check the current DWD warning service and, for runoff or river concerns, the responsible state flood portal.";
}

export function actionsFor(metrics, audience, options = {}) {
  const peakWindow = metrics.apparentMaxC >= 32 ? "11:00-18:00" : "12:00-17:00";
  const heatBand = severity(metrics.heatScore);
  const dryBand = severity(metrics.dryStressScore);
  const wetBand = severity(metrics.wetStressScore);
  const actions = [];
  const nfkStatus = Number.isFinite(metrics.dwdNfkPct)
    ? metrics.dwdNfkPct < 30
      ? `${metrics.dwdNfkPct}% nFK: DWD modelled plant water stress range`
      : metrics.dwdNfkPct < 50
        ? `${metrics.dwdNfkPct}% nFK: DWD modelled water-limitation range`
        : metrics.dwdNfkPct > 100
          ? `${metrics.dwdNfkPct}% nFK: high local profile saturation`
          : `${metrics.dwdNfkPct}% nFK`
    : "DWD crop-specific nFK unavailable at this location";

  if (audience === "farmers") {
    actions.push(action(
      "Verify",
      `Check representative fields for ${metrics.cropLabel || "the selected crop"} at root depth before changing operations. ` +
      `${nfkStatus}; compare it with field measurements, recent rainfall, the selected ${metrics.stageLabel || "growth stage"}, and local water rules.`
    ));
    if (metrics.dryStressScore >= 35) {
      actions.push(action(
        dryBand.label,
        metrics.dryStressScore >= 75
          ? "Escalate to field-by-field review: prioritise critical crop stages and shallow or light soils, check root-zone depletion and irrigation-system capacity, verify water availability and restrictions, and obtain agronomic confirmation before any major intervention."
          : metrics.dryStressScore >= 55
            ? "Prioritise vulnerable crop stages and shallow or light soils for inspection; compare UFZ SMI, DWD nFK, a measured root-zone profile, and a locally calibrated irrigation trigger before scheduling."
            : "Track soil moisture and crop symptoms more often; prepare an irrigation check when measured nFK approaches the local trigger, but do not infer an application volume from this index."
      ));
    }
    if (metrics.wetStressScore >= 35) {
      actions.push(action(
        wetBand.label,
        metrics.wetStressScore >= 75
          ? "Keep heavy machinery off saturated or flooded fields, prioritise people and livestock safety, activate the farm flood checklist, and use official flood information before access or drainage decisions."
          : metrics.wetStressScore >= 55
            ? "Postpone traffic on saturated or plastic soils where feasible, inspect drainage outlets and erosion paths safely, and scout waterlogging-related crop and disease symptoms."
            : "Inspect low-lying and poorly drained fields before machinery access; review drainage, compaction, erosion, and disease exposure."
      ));
    }
    if (metrics.heatScore >= 35) {
      actions.push(action(
        heatBand.label,
        `Review heat-sensitive crop stages, livestock water and shade, worker exposure, and time strenuous work outside ${peakWindow}.`
      ));
    }
    actions.push(action(
      "Do not automate",
      "Do not change harvest timing, irrigation volume, pesticide use, or another costly irreversible operation from this screening index alone; obtain agronomic and local forecast confirmation."
    ));
    return {
      actions: actions.slice(0, 5),
      dominantHazard: metrics.wetStressScore > metrics.dryStressScore ? "excess water" : "dry stress",
      policyVersion: RECOMMENDATION_POLICY_VERSION,
      note: "Farm guidance is a staged monitoring checklist. Field observations, crop and soil parameters, official forecasts, water rules, labels, and qualified advice remain decisive."
    };
  }

  if (audience === "municipal") {
    actions.push(action("Official check", officialCheck(options)));
    if (metrics.heatScore >= 35) {
      actions.push(action(
        heatBand.label,
        `Review heat-plan triggers, vulnerable-person outreach, care facilities, cool spaces, drinking water, and outdoor-work arrangements for the ${peakWindow} modelled peak.`
      ));
    }
    if (metrics.wetStressScore >= 35) {
      actions.push(action(
        wetBand.label,
        metrics.wetStressScore >= 75
          ? "Escalate to the responsible authority: verify official flood and rain warnings, live gauges and local sensors; only authorised teams may decide road closures, pumping, evacuation, or emergency deployment."
          : metrics.wetStressScore >= 55
            ? "Inspect known drainage and underpass hotspots, clear operationally safe inlets, verify pumps and duty rosters, and coordinate road or field-access readiness."
            : "Review drainage hotspots, saturated green spaces, construction sites, erosion paths, and on-call capacity before heavier rainfall."
      ));
    }
    if (metrics.dryStressScore >= 35) {
      actions.push(action(
        dryBand.label,
        metrics.dryStressScore >= 75
          ? "Escalate water-continuity, young-tree, critical-green-space, and fire-readiness checks; only the responsible authority may activate restrictions or supply measures."
          : metrics.dryStressScore >= 55
            ? "Prioritise young trees and critical public planting using measured soil checks; review watering restrictions, fire-weather context, and water availability."
            : "Increase measured checks for young trees and heat-sensitive public planting; review leaks, planned watering, and local water rules."
      ));
    }
    actions.push(action(
      "Activation gate",
      "Use observations, DWD or BBK warnings, state flood information, local thresholds, staffing, and the responsible authority before activating a response."
    ));
    return {
      actions: actions.slice(0, 5),
      dominantHazard: "multi-hazard readiness",
      policyVersion: RECOMMENDATION_POLICY_VERSION,
      note: "HeatLens orders preparedness checks; it does not issue an official warning or activate a municipal response."
    };
  }

  if (metrics.heatScore >= 35) {
    actions.push(action(
      heatBand.label,
      metrics.heatScore >= 55
        ? `Move strenuous outdoor activity outside ${peakWindow}, use shade or a cool indoor place, drink regularly, and check on heat-sensitive people.`
        : `Prefer cooler morning or evening hours for strenuous activity and keep water, shade, and a cooler indoor option available.`
    ));
  } else {
    actions.push(action("Plan", `Check the daily peak before longer outdoor activity; the modelled warmer window is ${peakWindow}.`));
  }
  if (metrics.dryStressScore >= 35) {
    actions.push(action(
      dryBand.label,
      metrics.dryStressScore >= 75
        ? "Prioritise newly planted and shallow-rooted plants, reduce non-essential water use, and follow local watering or fire restrictions; check the root zone before any watering."
        : metrics.dryStressScore >= 55
          ? "Check the root zone before watering sensitive plants; water early or late only where needed, reduce evaporation, and follow local restrictions."
          : "Check soil moisture a finger-depth below the surface before watering; delay routine watering when the root zone is still moist."
    ));
  }
  if (metrics.wetStressScore >= 35) {
    actions.push(action(
      wetBand.label,
      metrics.wetStressScore >= 75
        ? "Follow official flood instructions, do not enter floodwater or flooded underground spaces, and keep away from fast water and electrical hazards."
        : metrics.wetStressScore >= 55
          ? "Avoid flooded paths and underpasses, keep away from fast water, check cellar or balcony drains only when safe, and follow local flood instructions."
          : "Delay routine watering, inspect pots and safely accessible drains for standing water, and avoid compacting saturated garden soil."
    ));
  }
  actions.push(action("Official check", officialCheck(options)));
  return {
    actions: actions.slice(0, 4),
    dominantHazard: metrics.heatScore >= Math.max(metrics.dryStressScore, metrics.wetStressScore)
      ? "heat" : metrics.wetStressScore > metrics.dryStressScore ? "excess water" : "dry stress",
    policyVersion: RECOMMENDATION_POLICY_VERSION,
    note: "Resident guidance is limited to low-regret actions. Official DWD, health, civil-protection, and local flood instructions take precedence."
  };
}
