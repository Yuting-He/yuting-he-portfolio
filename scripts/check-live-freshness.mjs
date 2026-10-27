import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOUR = 3_600_000;
const MAXIMUM_BUILD_AGE_HOURS = 2;
// Publication uses the same required-source limits as ingestion, evaluated again
// against the build clock rather than a historical snapshot's generatedAt.
export const PUBLICATION_SOURCE_LIMIT_HOURS = Object.freeze({
  radolan: 8,
  dwdTemperature: 8,
  ufz: 96,
  dwdSoil: 96
});

function berlinDate(timestamp) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

export function checkLiveFreshness(dataset, now = Date.now()) {
  if (!Number.isFinite(now)) throw new TypeError("Publication clock must be a finite timestamp");
  const issues = [];
  const generatedTime = Date.parse(dataset?.generatedAt);
  const ageHours = (now - generatedTime) / HOUR;
  if (!Number.isFinite(generatedTime) || ageHours < -5 / 60 || ageHours > MAXIMUM_BUILD_AGE_HOURS) {
    issues.push(`Snapshot must have been generated within ${MAXIMUM_BUILD_AGE_HOURS} hours of this build, with at most 5 minutes of clock skew.`);
  }

  const forecast = dataset?.forecast || {};
  const dates = forecast.dates;
  const currentDate = berlinDate(now);
  const validWindow = Array.isArray(dates) && dates.length === 9 && dates.every(isDate) &&
    forecast.pastDays === 2 && forecast.forecastDays === 7 &&
    dates.every((date, index) => !index || Date.parse(date) - Date.parse(dates[index - 1]) === 24 * HOUR);
  if (!validWindow || dates[forecast.pastDays] !== currentDate) {
    issues.push(`Forecast must contain two retrospective and seven consecutive forecast dates anchored on ${currentDate} (Europe/Berlin).`);
  }

  const records = {
    radolan: { status: dataset?.observations?.radolan?.status, validAt: dataset?.observations?.radolan?.periodEnd },
    dwdTemperature: { status: dataset?.observations?.dwdTemperature?.status, validAt: dataset?.observations?.dwdTemperature?.observedAt },
    ufz: { status: dataset?.soilMoisture?.ufz?.status, validAt: dataset?.soilMoisture?.ufz?.validAt },
    dwdSoil: { status: dataset?.soilMoisture?.dwd?.status, validAt: dataset?.soilMoisture?.dwd?.validAt }
  };
  const sources = Object.fromEntries(Object.entries(records).map(([source, record]) => {
    const sourceAge = (now - Date.parse(record.validAt)) / HOUR;
    const maximumAgeHours = PUBLICATION_SOURCE_LIMIT_HOURS[source];
    const current = record.status === "available" && Number.isFinite(sourceAge) &&
      sourceAge >= -2 && sourceAge <= maximumAgeHours;
    if (!current) issues.push(`${source} is unavailable or outside its ${maximumAgeHours}-hour freshness policy at publication time.`);
    return [source, {
      status: current ? "available" : record.status === "available" ? "stale" : "unavailable",
      validAt: record.validAt ?? null,
      ageHours: Number.isFinite(sourceAge) ? Math.round(sourceAge * 10) / 10 : null,
      maximumAgeHours
    }];
  }));

  return {
    schema: "heatlens-publication-status/v1",
    mode: "live",
    checkedAt: new Date(now).toISOString(),
    status: issues.length ? "blocked" : "ready",
    generatedAt: dataset?.generatedAt ?? null,
    snapshotAgeHours: Number.isFinite(ageHours) ? Math.round(ageHours * 100) / 100 : null,
    currentDate,
    forecastDates: Array.isArray(dates) ? dates : [],
    sources,
    warningFeed: {
      status: dataset?.warnings?.status ?? "unavailable",
      issuedAt: dataset?.warnings?.issuedAt ?? null
    },
    issues
  };
}

// A normal site edit can publish the last real snapshot without contacting all
// forecast providers. Its original clock and source dates remain authoritative:
// passing this check does not make saved data fresh or enable stale advice.
export async function validateSavedSnapshot(dataset, now = Date.now(), { expectedBasinCount = 614 } = {}) {
  const live = checkLiveFreshness(dataset, now);
  const issues = [];
  const generatedTime = Date.parse(dataset?.generatedAt);
  if (!Number.isFinite(generatedTime) || generatedTime > now + 5 * 60_000) {
    issues.push("Saved snapshot has a missing, invalid or future generation time.");
  }
  const forecast = dataset?.forecast || {};
  const dates = forecast.dates;
  const validWindow = Array.isArray(dates) && dates.length === 9 && dates.every(isDate) &&
    forecast.pastDays === 2 && forecast.forecastDays === 7 &&
    dates.every((date, index) => !index || Date.parse(date) - Date.parse(dates[index - 1]) === 24 * HOUR);
  if (!validWindow || Number.isFinite(generatedTime) && dates[2] !== berlinDate(generatedTime)) {
    issues.push("Saved snapshot must retain its consecutive two-past/seven-forecast-day window anchored on its original Berlin generation date.");
  }
  for (const [name, source] of Object.entries(live.sources)) {
    if (source.status === "unavailable" || !Number.isFinite(source.ageHours) || source.ageHours < -2) {
      issues.push(`${name} has unavailable, invalid or future source metadata in the saved snapshot.`);
    }
  }
  try {
    const { validateLiveDataset } = await import("./fetch-live-data.mjs");
    // Ingestion validation checks completeness and that sources were current at
    // the recorded generation time. Avoid rewriting caller-owned provenance.
    validateLiveDataset(structuredClone(dataset), expectedBasinCount);
  } catch (error) {
    issues.push(`Saved snapshot structure is invalid: ${error.message}`);
  }
  const staleSources = Object.entries(live.sources).filter(([, source]) => source.status !== "available")
    .map(([name]) => name);
  const snapshotExpired = !Number.isFinite(live.snapshotAgeHours) || live.snapshotAgeHours > 36;
  const freshnessStatus = snapshotExpired || staleSources.length ? "stale"
    : live.snapshotAgeHours > 18 ? "delayed" : "current";
  return {
    ...live,
    mode: "saved",
    status: issues.length ? "blocked" : "ready",
    freshnessStatus,
    staleSources,
    suggestedActions: freshnessStatus === "stale" ? "suppressed-for-stale-data" : "runtime-checked",
    livePublicationIssues: live.issues,
    issues
  };
}

const markdownCell = (value) => String(value ?? "not available")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll("|", "\\|").replace(/[\r\n]+/g, " ");

export function formatRefreshSummary(refresh, publication, outcomes = {}, reuse = null) {
  const saved = publication?.mode === "saved" || outcomes.reuse === "success";
  const lines = [
    "## HeatLens data refresh",
    "",
    `Refresh step: **${markdownCell(outcomes.refresh || refresh?.status || "not run")}**.`,
    ...(saved ? [
      "Data mode: **Reused saved snapshot — original generation time preserved**.",
      `Reuse step: **${markdownCell(outcomes.reuse || reuse?.status || "not run")}**.`,
      `Snapshot origin: ${markdownCell(reuse?.origin || publication?.reuseOrigin)}.`,
      `Saved-data freshness: **${markdownCell(publication?.freshnessStatus)}**.`,
      "Runtime source limits (8/96 hours) and the 36-hour snapshot action gate still apply."
    ] : []),
    `Publication check: **${markdownCell(outcomes.publication || publication?.status || "not run")}**.`,
    "",
    `Snapshot generated: ${markdownCell(publication?.generatedAt || refresh?.generatedAt)}.`,
    `Forecast dates: ${markdownCell((publication?.forecastDates || refresh?.forecastDates || []).join(", "))}.`,
    "",
    "| Source | Status at check | Valid time | Age (hours) | Limit (hours) |",
    "| --- | --- | --- | ---: | ---: |"
  ];
  const sources = publication?.sources || refresh?.sources || {};
  for (const [name, source] of Object.entries(sources)) {
    lines.push(`| ${[name, source.status, source.validAt, source.ageHours, source.maximumAgeHours].map(markdownCell).join(" | ")} |`);
  }
  if (refresh?.error?.message) lines.push("", `Refresh failure: ${markdownCell(refresh.error.message)}`);
  if (reuse?.fallbackReason) lines.push("", `Repository fallback reason: ${markdownCell(reuse.fallbackReason)}`);
  for (const issue of publication?.issues || []) lines.push("", `Publication blocked: ${markdownCell(issue)}`);
  if ((saved ? outcomes.reuse !== "success" : outcomes.refresh !== "success") || outcomes.publication !== "success") {
    lines.push("", saved
      ? "No new site is published unless saved-snapshot reuse and publication validation succeed. The previous Pages release is preserved."
      : "No new site is published unless both refresh and publication validation succeed. The previous Pages release is preserved.");
  }
  lines.push("", "Historical snapshot/model tests are separate from this real-clock publication check.", "");
  return lines.join("\n");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function optionalReport(path) {
  try {
    return await readJson(path);
  } catch {
    return null;
  }
}

async function main() {
  const reportPath = resolve(ROOT, "artifacts/publication-status.json");
  if (process.argv.includes("--summary")) {
    const [refresh, publication, reuse] = await Promise.all([
      optionalReport(resolve(ROOT, "artifacts/refresh-status.json")),
      optionalReport(reportPath),
      optionalReport(resolve(ROOT, "artifacts/reuse-status.json"))
    ]);
    const summary = formatRefreshSummary(refresh, publication, {
      refresh: process.env.HEATLENS_REFRESH_OUTCOME,
      publication: process.env.HEATLENS_PUBLICATION_OUTCOME,
      reuse: process.env.HEATLENS_REUSE_OUTCOME
    }, reuse);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
    else console.log(summary);
    return;
  }
  let report;
  try {
    const dataset = await readJson(resolve(ROOT, "assets/live/forecast.json"));
    report = process.argv.includes("--saved") ? await validateSavedSnapshot(dataset) : checkLiveFreshness(dataset);
    if (report.mode === "saved") {
      const reuse = await optionalReport(resolve(ROOT, "artifacts/reuse-status.json"));
      report.reuseOrigin = reuse?.origin ?? "provided-saved-snapshot";
    }
  } catch (error) {
    report = {
      schema: "heatlens-publication-status/v1", checkedAt: new Date().toISOString(),
      status: "blocked", sources: {}, issues: [`Cannot verify forecast snapshot: ${error.message}`]
    };
  }
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "ready") {
    console.error(report.issues.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(report.mode === "saved"
      ? `Saved publication check passed: reused ${report.generatedAt}; data is ${report.freshnessStatus}; source clocks unchanged.`
      : `Live publication check passed: generated ${report.generatedAt}; forecast anchor ${report.currentDate}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
