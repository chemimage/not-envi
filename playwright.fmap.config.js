import { defineConfig, devices } from "@playwright/test";

const baseUse = {
  baseURL: "http://127.0.0.1:4173",
  headless: true
};

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: ["fmap-browser.spec.js", "fmap-tiff-coverage.spec.js", "fmap-page-fill.spec.js", "fmap-mappings.spec.js", "pyramid-cancellation.spec.js", "incremental-composition.spec.js", "composition-worker.spec.js", "pyramid-composition-worker.spec.js"],
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: baseUse,
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], ...baseUse, browserName: "chromium" }
    },
    {
      name: "desktop-webkit",
      use: { ...devices["Desktop Safari"], ...baseUse, browserName: "webkit" }
    }
  ],
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI
  }
});
