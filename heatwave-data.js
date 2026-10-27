import { MODEL_VERSION } from "./heatwave-model.js";

export const DEFAULT_CONTEXT = Object.freeze({
  crop: "dominant", stage: "auto", soil: "local", farmGoal: "overview",
  plant: "seasonalFlowers", gardenSetting: "container", gardenSoil: "unknown", gardenGoal: "overview"
});

export function effectiveContext(view = {}) {
  const relevant = view.audience === "farmers" ? ["crop", "stage", "soil", "farmGoal"]
    : view.audience === "gardeners" ? ["plant", "gardenSetting", "gardenSoil", "gardenGoal"]
      : ["residents", "municipal"].includes(view.audience) ? [] : Object.keys(DEFAULT_CONTEXT);
  return { ...DEFAULT_CONTEXT, ...Object.fromEntries(relevant.map((key) => [key, view[key] ?? DEFAULT_CONTEXT[key]])) };
}

export function matchesDefaultContext(view = {}) {
  return Object.entries(effectiveContext(view)).every(([key, value]) => value === DEFAULT_CONTEXT[key]);
}

const MANIFEST_SCHEMA = "heatlens-manifest/v1";
const SNAPSHOT_ID = /^[0-9]{14}-[a-f0-9]{12}$/;
const isoDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export function validateHeatlensManifest(manifest) {
  if (manifest?.schema !== MANIFEST_SCHEMA || !SNAPSHOT_ID.test(manifest.snapshotId || "")) {
    throw new Error("Unsupported HeatLens manifest or snapshot identifier");
  }
  if (manifest.modelVersion !== MODEL_VERSION) throw new Error("HeatLens model version changed; reload the page");
  if (!Number.isFinite(Date.parse(manifest.generatedAt)) || !Array.isArray(manifest.forecastDates) ||
      !manifest.forecastDates.length || !manifest.forecastDates.every(isoDate) ||
      manifest.forecastDates.some((date, index, dates) => index && Date.parse(date) - Date.parse(dates[index - 1]) !== 86_400_000)) {
    throw new Error("HeatLens manifest has an invalid generation time or date window");
  }
  const references = [manifest.overview, ...Object.values(manifest.states || {})];
  if (references.length < 2 || !manifest.states || Object.keys(manifest.states).some((id) => !/^DE[A-Z0-9]$/.test(id))) {
    throw new Error("HeatLens manifest has no valid regional index");
  }
  for (const reference of references) {
    const prefix = `snapshots/${manifest.snapshotId}/`;
    if (!reference || typeof reference.url !== "string" || !reference.url.startsWith(prefix) ||
        reference.url.split("/").some((part) => part === "." || part === "..") ||
        !/^snapshots\/[A-Za-z0-9/-]+\.json$/.test(reference.url) ||
        !Number.isSafeInteger(reference.bytes) || reference.bytes <= 0 || !/^[a-f0-9]{64}$/.test(reference.sha256 || "")) {
      throw new Error("HeatLens manifest has an invalid immutable asset reference");
    }
  }
  return manifest;
}

function optionsAndManifest(value) {
  if (value?.schema === MANIFEST_SCHEMA) return { manifest: value };
  return value || {};
}

async function sha256(bytes) {
  if (!globalThis.crypto?.subtle) throw new Error("Secure asset verification is unavailable in this browser");
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createHeatlensDataClient({
  manifestUrl, baseUrl = import.meta.url, fetchImpl = globalThis.fetch,
  timeoutMs = 20_000, retries = 1
} = {}) {
  const manifestAddress = new URL(manifestUrl || "./assets/live/manifest.json", baseUrl).href;
  const cache = new Map();
  const pendingRequests = new Map();
  const failedAssets = new Set();
  let currentManifest = null;

  async function requestBytes(url, { signal, cacheMode = "no-cache" } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => controller.abort(new DOMException("HeatLens request timed out", "TimeoutError")), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          signal: controller.signal,
          cache: attempt > 0 && cacheMode !== "no-store" ? "reload" : cacheMode
        });
        if (!response.ok) {
          const error = new Error(`HeatLens data request failed (HTTP ${response.status})`);
          error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          throw error;
        }
        return new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        if (signal?.aborted || error.retryable === false || attempt >= retries) throw error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      }
    }
  }

  async function checkManifest({ signal } = {}) {
    const bytes = await requestBytes(manifestAddress, { signal, cacheMode: "no-store" });
    const manifest = validateHeatlensManifest(JSON.parse(new TextDecoder().decode(bytes)));
    currentManifest = manifest;
    return manifest;
  }

  async function loadAsset(reference, manifest, schema, { signal } = {}) {
    validateHeatlensManifest(manifest);
    const address = new URL(reference.url, manifestAddress);
    if (address.origin !== new URL(manifestAddress).origin) throw new Error("HeatLens assets must use the manifest origin");
    const key = `${manifest.snapshotId}|${address.href}`;
    if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
    if (cache.has(key)) return cache.get(key);
    // A caller's cancellation must not cancel a later caller requesting the
    // same region. Only requests without caller-owned signals are shared.
    if (!signal && pendingRequests.has(key)) return pendingRequests.get(key);
    const pending = (async () => {
      try {
        // Browsers may cache error responses as well as immutable successful
        // files. A user retry must reach the server after a 404 or bad body.
        const bytes = await requestBytes(address.href, { signal, cacheMode: failedAssets.has(key) ? "reload" : "force-cache" });
        if (bytes.byteLength !== reference.bytes || await sha256(bytes) !== reference.sha256) {
          throw new Error("HeatLens asset integrity check failed; retry the current snapshot");
        }
        const payload = JSON.parse(new TextDecoder().decode(bytes));
        if (payload.schema !== schema || payload.snapshotId !== manifest.snapshotId ||
            payload.generatedAt !== manifest.generatedAt || payload.modelVersion !== manifest.modelVersion) {
          throw new Error("HeatLens asset belongs to a different snapshot or model version");
        }
        if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
        cache.set(key, payload);
        failedAssets.delete(key);
        return payload;
      } catch (error) {
        if (!signal?.aborted) failedAssets.add(key);
        throw error;
      }
    })();
    if (!signal) {
      pendingRequests.set(key, pending);
      pending.finally(() => { if (pendingRequests.get(key) === pending) pendingRequests.delete(key); }).catch(() => {});
    }
    return pending;
  }

  async function loadOverview(value = {}) {
    const options = optionsAndManifest(value);
    const manifest = options.manifest || await checkManifest(options);
    const overview = await loadAsset(manifest.overview, manifest, "heatlens-overview/v1", options);
    if (!Array.isArray(overview.states?.features) || !Array.isArray(overview.locations) ||
        overview.metadata?.generatedAt !== manifest.generatedAt ||
        overview.metadata?.forecast?.dates?.join() !== manifest.forecastDates.join()) {
      throw new Error("HeatLens overview does not match the manifest date window");
    }
    return { manifest, overview, states: overview.states, locations: overview.locations, basinIndex: overview.basinIndex,
      metadata: overview.metadata, profiles: overview.profiles, metricsByState: overview.metricsByState };
  }

  async function loadState(stateId, value = {}) {
    const options = optionsAndManifest(value);
    const manifest = options.manifest || currentManifest || await checkManifest(options);
    if (!Object.hasOwn(manifest.states, stateId)) throw new Error(`Unknown HeatLens state ${stateId}`);
    const payload = await loadAsset(manifest.states[stateId], manifest, "heatlens-state/v1", options);
    if (payload.stateId !== stateId || payload.livePayload?.generatedAt !== manifest.generatedAt ||
        payload.livePayload?.forecast?.dates?.join() !== manifest.forecastDates.join()) {
      throw new Error("HeatLens regional data does not match the requested state or date window");
    }
    const ids = new Set(payload.basins?.features?.map((feature) => String(feature.properties.HYBAS_ID)) || []);
    const liveIds = new Set(payload.livePayload?.basins?.map((basin) => String(basin.id)) || []);
    if (!ids.size || ids.size !== liveIds.size || [...ids].some((id) => !liveIds.has(id)) ||
        !payload.crosswalk?.length || payload.crosswalk.some((record) =>
          !ids.has(String(record.HYBAS_ID)) || !record.NUTS_ID.startsWith(stateId))) {
      throw new Error("HeatLens regional basin records or exact overlap weights are incomplete");
    }
    return payload;
  }

  return { checkManifest, loadOverview, loadState, clearCache: () => { cache.clear(); pendingRequests.clear(); } };
}
