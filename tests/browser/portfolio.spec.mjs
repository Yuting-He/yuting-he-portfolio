import { test, expect } from "@playwright/test";

const transparentTile = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
const pageErrors = new WeakMap();

test.use({ reducedMotion: "reduce" });

test.beforeEach(async ({ page }) => {
  pageErrors.set(page, []);
  page.on("pageerror", (error) => pageErrors.get(page).push(error.message));
  await page.route(/https:\/\/(?:[abc]\.)?tile\.openstreetmap\.org\//, (route) => route.fulfill({
    status: 200, contentType: "image/png", body: transparentTile
  }));
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page), "No unhandled script errors while using the portfolio and project entry pages").toEqual([]);
});

async function expectNoHorizontalOverflow(page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), {
    message: "The page fits the viewport without document-wide horizontal scrolling"
  }).toBeLessThanOrEqual(1);
}

async function followSectionLink(page, id, headingSelector) {
  await page.locator(`header.site-header nav a[href="#${id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`#${id}$`));
  const heading = page.locator(headingSelector);
  await expect(heading).toBeVisible();
  await expect.poll(async () => {
    const [header, title, viewport] = await Promise.all([
      page.locator("header.site-header").boundingBox(), heading.boundingBox(),
      page.evaluate(() => ({ height: window.innerHeight }))
    ]);
    return Boolean(header && title && title.y >= header.y + header.height + 2 && title.y < viewport.height);
  }, { message: `The ${id} heading is visible below the sticky navigation` }).toBe(true);
}

for (const width of [360, 390, 430]) {
  test(`mobile portfolio navigation and project screenshots fit ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const response = await page.goto("/index.html");
    expect(response.status()).toBe(200);
    await expect(page.locator("body")).toHaveClass(/\bportfolio\b/);
    await expectNoHorizontalOverflow(page);

    await followSectionLink(page, "projects", "#projects-title");
    const projects = page.locator("section#projects article[id]");
    await expect(projects.nth(0)).toHaveAttribute("id", "heatlens");
    await expect(projects.nth(1)).toHaveAttribute("id", "gridscout");

    const screenshots = page.locator('#projects img[src*="assets/portfolio/"]');
    expect(await screenshots.count(), "Both featured projects expose real screenshot assets").toBeGreaterThanOrEqual(2);
    for (const image of await screenshots.all()) {
      await expect(image).toHaveAttribute("src", /assets\/portfolio\/.+\.webp$/);
      await expect(image).toHaveAttribute("alt", /\S/);
      await image.scrollIntoViewIfNeeded();
      await expect.poll(() => image.evaluate((element) => element.complete && element.naturalWidth > 0), {
        message: "The project screenshot downloads and decodes successfully"
      }).toBe(true);
    }
    await expectNoHorizontalOverflow(page);

    await followSectionLink(page, "education", "#education h2");
    await expectNoHorizontalOverflow(page);
  });
}

test("desktop project cards open the actual HeatLens and GridScout pages", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/index.html#projects");
  const heatlens = page.locator('article#heatlens a[href="./heatwave-demo.html"]').first();
  await expect(heatlens).toBeVisible();
  await heatlens.click();
  await expect(page).toHaveURL(/\/heatwave-demo\.html(?:[?#].*)?$/);
  await expect(page).toHaveTitle(/HeatLens Germany/);
  // The entry path must work independently of whether the saved data is fresh.
  await expect(page.locator("#demo-title")).toBeVisible();
  await expect(page.locator("#application")).toBeVisible();

  await page.goto("/index.html#projects");
  const gridscout = page.locator('article#gridscout a[href="./watt-hackathon/index.html"]').first();
  await expect(gridscout).toBeVisible();
  await gridscout.click();
  await expect(page).toHaveURL(/\/watt-hackathon\/index\.html(?:[?#].*)?$/);
  await expect(page).toHaveTitle(/GridScout/);
  await expect(page.locator("#page-showcase h1")).toBeVisible();
});

test("keyboard users can skip navigation and activate the primary project entrance", async ({ page }) => {
  await page.goto("/index.html");
  const skip = page.locator('a[href="#top"]').filter({ hasText: /skip/i });
  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#top")).toBeFocused();

  const primary = page.locator('.hero a[href="./heatwave-demo.html"]').first();
  // Follow the real tab order rather than programmatically focusing the CTA.
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press("Tab");
    if (await primary.evaluate((element) => element === document.activeElement)) break;
  }
  await expect(primary).toBeFocused();
  await expect(primary).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/heatwave-demo\.html(?:[?#].*)?$/);
  await expect(page.locator("#demo-title")).toBeVisible();
});
