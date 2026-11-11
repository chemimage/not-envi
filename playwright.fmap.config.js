import { defineConfig, devices } from "@playwright/test";

const baseUse = {
  baseURL: "http://127.0.0.1:4173",
  headless: true,
  browserName: "chromium"
};

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: ["fmap-browser.spec.js", "fmap-tiff-coverage.spec.js", "fmap-page-fill.spec.js"],
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: baseUse,
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], ...baseUse }
    },
    {
      name: "iphone-13-chromium-emulation",
      use: { ...devices["iPhone 13"], ...baseUse }
    },
    {
      name: "pixel-7-chromium-emulation",
      use: { ...devices["Pixel 7"], ...baseUse }
    }
  ],
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI
  }
});
