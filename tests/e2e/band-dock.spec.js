import { expect, test } from "@playwright/test";

test("composites collapse to a label and mode button, then grayscale restores band selection", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.addInitScript(() => {
    window.__scaleFonts = [];
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
      if (this.canvas.id === "overlayCanvas" && / (px|µm|mm|nm)$/.test(text)) window.__scaleFonts.push(this.font);
      return fillText.call(this, text, ...args);
    };
  });
  await page.goto("/");
  const data = Buffer.alloc(100 * 80 * 3 * 4);
  for (let i = 0; i < 24000; i++) data.writeFloatLE((i % 100) / 100, i * 4);
  await page.locator("#filePicker").setInputFiles([
    { name: "bands.hdr", mimeType: "text/plain", buffer: Buffer.from("ENVI\nsamples = 100\nlines = 80\nbands = 3\ndata type = 4\ninterleave = bsq\nbyte order = 0\nband names = {Red, Green, Blue}\n") },
    { name: "bands.raw", mimeType: "application/octet-stream", buffer: data }
  ]);
  const dock = page.locator("#bandDock"), mode = page.locator("#bandColorMode");
  const track = page.locator("#bandDockTrack"), selector = page.locator("#bandSelector");
  await expect(mode).toHaveText("Gray");
  await expect(track).toBeVisible();
  const expanded = await dock.boundingBox();
  await mode.click();
  await expect(mode).toHaveText("RGB");
  await expect(page.locator("#bandDockLock")).toHaveText("Color composite");
  await expect(page.locator("#bandDockLock i")).toHaveCount(0);
  for (const id of ["bandDockTrack", "bandDockMin", "bandDockMax", "bandDockValue", "bandDockPreview"]) {
    await expect(page.locator(`#${id}`)).toBeHidden();
  }
  await expect(selector).toHaveAttribute("role", "group");
  const collapsed = await dock.boundingBox();
  expect(collapsed.width).toBeLessThan(expanded.width);
  const fonts = await page.evaluate(() => ({
    title: getComputedStyle(document.querySelector(".ds-item .title")).fontSize,
    composite: getComputedStyle(document.querySelector("#bandDockLock")).fontSize,
    scales: window.__scaleFonts,
    icons: [...document.querySelectorAll(".draw-tool-btn i, .draw-color-wrap i")].map(icon => getComputedStyle(icon).display)
  }));
  expect(fonts.composite).toBe(fonts.title);
  expect(fonts.scales.some(font => font.includes("14px"))).toBe(true);
  expect(fonts.icons.every(display => /^(inline-)?flex$/.test(display))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("composite.png") });
  await mode.click();
  await expect(mode).toHaveText("BGR");
  await expect(track).toBeHidden();
  await mode.click();
  await expect(mode).toHaveText("Gray");
  await expect(track).toBeVisible();
  await expect(page.locator("#bandDockMin")).toBeVisible();
  await expect(page.locator("#bandDockMax")).toBeVisible();
  await expect(page.locator("#bandDockLock")).toBeHidden();
  await expect(selector).toHaveAttribute("role", "slider");
  expect((await dock.boundingBox()).width).toBe(expanded.width);
  await selector.focus();
  await selector.press("ArrowRight");
  await expect(selector).toHaveAttribute("aria-valuenow", "1");
  await page.screenshot({ path: testInfo.outputPath("grayscale.png") });
});
