import { test, expect } from "@playwright/test";

async function loadImage(page) {
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.goto("/");
  const data = Buffer.alloc(100 * 80 * 4 * 4);
  for (let i = 0; i < 32000; i++) data.writeFloatLE(i % 100 + Math.floor(i % 8000 / 100) + Math.floor(i / 8000) * 100, i * 4);
  await page.locator("#filePicker").setInputFiles([
    { name: "comparison.hdr", mimeType: "text/plain", buffer: Buffer.from("ENVI\nsamples = 100\nlines = 80\nbands = 4\ndata type = 4\ninterleave = bsq\nbyte order = 0\npixel size = {2, 3}\nunits = um\n") },
    { name: "comparison.raw", mimeType: "application/octet-stream", buffer: data }
  ]);
  await expect(page.locator("#displayDock")).toBeVisible();
}

async function drag(page, x, y, x1, y1) {
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 8 }); await page.mouse.up();
}

async function chooseAll(host) {
  for (const input of await host.locator('.plot-picker input:not(:disabled)').all()) await input.check();
  await host.getByRole("button", { name: "Combine selected plots", exact: true }).click();
}

test("three same-color lines combine, split one trace, recombine, and delete one source", async ({ page }, testInfo) => {
  await loadImage(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: "Line profile", exact: true }).click();
  for (let i = 0; i < 3; i++) {
    await drag(page, 300, 250 + i * 120, 550, 280 + i * 120);
    await expect(page.locator("#lineProfileStatus")).toContainText("Hover");
    if (i < 2) await page.getByRole("button", { name: "Close line profile", exact: true }).click();
  }
  const original = page.locator("#lineProfilePanel");
  await original.getByRole("button", { name: "Combine line profile plots", exact: true }).click();
  await expect(original.locator('.plot-picker input')).toHaveCount(3);
  await chooseAll(original);
  let group = page.getByRole("dialog", { name: "Line profile comparison", exact: true });
  await expect(group).toHaveAttribute("data-trace-count", "3");
  await expect(original).toBeHidden();
  await group.getByRole("combobox", { name: "Distance axis" }).selectOption("relative");
  const swatches = group.locator(".plot-legend-entry svg line");
  await expect(swatches.nth(1)).toHaveAttribute("stroke-dasharray", "7 4");
  await group.getByRole("button", { name: /^Open Line 1 .* separately$/ }).click();
  await expect(group).toHaveAttribute("data-trace-count", "2");
  const single = page.locator('.plot-comparison-panel[data-trace-count="1"]');
  await expect(single).toBeVisible();
  await expect(single.getByRole("button", { name: /separately$/ })).toHaveCount(0);
  await single.getByRole("button", { name: "Combine more plots", exact: true }).click();
  await chooseAll(single);
  group = page.locator(".plot-comparison-panel");
  await expect(page.locator(".plot-comparison-panel")).toHaveCount(1);
  await expect(group).toHaveAttribute("data-trace-count", "3");
  await page.screenshot({ path: testInfo.outputPath("line-comparison.png") });
  await page.setViewportSize({ width: 390, height: 640 });
  await expect(group.getByRole("button", { name: /^Open Line 1 .* separately$/ })).toBeVisible();
  const small = await group.boundingBox();
  expect(small.x).toBeGreaterThanOrEqual(0);
  expect(small.x + small.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("line-comparison-small.png") });
  await page.setViewportSize({ width: 1280, height: 850 });
  await group.getByRole("button", { name: /^Delete source annotation for Line 1 / }).click();
  await expect(group).toHaveAttribute("data-trace-count", "2");
  await group.getByRole("button", { name: /^Remove Line 2 .* from chart$/ }).click();
  await expect(group).toHaveAttribute("data-trace-count", "1");
  await group.getByRole("button", { name: "Combine more plots", exact: true }).click();
  await expect(group.locator('.plot-picker input')).toHaveCount(2); // Removed line retained; deleted line gone.
  await group.getByRole("button", { name: "Cancel combining plots" }).click();
  await page.locator("#toolEraser").click();
  await expect(page.locator(".plot-comparison-panel")).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const kind of ["spectrum", "histogram"]) {
  test(`${kind} results retain regions, combine, split individually and close without deleting`, async ({ page }, testInfo) => {
    await loadImage(page);
    const original = page.locator(kind === "spectrum" ? "#specPanel" : "#analysisHistPanel");
    for (let i = 0; i < 2; i++) {
      if (i) {
        await original.getByRole("button", { name: kind === "spectrum" ? "Close spectrum" : "Close histogram", exact: true }).click();
        await page.locator("#drawColorPreview").click();
        await page.getByRole("button", { name: "Blue swatch", exact: true }).click();
      }
      await drag(page, 300, 250 + i * 190, 500, 340 + i * 190);
      await page.getByRole("button", { name: kind === "spectrum" ? "Spectrum" : "Spatial histogram", exact: true }).click();
      if (kind === "spectrum") await expect(page.locator("#specFoot")).toContainText("Mean");
      else await expect(page.locator("#analysisStatN")).not.toHaveText("—");
    }
    await original.getByRole("button", { name: kind === "spectrum" ? "Combine spectrum plots" : "Combine spatial histogram plots", exact: true }).click();
    await expect(original.locator('.plot-picker input')).toHaveCount(2);
    await chooseAll(original);
    const together = page.locator('.plot-comparison-panel[data-trace-count="2"]');
    await expect(together).toBeVisible();
    if (kind === "histogram") await together.getByRole("combobox", { name: "Histogram scale" }).selectOption("percentage");
    await page.screenshot({ path: testInfo.outputPath(`${kind}-comparison.png`) });
    await together.getByRole("button", { name: /^Open Region 1 .* separately$/ }).click();
    await expect(page.locator('.plot-comparison-panel[data-trace-count="1"]')).toHaveCount(2);
    const closes = page.getByRole("button", { name: "Close comparison chart", exact: true });
    while (await closes.count()) await closes.first().click();
    await expect(page.locator(".plot-comparison-panel")).toHaveCount(0);
    // Region 1 can still be selected and analysed after both charts close.
    await page.mouse.click(350, 290);
    await page.getByRole("button", { name: kind === "spectrum" ? "Spectrum" : "Spatial histogram", exact: true }).click();
    await expect(original).toBeVisible();
    if (kind === "spectrum") {
      await expect(page.locator("#specFoot")).toContainText("Mean");
      await original.getByRole("button", { name: "Combine spectrum plots", exact: true }).click();
      await chooseAll(original);
      await expect(page.locator(".plot-comparison-panel")).toHaveCount(1);
      await page.getByRole("button", { name: "Close dataset", exact: true }).click();
      await expect(page.locator(".plot-comparison-panel")).toHaveCount(0);
    }
  });
}
