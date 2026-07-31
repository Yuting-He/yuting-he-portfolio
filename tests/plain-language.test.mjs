import test from "node:test";
import assert from "node:assert/strict";
import {
  PLAIN_SOURCE_SUMMARY,
  plainActionCategory,
  plainActionsFor,
  plainConfidenceLabel,
  plainDecisionNote,
  plainLanguageSignals,
  plainLanguageSummary
} from "../heatwave-language.js";

const baseMetrics = Object.freeze({
  available: true,
  impactScore: 72,
  heatScore: 78,
  dryStressScore: 64,
  wetStressScore: 18,
  apparentMaxC: 38.4,
  tminC: 21.2,
  precipitationMm: 0.8,
  completeness: 98,
  spatialCoverage: 96,
  ensemblePeakHourTemperatureSdC: 1.1,
  ensembleMaxHourlyPrecipitationSdMm: 1.4,
  ensembleMemberCount: 40,
  temperatureValidationMaeC: 1.2,
  dwdObservationKind: "complete-day",
  dwdObservedStationCount: 4,
  dwdStationMaxDistanceKm: 18
});

const technicalJargon = /\b(?:DWD|UFZ|SMI|nFK|ET0|VPD|RADOLAN|ICON|ensemble|MAE)\b/i;

test("plain-language view turns risk inputs into five decision-oriented statements", () => {
  const signals = plainLanguageSignals(baseMetrics, "residents", "impact");
  assert.equal(signals.length, 5);
  assert.deepEqual(signals.map((signal) => signal.label), [
    "Overall situation",
    "Heat",
    "Soil and plants",
    "Rain and standing water",
    "How sure we are"
  ]);
  assert.match(signals[1].text, /Dangerous heat/i);
  assert.match(signals[1].text, /night may also stay warm/i);
  assert.match(signals[2].text, /much drier than usual/i);
  assert.match(signals[3].text, /Little useful rain/i);
});

test("plain-language labels adapt to each decision lens without exposing technical acronyms", () => {
  for (const [audience, expectedGroundLabel] of [
    ["residents", "Soil and plants"],
    ["farmers", "Field water"],
    ["municipal", "Ground and green spaces"]
  ]) {
    const signals = plainLanguageSignals(baseMetrics, audience, "impact");
    const summary = plainLanguageSummary(baseMetrics, audience, "impact", {
      regionName: "Bavaria",
      dateLabel: "31 July 2026"
    });
    const combined = [summary, plainConfidenceLabel(baseMetrics), plainDecisionNote(audience), ...signals.flatMap(Object.values)].join(" ");
    assert.equal(signals[2].label, expectedGroundLabel);
    assert.doesNotMatch(combined, technicalJargon);
    assert.match(summary, /Bavaria on 31 July 2026/i);
  }
});

test("wet-ground and stale-data cases produce cautious, actionable wording", () => {
  const wetMetrics = {
    ...baseMetrics,
    impactScore: 82,
    heatScore: 42,
    dryStressScore: 12,
    wetStressScore: 88,
    precipitationMm: 34
  };
  const signals = plainLanguageSignals(wetMetrics, "municipal", "wet", { stale: true });
  assert.match(signals[2].text, /very wet/i);
  assert.match(signals[3].text, /collecting in low places/i);
  assert.match(signals[4].text, /too old/i);
  assert.equal(plainConfidenceLabel(wetMetrics, { stale: true }), "Out-of-date data - actions paused");
  assert.match(plainDecisionNote("municipal", { stale: true }), /paused/i);
  assert.doesNotMatch(signals.flatMap(Object.values).join(" "), /Plan strenuous|Prioritise|Avoid low routes/i);
});

test("retrospective wording describes the past without presenting current advice", () => {
  const signals = plainLanguageSignals(baseMetrics, "residents", "heat", { isRetrospective: true });
  const summary = plainLanguageSummary(baseMetrics, "residents", "heat", {
    regionName: "Bavaria",
    dateLabel: "28 July 2026",
    isRetrospective: true
  });
  assert.match(summary, /past-date reconstruction/i);
  assert.match(signals[0].text, /for review/i);
  assert.match(signals[1].text, /snapshot recorded/i);
  assert.doesNotMatch([summary, ...signals.flatMap(Object.values)].join(" "), /decide what to check next|Dangerous heat is possible/i);
  assert.equal(plainConfidenceLabel(baseMetrics, { isRetrospective: true }), "Past-date view - for review only");
});

test("technical action categories are translated into clear decision gates", () => {
  assert.equal(plainActionCategory("Official check"), "Check official advice");
  assert.equal(plainActionCategory("Very high"), "Priority action");
  assert.equal(plainActionCategory("Moderate"), "Worth doing");
  assert.equal(plainActionCategory("Verify"), "Check locally");
  assert.equal(plainActionCategory("Do not automate"), "Human decision required");
  assert.equal(plainActionCategory("Activation gate"), "Before activating");
});

test("plain role actions stay understandable and preserve human decision gates", () => {
  for (const audience of ["residents", "farmers", "municipal"]) {
    const actions = plainActionsFor(baseMetrics, audience, { heatWarningCount: 1 });
    const combined = actions.flatMap(Object.values).join(" ");
    assert.ok(actions.length >= 2 && actions.length <= 5);
    assert.doesNotMatch(combined, technicalJargon);
  }
  const farmActions = plainActionsFor(baseMetrics, "farmers");
  assert.match(farmActions.at(-1).text, /Do not change harvest timing, irrigation amount/i);
  const municipalActions = plainActionsFor(baseMetrics, "municipal");
  assert.match(municipalActions.at(-1).text, /responsible authority/i);
  assert.doesNotMatch([...farmActions, ...municipalActions].flatMap(Object.values).join(" "), /\b(?:11:00|12:00|17:00|18:00)\b/);
});

test("plain source summary expands institution names instead of relying on acronyms", () => {
  assert.match(PLAIN_SOURCE_SUMMARY, /Germany's national weather service/i);
  assert.match(PLAIN_SOURCE_SUMMARY, /Helmholtz Centre for Environmental Research/i);
  assert.doesNotMatch(PLAIN_SOURCE_SUMMARY, technicalJargon);
});
