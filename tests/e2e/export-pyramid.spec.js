import { test } from "@playwright/test";
import { exportPyramidFixture } from "./helpers/pyramid-export-fixture.js";

test("large TIFF downloads contain per-band pyramids and reopen with the original band count", async ({ page }, testInfo) => {
  await exportPyramidFixture(page, testInfo);
});
