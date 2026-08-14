import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  FARM_GOALS,
  FIELD_CONTEXTS,
  HORTICULTURE_CONTEXTS
} from "../heatwave-model.js";
import {
  profileLabel,
  severityLabel,
  textFor
} from "../heatwave-i18n.js";
import {
  plainActionsForDe,
  plainDecisionNoteDe,
  plainLanguageSignalsDe,
  plainLanguageSummaryDe
} from "../heatwave-language-de.js";

test("every marked interface string has English and German copy", async () => {
  const html = await readFile(new URL("../heatwave-demo.html", import.meta.url), "utf8");
  const keys = new Set([
    ...html.matchAll(/data-i18n="([^"]+)"/g),
    ...html.matchAll(/data-i18n-aria-label="([^"]+)"/g)
  ].map((match) => match[1]));
  assert.ok(keys.size >= 100);
  for (const key of keys) {
    assert.notEqual(textFor("en", key), key, `missing English copy for ${key}`);
    assert.notEqual(textFor("de", key), key, `missing German copy for ${key}`);
  }
});

test("German labels cover every configurable farm and garden profile", () => {
  const groups = [
    ["crops", FIELD_CONTEXTS.crops],
    ["stages", FIELD_CONTEXTS.stages],
    ["soils", FIELD_CONTEXTS.soils],
    ["farmGoals", FARM_GOALS],
    ["plants", HORTICULTURE_CONTEXTS.plants],
    ["settings", HORTICULTURE_CONTEXTS.settings],
    ["gardenSoils", HORTICULTURE_CONTEXTS.soils],
    ["gardenGoals", HORTICULTURE_CONTEXTS.goals]
  ];
  for (const [group, profiles] of groups) {
    for (const key of Object.keys(profiles)) {
      assert.notEqual(profileLabel("de", group, key), key, `missing German ${group}.${key}`);
    }
  }
  assert.equal(severityLabel("de", { className: "extreme" }), "Sehr hoch");
});

test("German decision text remains deterministic and keeps costly farm decisions gated", () => {
  const metrics = {
    available: true,
    apparentMaxC: 36,
    tminC: 21,
    heatScore: 72,
    dryStressScore: 68,
    wetStressScore: 18,
    impactScore: 70,
    precipitationMm: 1,
    completeness: 98,
    spatialCoverage: 97,
    ensemblePeakHourTemperatureSdC: 1.2,
    ensembleMaxHourlyPrecipitationSdMm: 0.8,
    crop: "maize",
    cropLabel: "Maize",
    stage: "flowering",
    stageLabel: "Flowering / yield formation",
    stageAuto: true,
    soil: "local",
    farmGoal: "irrigation"
  };
  const summary = plainLanguageSummaryDe(metrics, "farmers", "impact", {
    regionName: "Oberbayern",
    dateLabel: "14. Aug. 2026"
  });
  const signals = plainLanguageSignalsDe(metrics, "farmers", "impact");
  const actions = plainActionsForDe(metrics, "farmers");
  assert.match(summary, /Oberbayern/);
  assert.equal(signals.length, 5);
  assert.equal(actions.filter((action) => action.focus).length, 1);
  assert.match(actions.at(-1).text, /nicht allein|qualifizierte/i);
  assert.doesNotMatch(actions.map((action) => action.text).join(" "), /\b(Check|Suggested|Watering amount)\b/);
  assert.match(plainDecisionNoteDe("farmers"), /weder Bewässerungsmengen noch Erntezeitpunkt/i);
});

test("German actions render for every decision lens", () => {
  const metrics = {
    apparentMaxC: 35,
    tminC: 20,
    heatScore: 62,
    dryStressScore: 44,
    wetStressScore: 38,
    impactScore: 61,
    precipitationMm: 4,
    completeness: 96,
    spatialCoverage: 95,
    ensemblePeakHourTemperatureSdC: 1.1,
    crop: "winterWheat",
    stage: "maturity",
    stageAuto: false,
    soil: "loam",
    farmGoal: "overview",
    plant: "rosesShrubs",
    gardenSetting: "openGround",
    gardenSoil: "moistureRetentive",
    gardenGoal: "heatProtection",
    gardenSeason: "summerStress"
  };
  for (const audience of ["residents", "farmers", "gardeners", "municipal"]) {
    const actions = plainActionsForDe(metrics, audience);
    assert.ok(actions.length >= 2, `${audience} should receive German actions`);
    assert.ok(actions.every((action) => action.category && action.text));
  }
  assert.equal(plainActionsForDe(metrics, "gardeners").filter((action) => action.focus).length, 1);
});
