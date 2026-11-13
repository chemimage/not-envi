import { expect, test } from "@playwright/test";
import { exportImage, loadColorFixture } from "./helpers/export-fixture.js";
import { exportPyramidFixture } from "./helpers/pyramid-export-fixture.js";

test("packaged HTML exports RGB through its embedded worker offline", async ({ page }) => {
  await page.context().setOffline(true);
  const url = new URL("../../dist/index.html", import.meta.url);
  await loadColorFixture(page, url.href);
  const output = await exportImage(page, { format: "tiff", rendered: false, selection: true });
  expect(output.samples).toBe(3);
  expect(output.photometric).toBe(2);
  expect(output.channels[0].every((value, i) => value + output.channels[2][i] === 255)).toBe(true);
});

test("packaged HTML exports and reopens a large pyramidal TIFF offline", async ({ page }, testInfo) => {
  await page.context().setOffline(true);
  const url = new URL("../../dist/index.html", import.meta.url);
  await exportPyramidFixture(page, testInfo, url.href);
});
