import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: ["fmap-packaged.spec.js", "export-packaged.spec.js"],
  timeout: 30_000,
  use: {
    headless: true
  }
});
