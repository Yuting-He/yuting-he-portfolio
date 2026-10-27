import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { MODEL_VERSION } from "../heatwave-model.js";
import { createHeatlensDataClient } from "../heatwave-data.js";
import { checkLiveFreshness, PUBLICATION_SOURCE_LIMIT_HOURS } from "./check-live-freshness.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOUR = 3_600_000;
export const VERIFIED_FRONTEND_FILES = Object.freeze([
  "heatwave-demo.js", "heatwave-model.js", "heatwave-state.js", "heatwave-warnings.js", "heatwave-data.js",
  "heatwave-controls.js", "heatwave-spatial.js", "heatwave-results.js", "heatwave-i18n.js",
  "heatwave-language.js", "heatwave-language-de.js", "heatwave-demo.css", "styles.css"
]);
const PAGES = ["index.html", "heatwave-demo.html", "watt-hackathon/index.html", "watt-hackathon/schedule.html"];
const digestText = (text) => createHash("sha256").update(text.replaceAll("\r\n", "\n")).digest("hex");
const fail = (message, { retryable = false, code = "INVALID_DEPLOYMENT" } = {}) => Object.assign(new Error(message), { retryable, code });

function verifyForecast(dataset, manifest, now) {
  if (dataset?.schema !== "heatlens-live/v3" || dataset.generatedAt !== manifest.generatedAt ||
      dataset.forecast?.dates?.join() !== manifest.forecastDates.join() || dataset.forecast.pastDays !== 2 ||
      dataset.forecast.forecastDays !== 7 || dataset.forecast.dates.length !== 9 ||
      !Array.isArray(dataset.basins) || dataset.basins.length !== 614 || manifest.basinCount !== 614) {
    throw fail("Published full forecast does not satisfy the matching 614-basin/nine-day contract");
  }
  const generatedTime = Date.parse(dataset.generatedAt);
  if (!Number.isFinite(generatedTime) || generatedTime > now + 5 * 60_000) throw fail("Published snapshot has an invalid or future generation time");
  const atGeneration = checkLiveFreshness(dataset, generatedTime);
  if (atGeneration.status !== "ready") throw fail(`Snapshot was not valid at its recorded generation time: ${atGeneration.issues.join(" ")}`);
  for (const [name, maximumAgeHours] of Object.entries(PUBLICATION_SOURCE_LIMIT_HOURS)) {
    const policy = dataset.sourceFreshness?.sources?.[name];
    if (policy?.maximumAgeHours !== maximumAgeHours || policy.validAt !== atGeneration.sources[name].validAt) {
      throw fail(`Published ${name} runtime freshness policy does not match its original source time or limit`);
    }
  }
  const ids = new Set();
  const fields = ["tmaxC", "tminC", "apparentMaxC", "precipitationMm", "precipitation1hMaxMm", "et0Mm",
    "vpdMaxKpa", "soilMoistureM3M3", "heatPersistenceDays", "dryPersistenceDays", "waterBalance3dMm", "completeness"];
  for (const basin of dataset.basins) {
    const id = String(basin?.id ?? "");
    if (!/^\d+$/.test(id) || ids.has(id) || basin.days?.map((day) => day.date).join() !== manifest.forecastDates.join() ||
        ![basin.context?.ufzTopsoilSmi, basin.context?.radolanPrecipitation24hMm, basin.context?.dwdLatestTemperatureC].every(Number.isFinite)) {
      throw fail(`Published basin record is incomplete or duplicated: ${id}`);
    }
    ids.add(id);
    for (const [index, day] of basin.days.entries()) {
      if (!fields.every((field) => Number.isFinite(day[field])) || day.completeness < 85 || index >= 2 &&
          (![day.ensembleDailyTmaxMeanC, day.ensemblePeakHourTemperatureSdC, day.ensembleDailyPrecipitationMeanMm,
            day.ensembleMaxHourlyPrecipitationSdMm, day.ensembleMemberCount].every(Number.isFinite) || day.ensembleCompleteness < 75)) {
        throw fail(`Published forecast values are incomplete for basin ${id} on ${day.date}`);
      }
    }
  }
  return checkLiveFreshness(dataset, now);
}

export async function verifyLiveSite({
  baseUrl = "https://yuting-he.github.io/yuting-he-portfolio/", expectedCommit = process.env.GITHUB_SHA,
  expectedSnapshotId = process.env.HEATLENS_EXPECTED_SNAPSHOT_ID, fetchImpl = fetch, root = ROOT,
  reportPath = resolve(root, "artifacts/live-site-verification.json"), attempts = 6, delayMs = 5_000,
  timeoutMs = 15_000, now = Date.now, waitImpl = (ms) => new Promise((done) => setTimeout(done, ms))
} = {}) {
  const clock = () => typeof now === "function" ? now() : now;
  const report = { schema: "heatlens-live-verification/v1", status: "failed", checkedAt: new Date(clock()).toISOString(),
    baseUrl, expectedCommit: expectedCommit || null, expectedSnapshotId: expectedSnapshotId || null, attempts: [] };
  await mkdir(dirname(reportPath), { recursive: true });
  try {
    if (!expectedCommit || !Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10 || timeoutMs <= 0 || delayMs < 0) {
      throw fail("Verification requires an expected commit and bounded positive retry/timeout settings");
    }
    const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const result = { attempt, startedAt: new Date(clock()).toISOString(), resources: [], status: "running" };
      report.attempts.push(result);
      const attemptSignal = AbortSignal.timeout(timeoutMs);
      const checkedFetch = async (address, options = {}) => {
        const url = new URL(address, base);
        try {
          const response = await fetchImpl(url.href, { ...options, cache: "no-store",
            headers: { ...options.headers, "Cache-Control": "no-cache" },
            signal: options.signal ? AbortSignal.any([attemptSignal, options.signal]) : attemptSignal });
          result.resources.push({ url: url.href, status: response.status });
          if (response.status !== 200) throw fail(`HTTP ${response.status} for ${url.href}`, {
            code: "HTTP_ERROR", retryable: [408, 429].includes(response.status) || response.status >= 500
          });
          return response;
        } catch (error) {
          if (error.code) throw error;
          throw fail(`Network request failed for ${url.href}: ${error.message}`, { code: "NETWORK_ERROR", retryable: true });
        }
      };
      try {
        const info = await (await checkedFetch("build-info.json")).json();
        result.commit = info.commit;
        result.snapshotId = info.snapshotId;
        if (info.commit !== expectedCommit) throw fail(`Expected commit ${expectedCommit}; Pages currently serves ${info.commit}`, {
          code: "COMMIT_NOT_PROPAGATED", retryable: true
        });
        if (expectedSnapshotId && info.snapshotId !== expectedSnapshotId) throw fail(`Expected snapshot ${expectedSnapshotId}; Pages currently serves ${info.snapshotId}`, {
          code: "SNAPSHOT_NOT_PROPAGATED", retryable: true
        });
        if (info.schema !== "heatlens-site-build/v1" || info.modelVersion !== MODEL_VERSION || !["live", "saved"].includes(info.publicationMode)) {
          throw fail("Published build metadata has an unsupported schema, model or data mode");
        }
        const client = createHeatlensDataClient({ manifestUrl: new URL("assets/live/manifest.json", base).href,
          baseUrl: base.href, fetchImpl: checkedFetch, timeoutMs, retries: 0 });
        const overview = await client.loadOverview();
        const manifest = overview.manifest;
        if (info.snapshotId !== manifest.snapshotId || info.snapshotGeneratedAt !== manifest.generatedAt ||
            info.modelVersion !== manifest.modelVersion) throw fail("Published build-info and manifest describe different snapshots");
        const stateId = Object.hasOwn(manifest.states, "DE2") ? "DE2" : Object.keys(manifest.states).sort()[0];
        const [bundle, dataset, files] = await Promise.all([
          client.loadState(stateId, manifest),
          checkedFetch("assets/live/forecast.json").then((response) => response.json()),
          Promise.all([...PAGES, ...VERIFIED_FRONTEND_FILES].map(async (path) => {
            const [served, local] = await Promise.all([
              checkedFetch(path).then((response) => response.text()), readFile(resolve(root, path), "utf8")
            ]);
            if (digestText(served) !== digestText(local)) throw fail(`Published file differs from checkout ${expectedCommit}: ${path}`, { code: "FILE_MISMATCH" });
            return { path, matchesCheckout: true, sha256: digestText(served), ...(PAGES.includes(path)
              ? { title: served.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? null } : {}) };
          }))
        ]);
        const freshness = verifyForecast(dataset, manifest, clock());
        const { basins, ...metadata } = dataset;
        const { basins: regionalBasins, ...regionalMetadata } = bundle.livePayload;
        if (!isDeepStrictEqual(metadata, overview.overview.metadata) || !isDeepStrictEqual(metadata, regionalMetadata)) {
          throw fail("Published overview or regional source metadata differs from the full snapshot");
        }
        const byId = new Map(basins.map((basin) => [String(basin.id), basin]));
        if (regionalBasins.some((basin) => !isDeepStrictEqual(basin, byId.get(String(basin.id))))) {
          throw fail("Published regional basin values differ from the full snapshot");
        }
        if (info.publicationMode === "live" && freshness.status !== "ready") {
          throw fail(`Live deployment failed its real-clock freshness check: ${freshness.issues.join(" ")}`);
        }
        const stale = freshness.snapshotAgeHours > 36 || Object.values(freshness.sources).some((source) => source.status !== "available");
        Object.assign(result, { status: "success", snapshotId: manifest.snapshotId, generatedAt: manifest.generatedAt });
        Object.assign(report, { status: "success", commit: info.commit, snapshotId: manifest.snapshotId,
          generatedAt: manifest.generatedAt, publicationMode: info.publicationMode,
          freshnessStatus: stale ? "stale" : freshness.snapshotAgeHours > 18 ? "delayed" : "current",
          freshness, basinCount: basins.length, forecastDates: manifest.forecastDates, representativeState: stateId,
          overviewIntegrityVerified: true, regionalIntegrityVerified: true, files });
        break;
      } catch (error) {
        result.status = "failed";
        result.error = { code: error.code || error.name, message: error.message };
        report.error = result.error;
        const retryable = error.retryable === true || ["AbortError", "TimeoutError"].includes(error.name) ||
          error instanceof TypeError && /fetch failed|terminated|network|body stream/i.test(error.message);
        if (!retryable || attempt === attempts) break;
        await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
        await waitImpl(delayMs);
      } finally { result.finishedAt = new Date(clock()).toISOString(); }
    }
  } catch (error) {
    report.error = { code: error.code || error.name, message: error.message };
  }
  if (report.status === "success") delete report.error;
  report.finishedAt = new Date(clock()).toISOString();
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await verifyLiveSite({ baseUrl: process.env.HEATLENS_SITE_URL || undefined });
  if (report.status !== "success") {
    console.error(`Live-site verification failed: ${report.error?.message || "unknown failure"}`);
    process.exitCode = 1;
  } else console.log(`Live-site verification passed: commit ${report.commit}; snapshot ${report.snapshotId}; ${report.basinCount} basins x ${report.forecastDates.length} days; ${report.publicationMode}/${report.freshnessStatus}.`);
}
