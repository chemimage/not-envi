import { test, expect } from "@playwright/test";

test("shape mode opens from a side button and updates the main selector", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  await page.locator("#filePicker").setInputFiles([
    { name: "shape.hdr", mimeType: "text/plain", buffer: Buffer.from("ENVI\nsamples = 100\nlines = 80\nbands = 1\ndata type = 4\ninterleave = bsq\nbyte order = 0\n") },
    { name: "shape.raw", mimeType: "application/octet-stream", buffer: Buffer.alloc(32000) }
  ]);
  await expect(page.locator("#drawTools")).toBeVisible();
  const selector = page.getByRole("button", { name: "Shape", exact: true });
  const sideButton = page.locator("#toolShape");
  const flyout = page.locator("#shapeModeFlyout");
  await expect(sideButton).toBeHidden();
  const inactiveRail = await page.locator("#drawTools").boundingBox();
  await selector.click();
  await expect(sideButton).toBeVisible();
  const main = await selector.boundingBox();
  const side = await sideButton.boundingBox();
  const rail = await page.locator("#drawTools").boundingBox();
  expect(rail.height).toBe(inactiveRail.height);
  expect(side.x).toBeGreaterThan(rail.x + rail.width);
  expect(side.y + side.height / 2).toBeCloseTo(main.y + main.height / 2, 0);
  expect(side.width).toBeLessThan(main.width);
  expect(side.height).toBe(main.height);
  await sideButton.click();
  await expect(flyout).toBeVisible();
  await expect(sideButton).toBeHidden();
  const options = await flyout.boundingBox();
  expect(options.x).toBe(side.x);
  expect(options.y).toBe(main.y);
  await expect(sideButton).toHaveAttribute("aria-expanded", "true");
  await flyout.locator('[data-shape-mode="3:4"]').click();
  await expect(flyout).toBeHidden();
  await expect(sideButton).toBeVisible();
  await expect(selector.locator("#toolShapeLabel")).toHaveText("3:4");
  await expect(selector).toHaveAttribute("title", "Shape: Aspect ratio 3:4 or 4:3");
  await expect(selector).toHaveClass(/active/);
  await sideButton.click();
  await page.screenshot({ path: testInfo.outputPath("shape-side-selector.png") });
  await flyout.locator('[data-shape-mode="polygon"]').click();
  await expect(selector.locator("#toolShapeIcon")).toHaveClass(/fa-draw-polygon/);
  await expect(flyout).toBeHidden();
  await selector.click();
  await expect(sideButton).toBeHidden();
  await selector.click();
  await expect(sideButton).toBeVisible();
  await sideButton.focus();
  await page.keyboard.press("Enter");
  await expect(flyout).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(flyout).toBeHidden();
  await expect(sideButton).toBeVisible();
  await expect(sideButton).toBeFocused();
  await sideButton.click();
  await page.getByRole("button", { name: "Ruler", exact: true }).click();
  await expect(sideButton).toBeHidden();
  await expect(flyout).toBeHidden();
});
