import { test, expect } from "@playwright/test";

async function loadImage(page, bands = 4) {
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.goto("/");
  const data = Buffer.alloc(100 * 80 * bands * 4);
  for (let i = 0; i < 8000 * bands; i++) data.writeFloatLE(i % 100 + Math.floor(i % 8000 / 100) + Math.floor(i / 8000) * 100, i * 4);
  await page.locator("#filePicker").setInputFiles([
    { name: "comparison.hdr", mimeType: "text/plain", buffer: Buffer.from(`ENVI\nsamples = 100\nlines = 80\nbands = ${bands}\ndata type = 4\ninterleave = bsq\nbyte order = 0\npixel size = {2, 3}\nunits = um\n`) },
    { name: "comparison.raw", mimeType: "application/octet-stream", buffer: data }
  ]);
  await expect(page.locator("#displayDock")).toBeVisible();
}
async function drag(page, x, y, x1, y1) {
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 8 }); await page.mouse.up();
}
async function color(page, name) {
  await page.locator("#drawColorPreview").click();
  await page.getByRole("button", { name: `${name} swatch`, exact: true }).click();
}

test("color-owned line windows update in place and toggle all stacked / all split with solid traces", async ({ page }, testInfo) => {
  await loadImage(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const order = await page.locator("#drawTools").evaluate((node) => [...node.children].map((item) => item.id || item.className));
  expect(order).toEqual(["draw-color-anchor", "draw-tools-separator", "toolRuler", "region-tool-anchor draw-tools-group-gap", "btnToolAreaMode", "toolEraser", "draw-tools-separator", "btnToolExport"]);
  await page.getByRole("button", { name: "Line profile", exact: true }).click();
  await drag(page, 300, 250, 550, 280);
  const profiles = page.locator('.line-profile-panel[data-line-profile]');
  const red = page.locator('.line-profile-panel[data-color="#ff2d2d"]');
  await expect(red.locator(".line-profile-status")).toContainText("Hover");
  const before = await red.locator(".line-profile-coordinates").textContent();
  await drag(page, 300, 370, 550, 400);
  await expect(profiles).toHaveCount(1);
  await expect(red.locator(".line-profile-coordinates")).not.toHaveText(before);
  await expect(red.locator(".analysis-hist-title")).toHaveCSS("color", "rgb(255, 45, 45)");
  await color(page, "Blue"); await drag(page, 300, 490, 550, 520);
  const blue = page.locator('.line-profile-panel[data-color="#0ea5e9"]');
  await expect(blue.locator(".line-profile-status")).toContainText("Hover");
  await expect(blue.locator(".analysis-hist-title")).toHaveCSS("color", "rgb(14, 165, 233)");
  await color(page, "Orange"); await drag(page, 300, 610, 550, 640);
  await expect(profiles).toHaveCount(3);
  const orange = page.locator('.line-profile-panel[data-color="#ff9500"]');
  await expect(orange.locator(".line-profile-status")).toContainText("Hover");
  await orange.getByRole("button", { name: "Stack line profile plots", exact: true }).click();
  const group = page.getByRole("dialog", { name: "Line profile comparison", exact: true });
  await expect(group).toHaveAttribute("data-trace-count", "3");
  await expect(page.locator('.line-profile-panel:visible')).toHaveCount(0);
  expect(await group.locator(".plot-legend-entry svg line").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("stroke-dasharray")))).toEqual([null, null, null]);
  await expect(group.locator(".analysis-hist-title")).toHaveText("Line profile comparison");
  expect(await group.locator(".analysis-hist-title").evaluate((node) => node.style.color)).toBe("");
  await expect(group.locator('.plot-picker')).toHaveCount(0);
  await expect(group.getByRole("button", { name: /separately$/ })).toHaveCount(0);
  await group.getByRole("combobox", { name: "Distance axis" }).selectOption("relative");
  // Replacement while stacked retains three sources and the same chart.
  await color(page, "Red"); await drag(page, 650, 250, 780, 300);
  await expect(red.locator(".line-profile-status")).toContainText("Hover");
  await expect(group).toHaveAttribute("data-trace-count", "3");
  await expect(group.locator(".plot-legend-name").filter({ hasText: /^Line 1 / })).not.toContainText("changed");
  await page.screenshot({ path: testInfo.outputPath("stacked-solid-lines.png") });
  await group.getByRole("button", { name: "Split line profile plots", exact: true }).click();
  await expect(page.locator(".plot-comparison-panel")).toHaveCount(0);
  await expect(page.locator('.line-profile-panel:visible')).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath("split-color-profiles.png") });
  await blue.getByRole("button", { name: "Delete line", exact: true }).click();
  await expect(profiles).toHaveCount(2);
  await orange.getByRole("button", { name: "Stack line profile plots", exact: true }).click();
  await expect(group).toHaveAttribute("data-trace-count", "2");
  await group.getByRole("button", { name: "Close comparison chart", exact: true }).click();
  await expect(page.locator('.line-profile-panel:visible')).toHaveCount(0);
  await expect(page.locator('.plot-comparison-panel')).toHaveCount(0);
  await page.locator("#bandSelector").focus();
  await page.locator("#bandSelector").press("ArrowRight");
  await expect(page.locator('.plot-comparison-panel')).toHaveCount(0);
  await drag(page, 780, 300, 800, 320);
  await expect(red).toBeVisible();
  await red.getByRole("button", { name: "Stack line profile plots", exact: true }).click();
  await expect(group).toHaveAttribute("data-trace-count", "2");
  await page.locator("#toolEraser").click();
  await expect(page.locator(".plot-comparison-panel")).toHaveCount(0);
  await expect(profiles).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const [kind, bands] of [["histogram", 4], ["spectrum", 4], ["spectrum", 24]]) test(`${bands}-band ${kind} opens per-color windows and adds results to an existing stack`, async ({ page }, testInfo) => {
  await loadImage(page, bands);
  const title = kind === "histogram" ? "Spatial histogram" : "Spectrum";
  const plotName = title.toLowerCase();
  await drag(page, 300, 250, 500, 340);
  await color(page, "Blue");
  await drag(page, 300, 440, 500, 530);
  await page.getByRole("button", { name: title, exact: true }).click();
  const panels = page.locator(`.plot-comparison-panel[data-plot-kind="${kind}"]`);
  await expect(panels).toHaveCount(2);
  for (const panel of await panels.all()) {
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-trace-count", "1");
    await expect(panel.locator(".plot-legend-name")).not.toContainText(" + ");
  }
  await expect(panels.nth(0).locator(".analysis-hist-title")).toHaveCSS("color", "rgb(255, 45, 45)");
  await expect(panels.nth(1).locator(".analysis-hist-title")).toHaveCSS("color", "rgb(14, 165, 233)");
  const first = await panels.nth(0).boundingBox(), second = await panels.nth(1).boundingBox();
  expect(first.x !== second.x || first.y !== second.y).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`${bands}-${kind}-split-colors.png`) });

  await panels.last().getByRole("button", { name: `Stack ${plotName} plots`, exact: true }).click();
  await expect(panels).toHaveCount(1);
  await expect(panels).toHaveAttribute("data-trace-count", "2");
  await expect(panels.locator('.plot-legend-entry[data-selected="true"]')).toContainText("Region 1");
  await expect(panels.locator(`.plot-legend-entry[data-selected="true"] svg ${kind === "histogram" || bands <= 20 ? "rect" : "line"}`)).toHaveAttribute(kind === "histogram" || bands <= 20 ? "fill" : "stroke", "#0ea5e9");
  if (bands > 20) {
    // The four-band cases cover the full lifecycle. Keep the continuous-line
    // case focused so its many band reads stay well within WebKit's timeout.
    await page.screenshot({ path: testInfo.outputPath(`${bands}-${kind}-stacked-colors.png`) });
    await panels.getByRole("button", { name: `Split ${plotName} plots`, exact: true }).click();
    await expect(panels).toHaveCount(2);
    await expect(panels.nth(0)).toHaveAttribute("data-trace-count", "1");
    await expect(panels.nth(1)).toHaveAttribute("data-trace-count", "1");
    await page.getByRole("button", { name: "Close dataset", exact: true }).click();
    await expect(panels).toHaveCount(0);
    return;
  }
  if (kind === "histogram") await panels.getByRole("combobox", { name: "Histogram scale" }).selectOption("percentage");
  await color(page, "Orange");
  await drag(page, 850, 630, 980, 710);
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(panels).toHaveCount(1);
  await expect(panels).toHaveAttribute("data-trace-count", "3");
  await expect(panels.locator('.plot-legend-entry[data-selected="true"]')).toContainText("Region 1");
  await expect(panels.locator(`.plot-legend-entry[data-selected="true"] svg ${kind === "histogram" || bands <= 20 ? "rect" : "line"}`)).toHaveAttribute(kind === "histogram" || bands <= 20 ? "fill" : "stroke", "#ff9500");
  await page.screenshot({ path: testInfo.outputPath(`${bands}-${kind}-stacked-colors.png`) });

  await color(page, "Red");
  await drag(page, 850, 480, 980, 560);
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(panels).toHaveAttribute("data-trace-count", "3");
  await expect(panels.locator('.plot-legend-entry[data-selected="true"]')).toContainText("Region 2");
  await page.locator("#btnToolAreaMode").click();
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(panels.locator('.plot-legend-entry[data-selected="true"]')).toContainText("Region 1 + 2");
  await expect(panels).toHaveAttribute("data-trace-count", "3");

  await panels.getByRole("button", { name: `Split ${plotName} plots`, exact: true }).click();
  await expect(panels).toHaveCount(3);
  await expect(page.locator('.plot-comparison-panel[data-trace-count="1"]')).toHaveCount(3);
  await panels.last().getByRole("button", { name: `Stack ${plotName} plots`, exact: true }).click();
  await expect(panels).toHaveCount(1);
  await panels.getByRole("button", { name: "Close comparison chart", exact: true }).click();
  await expect(panels).toHaveCount(0);
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(panels).toHaveCount(3);
  await page.getByRole("button", { name: "Close dataset", exact: true }).click();
  await expect(panels).toHaveCount(0);
});

for (const kind of ["histogram", "spectrum"]) test(`a single ${kind} stack accepts new colors and replaces recalculated colors`, async ({ page }) => {
  await loadImage(page);
  const title = kind === "histogram" ? "Spatial histogram" : "Spectrum";
  const plotName = title.toLowerCase();
  await drag(page, 300, 250, 500, 340);
  await page.getByRole("button", { name: title, exact: true }).click();
  if (kind === "histogram") await expect(page.locator("#analysisStatN")).not.toHaveText("—");
  else await expect(page.locator("#specFoot")).toContainText("Mean");
  await page.locator(kind === "histogram" ? "#analysisHistPanel" : "#specPanel").getByRole("button", { name: `Stack ${plotName} plots`, exact: true }).click();
  const panels = page.locator(`.plot-comparison-panel[data-plot-kind="${kind}"]`);
  await expect(panels).toHaveAttribute("data-trace-count", "1");
  await color(page, "Blue");
  await drag(page, 300, 440, 500, 530);
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(panels).toHaveCount(1);
  await expect(panels).toHaveAttribute("data-trace-count", "2");
  await color(page, "Red");
  await drag(page, 850, 630, 980, 710);
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(panels).toHaveAttribute("data-trace-count", "2");
  await expect(panels.locator('.plot-legend-entry[data-selected="true"]')).toContainText("Region 2");
  await expect(panels.locator(".plot-legend-name").filter({ hasText: "Region 1" })).toHaveCount(1);
});

for (const kind of ["histogram", "spectrum"]) test(`drawing another color retains the first ${kind} before recalculation`, async ({ page }, testInfo) => {
  await loadImage(page);
  const title = kind === "histogram" ? "Spatial histogram" : "Spectrum";
  await drag(page, 300, 250, 500, 340);
  await page.getByRole("button", { name: title, exact: true }).click();
  if (kind === "histogram") await expect(page.locator("#analysisStatN")).not.toHaveText("—");
  else await expect(page.locator("#specFoot")).toContainText("Mean");
  await expect(page.locator(kind === "histogram" ? "#analysisHistPanel" : "#specPanel")).toBeVisible();
  await color(page, "Blue");
  await drag(page, 300, 440, 500, 530);
  const panels = page.locator(`.plot-comparison-panel[data-plot-kind="${kind}"]`);
  await expect(panels).toHaveCount(1);
  await expect(panels).toBeVisible();
  await expect(panels.locator(".plot-legend-name")).toContainText("Region 1");
  await expect(panels).toHaveAttribute("data-trace-count", "1");
  await page.screenshot({ path: testInfo.outputPath(`first-${kind}-retained.png`) });
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(panels).toHaveCount(2);
  await expect(panels.nth(0).locator(".plot-legend-name")).toContainText("Region 1");
  await expect(panels.nth(1).locator(".plot-legend-name")).toContainText("Region 1");
});

test("point spectra retain earlier colors in split windows and can stack", async ({ page }) => {
  await loadImage(page);
  await page.mouse.click(300, 250);
  await page.getByRole("button", { name: "Spectrum", exact: true }).click();
  await expect(page.locator("#specFoot")).toContainText("Mean");
  await color(page, "Blue");
  await page.mouse.click(300, 440);
  const panels = page.locator('.plot-comparison-panel[data-plot-kind="spectrum"]');
  await expect(panels).toHaveCount(1);
  await expect(panels).toBeVisible();
  await expect(panels.locator(".plot-legend-name")).toContainText("Point (");
  await page.getByRole("button", { name: "Spectrum", exact: true }).click();
  await expect(panels).toHaveCount(2);
  await expect(panels.nth(0).locator(".analysis-hist-title")).toHaveCSS("color", "rgb(255, 45, 45)");
  await expect(panels.nth(1).locator(".analysis-hist-title")).toHaveCSS("color", "rgb(14, 165, 233)");
  await panels.last().getByRole("button", { name: "Stack spectrum plots", exact: true }).click();
  await expect(panels).toHaveCount(1);
  await expect(panels).toHaveAttribute("data-trace-count", "2");
  await panels.getByRole("button", { name: "Split spectrum plots", exact: true }).click();
  await expect(panels).toHaveCount(2);
});

for (const [kind, grouped] of [["histogram", false], ["spectrum", false], ["histogram", true], ["spectrum", true]]) test(`moving a region refreshes its stacked ${grouped ? "grouped " : ""}${kind} on release`, async ({ page }, testInfo) => {
  await loadImage(page);
  const title = kind === "histogram" ? "Spatial histogram" : "Spectrum";
  await drag(page, 300, 250, 500, 340);
  if (grouped) {
    await drag(page, 650, 180, 800, 260);
    await page.locator("#btnToolAreaMode").click();
  }
  await color(page, "Blue");
  await drag(page, 300, 440, 500, 530);
  await page.getByRole("button", { name: title, exact: true }).click();
  const panels = page.locator(`.plot-comparison-panel[data-plot-kind="${kind}"]`);
  await expect(panels).toHaveCount(2);
  await panels.last().getByRole("button", { name: `Stack ${title.toLowerCase()} plots`, exact: true }).click();
  await expect(panels).toHaveCount(1);
  if (grouped) await expect(panels.locator(".plot-legend-entry").first()).toContainText("Region 1 + 2");
  await page.mouse.click(330, 280);
  await expect(panels.locator('.plot-legend-entry[data-selected="true"] svg rect')).toHaveAttribute("fill", "#ff2d2d");
  const before = await panels.locator("canvas").evaluate(canvas => canvas.toDataURL());
  await page.mouse.move(330, 280); await page.mouse.down();
  await page.mouse.move(370, 300, { steps: 8 });
  await expect(panels.locator(".plot-legend-entry").first()).toContainText("changed; recalculate");
  await page.mouse.up();
  await expect(panels.locator(".plot-legend-entry").first()).not.toContainText("changed; recalculate");
  await expect(panels).toHaveAttribute("data-trace-count", "2");
  await expect(panels.getByRole("button", { name: `Split ${title.toLowerCase()} plots`, exact: true })).toBeVisible();
  await expect.poll(() => panels.locator("canvas").evaluate(canvas => canvas.toDataURL())).not.toBe(before);
  if (grouped) await expect(panels.locator(".plot-legend-entry").first()).toContainText("Region 1 + 2");
  await page.screenshot({ path: testInfo.outputPath(`moved-region-${grouped ? "grouped-" : ""}${kind}.png`) });
});
