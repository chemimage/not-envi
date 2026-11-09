import { test, expect } from "@playwright/test";

async function loadImage(page) {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  const data = Buffer.alloc(100 * 80 * 2 * 4);
  for (let i = 0; i < 16000; i++) data.writeFloatLE(i % 100 + Math.floor(i / 8000) * 100, i * 4);
  await page.locator("#filePicker").setInputFiles([
    { name: "selection.hdr", mimeType: "text/plain", buffer: Buffer.from("ENVI\nsamples = 100\nlines = 80\nbands = 2\ndata type = 4\ninterleave = bsq\nbyte order = 0\nband names = {First, Second}\n") },
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
  const position = await toolbar.boundingBox();
  expect(position.x - 555).toBeCloseTo(4, 0);
  expect(position.y - 345).toBeCloseTo(4, 0);
  await page.screenshot({ path: testInfo.outputPath("point-actions.png") });
  await expect(page.getByRole("button", { name: "Spatial histogram", exact: true })).toBeHidden();
  await expect(page.locator("#specPanel")).toBeHidden();
  await page.getByRole("button", { name: "Spectrum", exact: true }).click();
  await expect(page.locator("#specPanel")).toBeVisible();
  await expect(page.locator("#specSub")).toContainText("(45, 34)");
  await expect(toolbar).toBeVisible();
  await page.locator("#btnSpecClose").click();
  await expect(page.locator("#specPanel")).toBeHidden();
  await expect(toolbar).toBeVisible();
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
  await expect(toolbar).toHaveAttribute("data-placement", "right");
  const regionActions = await toolbar.boundingBox();
  const spectrumButton = await page.locator("#btnToolSpectral").boundingBox();
  const spatialButton = await page.locator("#btnToolHistogram").boundingBox();
  const buttonGap = spatialButton.y - spectrumButton.y - spectrumButton.height;
  expect(buttonGap).toBeCloseTo(4, 0);
  expect(regionActions.x - 620).toBeCloseTo(buttonGap, 0);
  expect(regionActions.y).toBeCloseTo(290, 0);
  await page.screenshot({ path: testInfo.outputPath("selection-actions.png") });
  await page.getByRole("button", { name: "Spatial histogram", exact: true }).click();
  await expect(page.locator("#analysisHistPanel")).toBeVisible();
  await expect(page.locator("#analysisStatN")).toHaveText("368");
  await page.locator("#btnAnalysisHistClose").click();
  await page.getByRole("button", { name: "Spectrum", exact: true }).click();
  await expect(page.locator("#specPanel")).toBeVisible();
  await expect(page.locator("#specSub")).toContainText("Area");
  await page.locator("#btnSpecClose").click();
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

test("near the right edge actions fall back above the selection", async ({ page }) => {
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
  await expect(toolbar).toHaveAttribute("data-placement", "top");
  const box = await toolbar.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(1200);
  expect(box.y + box.height).toBeLessThan(250);
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

test("two-finger pinch still zooms without creating a region", async ({ page }) => {
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
