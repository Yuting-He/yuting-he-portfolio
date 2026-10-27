import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateSavedSnapshot } from "./check-live-freshness.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PUBLISHED_SNAPSHOT_URL = "https://yuting-he.github.io/yuting-he-portfolio/assets/live/forecast.json";

export async function reusePublishedData({
  fetchImpl = fetch, publishedUrl = PUBLISHED_SNAPSHOT_URL,
  outputPath = resolve(ROOT, "assets/live/forecast.json"),
  reportPath = resolve(ROOT, "artifacts/reuse-status.json"), now = Date.now()
} = {}) {
  const report = {
    schema: "heatlens-reuse-status/v1", checkedAt: new Date(now).toISOString(),
    status: "running", mode: "saved", origin: null, generatedAt: null,
    freshnessStatus: null, fallbackReason: null, error: null
  };
  await mkdir(dirname(reportPath), { recursive: true });
  try {
    let dataset;
    let publication;
    try {
      const response = await fetchImpl(publishedUrl, {
        cache: "no-store", signal: AbortSignal.timeout(45_000),
        headers: { "User-Agent": "HeatLens-GitHub-Pages-build" }
      });
      if (!response.ok) throw new Error(`Published snapshot returned HTTP ${response.status}`);
      dataset = await response.json();
      publication = await validateSavedSnapshot(dataset, now);
      if (publication.status !== "ready") throw new Error(publication.issues.join(" "));
      report.origin = "published";
    } catch (error) {
      report.fallbackReason = error.message;
      dataset = JSON.parse(await readFile(outputPath, "utf8"));
      publication = await validateSavedSnapshot(dataset, now);
      if (publication.status !== "ready") {
        throw new Error(`Published snapshot cannot be reused (${error.message}); repository fallback is invalid: ${publication.issues.join(" ")}`);
      }
      report.origin = "repository-fallback";
    }
    report.generatedAt = dataset.generatedAt;
    report.freshnessStatus = publication.freshnessStatus;
    // No generatedAt/source timestamp is changed during ordinary site edits.
    if (report.origin === "published") {
      await mkdir(dirname(outputPath), { recursive: true });
      const temporaryPath = `${outputPath}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(dataset)}\n`);
      await rename(temporaryPath, outputPath);
    }
    report.status = "success";
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } catch (error) {
    report.status = "failed";
    report.error = { message: error.message };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = await reusePublishedData();
    console.log(`Reused saved snapshot from ${report.origin}: ${report.generatedAt}; freshness ${report.freshnessStatus}.`);
    if (report.fallbackReason) console.warn(`Published snapshot unavailable; validated repository fallback used: ${report.fallbackReason}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
