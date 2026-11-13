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

for (const kind of ["spectrum", "histogram"]) {
  test(`${kind} follows selection in one stable panel and emphasizes the selected stacked result`, async ({ page }, testInfo) => {
    await loadImage(page);
    const original = page.locator(kind === "spectrum" ? "#specPanel" : "#analysisHistPanel");
    for (let i = 0; i < 2; i++) {
      if (i) {
        if (kind === "spectrum") await original.getByRole("button", { name: "Close spectrum", exact: true }).click();
        await color(page, "Blue");
      }
      await drag(page, 300, 250 + i * 190, 500, 340 + i * 190);
      await page.getByRole("button", { name: kind === "spectrum" ? "Spectrum" : "Spatial histogram", exact: true }).click();
      if (kind === "spectrum") await expect(page.locator("#specFoot")).toContainText("Mean");
      else await expect(page.locator("#analysisStatN")).not.toHaveText("—");
    }
    const name = kind === "spectrum" ? "spectrum" : "spatial histogram";
    const initial = page.locator(`.plot-comparison-panel[data-plot-kind="${kind}"]`);
    await expect(initial).toHaveCount(1);
    await expect(initial).toHaveAttribute("data-trace-count", "1");
    await expect(initial.locator(".plot-legend-name")).toContainText("Region 2");
    await initial.evaluate(node => { window.__retainedAnalysisPanel = node; });
    await expect(initial.getByRole("button", { name: `Stack ${name} plots`, exact: true })).toHaveText("Stack");
    await initial.getByRole("button", { name: `Stack ${name} plots`, exact: true }).click();
    const together = page.locator('.plot-comparison-panel[data-trace-count="2"]');
    await expect(together).toBeVisible();
    if (kind === "histogram") {
      await expect(together.locator(".plot-legend-entry svg rect")).toHaveCount(2);
      await expect(together.locator('.plot-legend-entry[data-selected="false"] svg rect')).toHaveAttribute("fill-opacity", "0.4");
      await expect(together.locator('.plot-legend-entry[data-selected="true"] svg rect')).toHaveAttribute("fill-opacity", "1");
      await together.getByRole("combobox", { name: "Histogram scale" }).selectOption("percentage");
    }
    const selectedMark = kind === "histogram" ? "rect" : "line";
    const opacityAttr = kind === "histogram" ? "fill-opacity" : "stroke-opacity";
    // Changing image selection reuses calculated arrays and the same panel.
    await page.mouse.click(330, 280);
    await expect(together.locator('.plot-legend-entry[data-selected="true"]')).toContainText("Region 1");
    await expect(together.locator(`.plot-legend-entry[data-selected="true"] svg ${selectedMark}`)).toHaveAttribute(opacityAttr, "1");
    await expect(together.locator(`.plot-legend-entry[data-selected="false"] svg ${selectedMark}`)).toHaveAttribute(opacityAttr, "0.4");
    await page.screenshot({ path: testInfo.outputPath(`${kind}-stacked.png`) });
    await together.getByRole("button", { name: `Split ${name} plots`, exact: true }).click();
    await expect(page.locator('.plot-comparison-panel[data-trace-count="1"]')).toHaveCount(1);
    await expect(page.locator('.plot-picker')).toHaveCount(0);
    const singles = page.locator('.plot-comparison-panel[data-trace-count="1"]');
    await expect(singles.first().locator(".analysis-hist-title")).toHaveCSS("color", "rgb(255, 45, 45)");
    expect(await singles.evaluate(node => node === window.__retainedAnalysisPanel)).toBe(true);
    await page.mouse.click(330, 480);
    await expect(singles.locator(".plot-legend-name")).toContainText("Region 2");
    await drag(page, 180, 620, 280, 700);
    await expect(initial).toHaveAttribute("data-trace-count", "0");
    await expect(initial.locator(".plot-legend-entry")).toHaveCount(0);
    await initial.getByRole("button", { name: `Stack ${name} plots`, exact: true }).click();
    await expect(together.locator('.plot-legend-entry[data-selected="true"]')).toHaveCount(0);
    await expect(together.locator('.plot-legend-entry[data-selected="false"]')).toHaveCount(2);
    await together.getByRole("button", { name: `Split ${name} plots`, exact: true }).click();
    await page.mouse.click(330, 480);
    await expect(singles.locator(".plot-legend-name")).toContainText("Region 2");
    await singles.last().getByRole("button", { name: `Stack ${name} plots`, exact: true }).click();
    await expect(together).toBeVisible();
    // Explicit recalculation also stays in the shared panel.
    await page.getByRole("button", { name: kind === "spectrum" ? "Spectrum" : "Spatial histogram", exact: true }).click();
    await expect(initial).toHaveAttribute("data-trace-count", "2");
    await expect(initial.locator('.plot-legend-entry[data-selected="true"]')).toContainText("Region 2");
    await expect(original).toBeHidden();
    expect(await initial.evaluate(node => node === window.__retainedAnalysisPanel)).toBe(true);
    await page.getByRole("button", { name: "Close dataset", exact: true }).click();
    await expect(page.locator(".plot-comparison-panel")).toHaveCount(0);
  });
}
