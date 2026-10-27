import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: "artifacts/playwright-report", open: "never" }]],
  outputDir: "artifacts/browser-results",
  use: {
    baseURL: "http://127.0.0.1:4191",
    locale: "en-GB",
    timezoneId: "Europe/Berlin",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off"
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } }],
  webServer: {
    command: "node scripts/serve.mjs",
    url: "http://127.0.0.1:4191/heatwave-demo.html",
    env: { PORT: "4191" },
    timeout: 120_000,
    reuseExistingServer: !process.env.CI
  }
});
