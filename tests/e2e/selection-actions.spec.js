import { test, expect } from "@playwright/test";

async function loadImage(page, bands = 2) {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  const data = Buffer.alloc(100 * 80 * bands * 4);
  for (let i = 0; i < 8000 * bands; i++) data.writeFloatLE(i % 100 + Math.floor(i / 8000) * 100, i * 4);
  await page.locator("#filePicker").setInputFiles([
    { name: "selection.hdr", mimeType: "text/plain", buffer: Buffer.from(`ENVI\nsamples = 100\nlines = 80\nbands = ${bands}\ndata type = 4\ninterleave = bsq\nbyte order = 0\nband names = {First, Second}\n`) },
    { name: "selection.raw", mimeType: "application/octet-stream", buffer: data }
  ]);
  await expect(page.locator("#displayDock")).toBeVisible();
}

test("point selection places its action in quadrant IV and preserves the target", async ({ page }, testInfo) => {
  await loadImage(page);
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  const toolbar = page.locator("#selectionActions");
  await expect(toolbar).toBeHidden();
  await expect(page.locator("#drawTools #btnToolSpectral")).toHaveCount(0);
  await page.mouse.click(550, 340);
  await expect(toolbar).toBeVisible();
  await expect(toolbar).toHaveAttribute("data-placement", "right");
  await expect(toolbar).toHaveAttribute("aria-orientation", "horizontal");
  const position = await toolbar.boundingBox();
  expect(position.x - 555).toBeCloseTo(4, 0);
  expect(position.y - 345).toBeCloseTo(4, 0);
  await page.screenshot({ path: testInfo.outputPath("point-actions.png") });
  await expect(page.getByRole("button", { name: "Spatial histogram", exact: true })).toBeHidden();
  const remove = page.getByRole("button", { name: "Remove annotation", exact: true });
  await expect(remove.locator("svg.icon-tabler-x")).toHaveCount(1);
  const removeBox = await remove.boundingBox();
  const spectrumBox = await page.locator("#btnToolSpectral").boundingBox();
  expect(removeBox.y).toBe(spectrumBox.y);
  expect(removeBox.x).toBeGreaterThan(spectrumBox.x);
  await expect(page.locator("#specPanel")).toBeHidden();
  await page.getByRole("button", { name: "Spectrum", exact: true }).click();
  await expect(page.locator("#specPanel")).toBeVisible();
  await expect(page.locator("#specSub")).toContainText("(45, 34)");
  await expect(toolbar).toBeVisible();
  await page.locator("#btnSpecClose").click();
  await expect(page.locator("#specPanel")).toBeHidden();
  await expect(toolbar).toBeVisible();
  await remove.click();
  await expect(toolbar).toBeHidden();
  await expect(page.locator("#specPanel")).toBeHidden();
  expect(errors).toEqual([]);
});

test("dragged regions offer both analyses and follow the image during zoom", async ({ page }, testInfo) => {
  await loadImage(page);
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  const toolbar = page.locator("#selectionActions");
  await page.mouse.move(400, 290);
  await page.mouse.down();
  await page.mouse.move(620, 440, { steps: 8 });
  await expect(toolbar).toBeHidden();
  await page.mouse.up();
  await expect(toolbar).toBeVisible();
  await expect(toolbar).toHaveAttribute("data-placement", "top");
  await expect(toolbar).toHaveAttribute("aria-orientation", "horizontal");
  const regionActions = await toolbar.boundingBox();
  const spectrumButton = await page.locator("#btnToolSpectral").boundingBox();
  const spatialButton = await page.locator("#btnToolHistogram").boundingBox();
  const buttonGap = spatialButton.x - spectrumButton.x - spectrumButton.width;
  expect(buttonGap).toBeCloseTo(4, 0);
  expect(regionActions.x).toBeCloseTo(400, 0);
  expect(290 - regionActions.y - regionActions.height).toBeCloseTo(buttonGap, 0);
  await page.screenshot({ path: testInfo.outputPath("selection-actions.png") });
  await page.getByRole("button", { name: "Spatial histogram", exact: true }).click();
  await expect(page.locator("#analysisHistPanel")).toBeVisible();
  await expect(page.locator("#analysisStatN")).toHaveText("368");
  await page.getByRole("button", { name: "Spectrum", exact: true }).click();
  await expect(page.locator("#specPanel")).toBeVisible();
  await expect(page.locator("#specSub")).toContainText("Area");
  await expect(page.locator("#specFoot")).toContainText("Mean");
  await expect(page.locator("#analysisHistPanel")).toBeVisible();
  await expect.poll(async () => {
    const a = await page.locator("#specPanel").boundingBox();
    const b = await page.locator("#analysisHistPanel").boundingBox();
    return a.x + a.width <= b.x || b.x + b.width <= a.x
      || a.y + a.height <= b.y || b.y + b.height <= a.y;
  }).toBe(true);
  const spectrumSize = await page.locator("#specPanel").boundingBox();
  const histogramSize = await page.locator("#analysisHistPanel").boundingBox();
  expect(spectrumSize.width).toBe(400);
  expect(spectrumSize.height).toBe(330);
  expect(histogramSize.width).toBe(spectrumSize.width);
  expect(histogramSize.height).toBe(spectrumSize.height);
  await page.screenshot({ path: testInfo.outputPath("both-analysis-panels.png") });
  await page.locator("#btnAnalysisHistClose").click();
  await expect(page.locator("#specPanel")).toBeVisible();
  await page.getByRole("button", { name: "Spatial histogram", exact: true }).click();
  await expect(page.locator("#analysisHistPanel")).toBeVisible();
  await expect(page.locator("#specPanel")).toBeVisible();
  await page.locator("#btnSpecClose").click();
  await expect(page.locator("#analysisHistPanel")).toBeVisible();
  await page.locator("#btnAnalysisHistClose").click();
  const before = await toolbar.boundingBox();
  await page.mouse.move(500, 350);
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(60);
  }
  await expect.poll(async () => (await toolbar.boundingBox())?.x).not.toBe(before.x);
  const zoomed = await toolbar.boundingBox();
  await page.keyboard.down("Space");
  await page.mouse.move(450, 500);
  await page.mouse.down();
  await page.mouse.move(510, 500, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  await expect.poll(async () => (await toolbar.boundingBox())?.x).toBeCloseTo(zoomed.x + 60, 0);
  const panned = await toolbar.boundingBox();
  await page.mouse.move(450, 500);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(430, 500, { steps: 4 });
  await page.mouse.up({ button: "middle" });
  await expect.poll(async () => (await toolbar.boundingBox())?.x).toBeCloseTo(panned.x - 20, 0);
  await page.keyboard.press("Escape");
  await expect(toolbar).toBeHidden();
  expect(errors).toEqual([]);
});

test("near the right edge point actions stay horizontal and inside the viewport", async ({ page }) => {
  await loadImage(page);
  await page.mouse.move(600, 400);
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(150);
  await page.mouse.click(1180, 250);
  const toolbar = page.locator("#selectionActions");
  await expect(toolbar).toBeVisible();
  await expect(toolbar).toHaveAttribute("aria-orientation", "horizontal");
  const box = await toolbar.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(1200);
  expect(box.y).toBeGreaterThan(250);
});

test("running spectrum reports progress on the annotation edge and clears on removal", async ({ page }, testInfo) => {
  await loadImage(page, 512);
  await page.mouse.move(400, 290);
  await page.mouse.down();
  await page.mouse.move(620, 440, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".annotation-progress")).toHaveCount(0);
  await page.getByRole("button", { name: "Spectrum", exact: true }).click();
  const progress = page.getByRole("progressbar", { name: "Computing spectrum", exact: true });
  await expect(progress).toBeVisible();
  await expect(progress).not.toHaveAttribute("title");
  await expect(progress.locator("span")).toHaveCount(2);
  const bar = await progress.boundingBox();
  expect(bar.x).toBeCloseTo(400, 0);
  expect(bar.y).toBeCloseTo(288, 0);
  expect(bar.width).toBeCloseTo(220, 0);
  expect(bar.height).toBe(4);
  await page.screenshot({ path: testInfo.outputPath("annotation-progress.png") });
  await page.getByRole("button", { name: "Remove annotation", exact: true }).click();
  await expect(page.locator(".annotation-progress")).toHaveCount(0);
  await expect(page.locator("#selectionActions")).toBeHidden();
  // A background completion must not reopen a removed annotation's spectrum.
  await page.waitForTimeout(400);
  await expect(page.locator("#specPanel")).toBeHidden();
});

test("tall regions place vertical actions along the long edge and can be removed", async ({ page }, testInfo) => {
  await loadImage(page);
  await page.mouse.move(440, 230);
  await page.mouse.down();
  await page.mouse.move(530, 530, { steps: 8 });
  await page.mouse.up();
  const toolbar = page.locator("#selectionActions");
  await expect(toolbar).toHaveAttribute("aria-orientation", "vertical");
  await expect(toolbar).toHaveAttribute("data-placement", "right");
  const box = await toolbar.boundingBox();
  expect(box.x).toBeCloseTo(534, 0);
  expect(box.y).toBeCloseTo(230, 0);
  const spectrum = await page.locator("#btnToolSpectral").boundingBox();
  const histogram = await page.locator("#btnToolHistogram").boundingBox();
  const remove = await page.locator("#btnRemoveAnnotation").boundingBox();
  expect(histogram.x).toBe(spectrum.x);
  expect(remove.x).toBe(spectrum.x);
  expect(remove.y).toBeGreaterThan(histogram.y);
  await page.screenshot({ path: testInfo.outputPath("tall-region-actions.png") });
  await page.getByRole("button", { name: "Remove annotation", exact: true }).click();
  await expect(toolbar).toBeHidden();
  // A new tap in the removed region offers point analysis, not region analysis.
  await page.mouse.click(480, 340);
  await expect(toolbar).toHaveAttribute("aria-orientation", "horizontal");
  await expect(page.locator("#btnToolHistogram")).toBeHidden();
});

test.describe("high DPI", () => {
  test.use({ deviceScaleFactor: 2 });
  test("point actions use CSS coordinates and open the selected pixel", async ({ page }) => {
    await loadImage(page);
    await page.mouse.click(550, 340);
    const toolbar = page.locator("#selectionActions");
    await expect(toolbar).toBeVisible();
    const box = await toolbar.boundingBox();
    expect(box.x - 555).toBeCloseTo(4, 0);
    expect(box.y - 345).toBeCloseTo(4, 0);
    await page.getByRole("button", { name: "Spectrum", exact: true }).click();
    await expect(page.locator("#specSub")).toContainText("(45, 34)");
  });
});

test("two-finger pinch still zooms without creating a region", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Native multi-touch injection requires Chromium CDP.");
  await loadImage(page);
  const session = await page.context().newCDPSession(page);
  const zoom = await page.locator("#zoomLabel").textContent();
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart", touchPoints: [{ id: 1, x: 400, y: 300 }]
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart", touchPoints: [{ id: 1, x: 400, y: 300 }, { id: 2, x: 650, y: 300 }]
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchMove", touchPoints: [{ id: 1, x: 350, y: 300 }, { id: 2, x: 700, y: 300 }]
  });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(page.locator("#zoomLabel")).not.toHaveText(zoom);
  await expect(page.locator("#selectionActions")).toBeHidden();
});

test("shape selections offer actions and a later point uses its own pixel spectrum", async ({ page }) => {
  await loadImage(page);
  await page.getByRole("button", { name: "Shape", exact: true }).click();
  await page.mouse.move(400, 290);
  await page.mouse.down();
  await page.mouse.move(620, 440, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("#selectionActions")).toBeVisible();
  await expect(page.getByRole("button", { name: "Spatial histogram", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Shape", exact: true }).click();
  await page.mouse.click(800, 300);
  await expect(page.getByRole("button", { name: "Spatial histogram", exact: true })).toBeHidden();
  const spectrum = page.getByRole("button", { name: "Spectrum", exact: true });
  await spectrum.focus();
  await page.keyboard.press("Space");
  await expect(page.locator("#specPanel")).toBeVisible();
  await expect(page.locator("#specSub")).toHaveText("(70, 30)");
});

for (const bands of [2, 32]) {
  test(`region color reaches histogram and ${bands === 2 ? "bar" : "line"} spectrum`, async ({ page }, testInfo) => {
    await loadImage(page, bands);
    await page.mouse.move(400, 290);
    await page.mouse.down();
    await page.mouse.move(620, 440, { steps: 8 });
    await page.mouse.up();
    // Changing the brush for future drawings must not recolor this region.
    await page.locator("#drawColorPreview").click();
    await page.getByRole("button", { name: "Green swatch", exact: true }).click();
    await page.getByRole("button", { name: "Spatial histogram", exact: true }).click();
    await expect(page.locator("#analysisStatN")).toHaveText("368");
    await page.getByRole("button", { name: "Spectrum", exact: true }).click();
    await expect(page.locator("#specFoot")).toContainText("Mean");
    for (const id of ["analysisHistCanvas", "specCanvas"]) {
      await expect.poll(() => page.locator(`#${id}`).evaluate((canvas) => {
        const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] === 255 && pixels[i + 1] === 45 && pixels[i + 2] === 45 && pixels[i + 3] > 200) count++;
        }
        return count;
      })).toBeGreaterThan(20);
    }
    await page.screenshot({ path: testInfo.outputPath("region-colored-analysis.png") });
  });
}
