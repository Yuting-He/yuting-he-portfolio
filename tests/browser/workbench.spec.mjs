import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const manifestPath = new URL("../../assets/live/manifest.json", import.meta.url);
const transparentTile = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
let manifest;
const pageErrors = new WeakMap();

test.beforeAll(async () => {
  // CI builds assets before this suite. Local serving only builds them when the
  // manifest is absent; an existing preview snapshot is never overwritten here.
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
});

test.beforeEach(async ({ page }) => {
  pageErrors.set(page, []);
  page.on("pageerror", (error) => pageErrors.get(page).push(error.message));
  await page.route(/https:\/\/(?:[abc]\.)?tile\.openstreetmap\.org\//, (route) => route.fulfill({
    status: 200, contentType: "image/png", body: transparentTile
  }));
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page), "No unhandled browser script errors").toEqual([]);
});

async function ready(page) {
  await expect(page.locator("#location-search")).toBeEnabled();
  await expect(page.locator("#date-window button")).toHaveCount(manifest.forecastDates.length);
  await expect(page.locator("#region-title")).not.toHaveText(/^(?:Germany|Deutschland)$/);
  await expect(page.locator("#risk-level")).not.toHaveText(/Loading|Wird geladen/i);
}

async function openDisclosure(page, selector) {
  const disclosure = page.locator(selector);
  if (!await disclosure.evaluate((element) => element.open)) await disclosure.locator(":scope > summary").click();
}

async function selectAndPersist(page, selector, value, parameter) {
  await page.locator(selector).selectOption(value);
  await expect.poll(() => new URL(page.url()).searchParams.get(parameter)).toBe(value);
}

async function chooseMunichCity(page) {
  const search = page.locator("#location-search");
  await search.fill("Muenchen");
  const results = page.locator("#location-results").getByRole("option");
  await expect(results).toHaveCount(2);
  await expect(results.nth(0)).toContainText("München, Kreisfreie Stadt");
  await expect(results.nth(1)).toContainText("München, Landkreis");
  await search.press("ArrowDown");
  await expect(search).toHaveAttribute("aria-activedescendant", "location-option-0");
  await search.press("Enter");
}

async function expectAppropriateGuidance(page) {
  const historical = /Historical interpretation/.test(await page.locator("#action-heading-label").innerText());
  const stale = /(?:^|\s)stale(?:\s|$)/.test(await page.locator("#live-status-badge").getAttribute("class") || "");
  if (historical) {
    // A very old repository fallback may have an entirely past date window.
    // Its dated review instructions remain distinct from current action advice.
    await expect(page.locator("#decision-note")).toContainText(/past-date|past date|not advice|review only/i);
    await expect(page.locator("#action-list li").first()).toContainText(/Retrospective|past-date|historical/i);
  } else if (stale) {
    await expect(page.locator("#action-list li")).toHaveCount(0);
    await expect(page.locator("#decision-note")).toContainText(/paused|suppressed|too old/i);
    await expect(page.locator("#data-status-value")).toContainText(/out of date|stale/i);
  } else await expect(page.locator("#action-list li").first()).toBeVisible();
}

test("initial national overview downloads no state bundle or full legacy snapshot", async ({ page }) => {
  const requests = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.includes("/assets/live/")) requests.push(path);
  });
  await page.goto("/heatwave-demo.html?lang=en&level=state&state=DE2");
  await ready(page);
  await expect(page.locator("#region-title")).toHaveText("Bayern");
  expect(requests.some((path) => path.endsWith("/manifest.json"))).toBe(true);
  expect(requests.some((path) => path.endsWith("/overview.json"))).toBe(true);
  expect(requests.filter((path) => path.includes("/states/"))).toEqual([]);
  expect(requests.some((path) => path.endsWith("/forecast.json"))).toBe(false);
});

test("keyboard search distinguishes Munich city and county and supports basin navigation and return", async ({ page }) => {
  await page.goto("/heatwave-demo.html?lang=en&state=DE2");
  await ready(page);
  const selectedDate = await page.locator("#forecast-date").inputValue();
  await chooseMunichCity(page);
  await expect(page.locator("#region-title")).toHaveText("München, Kreisfreie Stadt");
  await expect(page.locator("#location-search")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#scope-breadcrumbs")).toContainText("München, Kreisfreie Stadt");
  await page.locator("#scope-breadcrumbs").getByRole("button", { name: "Explore sub-basins", exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("level")).toBe("basin");
  await expect(page.locator("#map-title")).toContainText("sub-basins");
  await expect(page.locator("#region-select option")).not.toHaveCount(1);
  const basinId = await page.locator("#region-select option[value]:not([value=''])").first().getAttribute("value");
  await page.locator("#region-select").selectOption(basinId);
  await expect(page.locator("#region-title")).toContainText("Sub-basin");
  await page.locator("#scope-back").click();
  await expect.poll(() => new URL(page.url()).searchParams.get("level")).toBe("district");
  await expect(page.locator("#region-title")).toHaveText("München, Kreisfreie Stadt");
  await expect(page.locator("#forecast-date")).toHaveValue(selectedDate);
  const search = page.locator("#location-search");
  await search.fill("Muenchen");
  await search.press("ArrowDown");
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(page.locator("#region-title")).toHaveText("München, Landkreis");
});

test("all four roles preserve their relevant farming and gardening settings", async ({ page }) => {
  await page.goto(`/heatwave-demo.html?lang=en&state=DE2&date=${manifest.forecastDates.at(-1)}`);
  await ready(page);
  for (const role of ["residents", "farmers", "gardeners", "municipal"]) {
    await page.locator(`[data-audience="${role}"]`).click();
    await expect(page.locator(`[data-audience="${role}"]`)).toHaveAttribute("aria-pressed", "true");
    await expectAppropriateGuidance(page);
    if (role === "farmers") {
      await openDisclosure(page, "#personalisation-settings");
      await selectAndPersist(page, "#crop-profile", "maize", "crop");
      await selectAndPersist(page, "#crop-stage", "flowering", "stage");
      await selectAndPersist(page, "#soil-profile", "sand", "soil");
      await selectAndPersist(page, "#farm-goal", "irrigation", "farmGoal");
      await expect(page.locator("#personalisation-settings-summary")).toContainText("Maize");
    } else if (role === "gardeners") {
      await openDisclosure(page, "#personalisation-settings");
      await selectAndPersist(page, "#plant-profile", "newlyPlantedWoody", "plant");
      await selectAndPersist(page, "#garden-setting", "rainShadow", "setting");
      await selectAndPersist(page, "#garden-soil", "poorDrainage", "gardenSoil");
      await selectAndPersist(page, "#garden-goal", "waterlogging", "gardenGoal");
      await expect(page.locator("#personalisation-settings-summary")).toContainText("Newly planted");
    } else await expect(page.locator("#personalisation-settings")).toBeHidden();
  }
  await page.locator('[data-audience="farmers"]').click();
  await openDisclosure(page, "#personalisation-settings");
  await expect(page.locator("#crop-profile")).toHaveValue("maize");
  await expect(page.locator("#farm-goal")).toHaveValue("irrigation");
  await page.locator("#reset-personalisation").click();
  await expect(page.locator("#crop-profile")).toHaveValue("dominant");
  await expect(page.locator("#farm-goal")).toHaveValue("overview");
});

test("German narrow-screen layouts avoid page overflow and support keyboard results/map tabs", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/heatwave-demo.html?lang=de&state=DE2");
  await ready(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator("#results-view")).toBeVisible();
    await expect(page.locator("#map-view")).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.locator("#results-tab").focus();
    await page.locator("#results-tab").press("ArrowRight");
    await expect(page.locator("#map-tab")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#map-view")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.locator("#map-tab").press("ArrowLeft");
    await expect(page.locator("#results-tab")).toBeFocused();
  }
});

test("an expired shared date is explained and selecting another day dismisses the notice", async ({ page }) => {
  await page.goto("/heatwave-demo.html?lang=en&state=DE2&date=2000-01-01");
  await ready(page);
  await expect(page.locator("#requested-date-notice")).toBeVisible();
  await expect(page.locator("#requested-date-notice")).toContainText("2000-01-01");
  await expect(page.locator("#forecast-date")).toHaveValue(manifest.forecastDates[0]);
  await page.locator("#date-window button").last().click();
  await expect(page.locator("#forecast-date")).toHaveValue(manifest.forecastDates.at(-1));
  await expect(page.locator("#requested-date-notice")).toBeHidden();
});

test("an unavailable linked region falls back to a supported overview with an explanation", async ({ page }) => {
  const stateRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.includes("/states/")) stateRequests.push(request.url());
  });
  await page.goto("/heatwave-demo.html?lang=en&level=basin&state=DEZ&district=DEZZZ&basin=9999999999");
  await ready(page);
  await expect(page.locator("#region-title")).toHaveText("Bayern");
  await expect(page.locator("#requested-date-notice")).toBeVisible();
  await expect(page.locator("#requested-date-notice")).toContainText("linked region is unavailable");
  await expect.poll(() => new URL(page.url()).searchParams.get("level")).toBe("state");
  expect(new URL(page.url()).searchParams.get("state")).toBe("DE2");
  expect(new URL(page.url()).searchParams.has("district")).toBe(false);
  expect(new URL(page.url()).searchParams.has("basin")).toBe(false);
  expect(stateRequests).toEqual([]);
  await expect(page.locator("#location-search")).toBeEnabled();
});

test("technical source expiry suppresses advice and remains usable in both languages", async ({ page }) => {
  // Advance only the test browser clock. Genuine source times and weather
  // values remain unchanged; even a source two hours ahead at generation is
  // now beyond the eight-hour observation policy, within the nine-day window.
  await page.clock.setFixedTime(new Date(Date.parse(manifest.generatedAt) + 12 * 3_600_000));
  await page.goto("/heatwave-demo.html?lang=en&state=DE2&detail=technical");
  await ready(page);
  await expect(page.locator("#live-status-badge")).toHaveClass(/\bstale\b/);
  await expect(page.locator("#live-status-text")).toContainText("RADOLAN");
  await expect(page.locator("#decision-note")).toContainText("Suggested actions are suppressed");
  await expect(page.locator("#decision-note")).toContainText("RADOLAN");
  await expect(page.locator("#action-list li")).toHaveCount(0);
  await openDisclosure(page, "#evidence-details");
  await expect(page.locator("#signal-list")).toContainText("Thermal forecast");
  await openDisclosure(page, "#source-details");
  await expect(page.locator("#source-details")).toContainText("Stale / missing");
  await page.locator('[data-language="de"]').click();
  await expect(page.locator("#decision-note")).toContainText("unterdrückt");
  await expect(page.locator("#decision-note")).toContainText("RADOLAN");
  await expect(page.locator("#action-list li")).toHaveCount(0);
  await expect(page.locator("#signal-list")).not.toContainText("undefined");
});

test("manifest failure retains language and official links, then recovers through retry", async ({ page }) => {
  let unavailable = true;
  await page.route("**/assets/live/manifest.json", (route) => unavailable
    ? route.fulfill({ status: 503, contentType: "application/json", body: "{}" }) : route.continue());
  await page.goto("/heatwave-demo.html?lang=en&state=DE2");
  await expect(page.locator("#region-summary")).toContainText("could not load");
  await expect(page.locator('[data-language="de"]')).toBeEnabled();
  await page.locator('[data-language="de"]').click();
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.locator("#region-summary")).toContainText("Übersicht");
  await expect(page.locator("a[data-warning-link]").first()).toBeVisible();
  await expect(page.locator("#retry-load")).toBeEnabled();
  unavailable = false;
  await page.locator("#retry-load").click();
  await ready(page);
  await expect(page.locator("#region-title")).toHaveText("Bayern");
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
});

test("a failed regional bundle preserves the national view and retries only the requested detail", async ({ page }) => {
  let unavailable = true;
  await page.route(/\/assets\/live\/snapshots\/[^/]+\/states\/DE2\.json$/, (route) => unavailable
    ? route.fulfill({ status: 503, contentType: "application/json", body: "{}" }) : route.continue());
  await page.goto("/heatwave-demo.html?lang=en&state=DE2");
  await ready(page);
  const selectedDate = await page.locator("#forecast-date").inputValue();
  await chooseMunichCity(page);
  await expect(page.locator("#view-feedback")).toContainText("previous view is preserved");
  await expect(page.locator("#region-title")).toHaveText("Bayern");
  await expect(page.locator("#location-search")).toBeEnabled();
  await expect(page.locator("#retry-load")).toBeVisible();
  unavailable = false;
  await page.locator("#retry-load").click();
  await expect(page.locator("#region-title")).toHaveText("München, Kreisfreie Stadt");
  await expect(page.locator("#forecast-date")).toHaveValue(selectedDate);
});

test("a new immutable-version replay preserves region, date, language and growing settings", async ({ page }) => {
  // Test-only replay: same genuine source times and weather values, distinct
  // immutable IDs and hashes. It does not claim to be a real new observation.
  const replay = structuredClone(manifest);
  replay.snapshotId = `${manifest.snapshotId.slice(0, 15)}eeeeeeeeeeee`;
  const responses = new Map();
  for (const [name, reference] of [["overview", manifest.overview], ["DE2", manifest.states.DE2]]) {
    const payload = JSON.parse(await readFile(new URL(reference.url, manifestPath), "utf8"));
    payload.snapshotId = replay.snapshotId;
    const body = Buffer.from(JSON.stringify(payload));
    const nextReference = { ...reference, url: reference.url.replace(manifest.snapshotId, replay.snapshotId),
      bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") };
    if (name === "overview") replay.overview = nextReference;
    else replay.states.DE2 = nextReference;
    responses.set(`/assets/live/${nextReference.url}`, body);
  }
  for (const [id, reference] of Object.entries(replay.states)) {
    if (id !== "DE2") reference.url = reference.url.replace(manifest.snapshotId, replay.snapshotId);
  }
  let offerReplay = false;
  await page.route("**/assets/live/manifest.json", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(offerReplay ? replay : manifest)
  }));
  await page.route(`**/assets/live/snapshots/${replay.snapshotId}/**`, (route) => {
    const body = responses.get(new URL(route.request().url()).pathname);
    return body ? route.fulfill({ status: 200, contentType: "application/json", body }) : route.fulfill({ status: 404, body: "Unrequested test-only replay region" });
  });
  const requestedDate = manifest.forecastDates[3];
  await page.goto(`/heatwave-demo.html?lang=de&state=DE2&audience=farmers&crop=maize&stage=flowering&soil=sand&farmGoal=irrigation&date=${requestedDate}`);
  await ready(page);
  await expect.poll(() => new URL(page.url()).searchParams.get("crop")).toBe("maize");
  await openDisclosure(page, "#source-details");
  await expect(page.locator("#source-details")).toContainText(manifest.snapshotId);
  offerReplay = true;
  await page.locator("#snapshot-update-check").click();
  await expect(page.locator("#snapshot-update-status")).toHaveAttribute("data-state", "available");
  await page.locator("#snapshot-update-apply").click();
  await expect(page.locator("#source-details")).toContainText(replay.snapshotId);
  await expect(page.locator("#snapshot-update-status")).toHaveAttribute("data-state", "current");
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.locator("#region-title")).toHaveText("Bayern");
  await expect(page.locator("#forecast-date")).toHaveValue(requestedDate);
  await openDisclosure(page, "#personalisation-settings");
  await expect(page.locator("#crop-profile")).toHaveValue("maize");
  await expect(page.locator("#crop-stage")).toHaveValue("flowering");
  await expect(page.locator("#soil-profile")).toHaveValue("sand");
  await expect(page.locator("#farm-goal")).toHaveValue("irrigation");
});

test("sharing and reopening a URL restores the same regional view and settings", async ({ page }) => {
  const date = manifest.forecastDates[4];
  await page.goto(`/heatwave-demo.html?lang=en&state=DE2&audience=gardeners&plant=newlyPlantedWoody&setting=rainShadow&gardenSoil=poorDrainage&gardenGoal=waterlogging&date=${date}`);
  await ready(page);
  await expect.poll(() => new URL(page.url()).searchParams.get("gardenGoal")).toBe("waterlogging");
  await chooseMunichCity(page);
  await expect(page.locator("#region-title")).toHaveText("München, Kreisfreie Stadt");
  await page.locator('[data-language="de"]').click();
  await page.locator("#share-view").click();
  const sharedUrl = page.url();
  await page.goto("/heatwave-demo.html?lang=en&state=DE1");
  await ready(page);
  await page.goto(sharedUrl);
  await ready(page);
  await expect(page.locator("#region-title")).toHaveText("München, Kreisfreie Stadt");
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.locator('[data-audience="gardeners"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#forecast-date")).toHaveValue(date);
  await openDisclosure(page, "#personalisation-settings");
  await expect(page.locator("#plant-profile")).toHaveValue("newlyPlantedWoody");
  await expect(page.locator("#garden-setting")).toHaveValue("rainShadow");
  await expect(page.locator("#garden-soil")).toHaveValue("poorDrainage");
  await expect(page.locator("#garden-goal")).toHaveValue("waterlogging");
});
