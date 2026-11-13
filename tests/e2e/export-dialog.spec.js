import { expect, test } from "@playwright/test";

test("export dialog stays centered and its controls remain reachable in small windows", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  await page.locator("#filePicker").setInputFiles([
    { name: "dialog.hdr", mimeType: "text/plain", buffer: Buffer.from("ENVI\nsamples = 2\nlines = 2\nbands = 1\ndata type = 4\ninterleave = bsq\nbyte order = 0\n") },
    { name: "dialog.raw", mimeType: "application/octet-stream", buffer: Buffer.from(new Float32Array([1, 2, 3, 4]).buffer) }
  ]);
  await expect(page.locator("#displayDock")).toBeVisible();
  await page.locator("#btnToolExport").click();
  const dialog = page.locator("#exportDlg");
  await expect(dialog).toBeVisible();

  const expectCentered = async () => {
    const viewport = page.viewportSize();
    const box = await dialog.boundingBox();
    expect(box.x + box.width / 2).toBeCloseTo(viewport.width / 2, 0);
    expect(box.y + box.height / 2).toBeCloseTo(viewport.height / 2, 0);
    expect(box.x).toBeGreaterThanOrEqual(13);
    expect(box.y).toBeGreaterThanOrEqual(13);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 13);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 13);
  };
  await expectCentered();
  await page.screenshot({ path: testInfo.outputPath("export-dialog-desktop.png") });
  await page.locator("#expModeRendered").check();
  await expectCentered();
  await expect(page.locator("#expColorBarMin")).toHaveAttribute("placeholder", /^-?[\d.]+$/);
  await expect(page.locator("#expColorBarMax")).toHaveAttribute("placeholder", /^-?[\d.]+$/);
  await expect(page.locator("#expScaleBarInside")).toBeChecked();
  await expect(page.locator("#expColorBarInside")).toBeChecked();
  await page.locator("#expScaleBarCorner").selectOption("top-left");
  await page.locator("#expColorBarCorner").selectOption("bottom-right");
  await page.locator("#expColorBarInside").uncheck();
  await page.screenshot({ path: testInfo.outputPath("export-placement-controls.png") });

  await page.setViewportSize({ width: 420, height: 500 });
  await expectCentered();
  expect(await dialog.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.locator("#btnExpCancel").scrollIntoViewIfNeeded();
  await expect(page.locator("#btnExpCancel")).toBeInViewport();
  await expect(page.locator("#btnExpGo")).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("export-dialog-small-window.png") });
  await page.locator("#btnExpCancel").click();
  await expect(dialog).toBeHidden();
});
