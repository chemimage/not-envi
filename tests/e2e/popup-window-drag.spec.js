import { test, expect } from "@playwright/test";

test("popup header drag preserves charts and follows the pointer", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  const data = new Float32Array(100 * 80 * 2);
  for (let i = 0; i < data.length; i++) data[i] = i % 100;
  await page.locator("#filePicker").setInputFiles([
    { name: "popup.hdr", mimeType: "text/plain", buffer: Buffer.from("ENVI\nsamples = 100\nlines = 80\nbands = 2\ndata type = 4\ninterleave = bsq\nbyte order = 0\n") },
    { name: "popup.raw", mimeType: "application/octet-stream", buffer: Buffer.from(data.buffer) }
  ]);
  await expect(page.locator("#displayDock")).toBeVisible();
  await page.mouse.move(400, 290);
  await page.mouse.down();
  await page.mouse.move(620, 440, { steps: 8 });
  await page.mouse.up();
  await page.locator("#btnToolSpectral").click();
  await expect(page.locator("#specFoot")).toContainText("Mean");
  await page.locator("#btnToolHistogram").click();
  await expect(page.locator("#btnToolHistogram")).toBeEnabled();
  const panel = page.locator("#specPanel");
  const before = await panel.boundingBox();
  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");
  const metricsBefore = await session.send("Performance.getMetrics");
  await page.evaluate(() => {
    window.popupMetrics = { boundsReads: 0, paints: {}, workerMessages: 0 };
    const bounds = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (...args) {
      if (this.id === "main" || this.classList.contains("floating-window")) window.popupMetrics.boundsReads++;
      return bounds.apply(this, args);
    };
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      const id = this.canvas.id;
      window.popupMetrics.paints[id] = (window.popupMetrics.paints[id] || 0) + 1;
      return clear.apply(this, args);
    };
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (...args) {
      window.popupMetrics.workerMessages++;
      return post.apply(this, args);
    };
  });
  await page.mouse.move(before.x + 100, before.y + 20);
  await page.mouse.down();
  await page.mouse.move(before.x - 100, before.y + 70, { steps: 60 });
  await page.mouse.up();
  await expect(panel).toHaveAttribute("data-floating-user-placed", "true");
  const after = await panel.boundingBox();
  expect(after.x).toBeCloseTo(before.x - 200, 0);
  expect(after.y).toBeCloseTo(before.y + 50, 0);
  expect(after.width).toBe(before.width);
  expect(after.height).toBe(before.height);
  const measured = await page.evaluate(() => window.popupMetrics);
  const metricsAfter = await session.send("Performance.getMetrics");
  const delta = Object.fromEntries(metricsAfter.metrics.filter((metric) => ["LayoutCount", "RecalcStyleCount", "TaskDuration"].includes(metric.name))
    .map((metric) => [metric.name, metric.value - metricsBefore.metrics.find((entry) => entry.name === metric.name).value]));
  console.log(JSON.stringify({ ...measured, ...delta }));
  await testInfo.attach("popup-drag-metrics", { body: JSON.stringify({ ...measured, ...delta }), contentType: "application/json" });
  expect(measured.paints.specCanvas || 0).toBe(0);
  expect(measured.paints.analysisHistCanvas || 0).toBe(0);
  await expect(page.locator("#analysisHistPanel")).toBeVisible();
  const histogram = page.locator("#analysisHistPanel");
  const histogramBefore = await histogram.boundingBox();
  await page.mouse.move(histogramBefore.x + 250, histogramBefore.y + 20);
  await page.mouse.down();
  await page.mouse.move(histogramBefore.x + 100, histogramBefore.y + 50, { steps: 30 });
  await page.mouse.up();
  const histogramAfter = await histogram.boundingBox();
  expect(histogramAfter.x).toBeCloseTo(histogramBefore.x - 150, 0);
  expect(histogramAfter.y).toBeCloseTo(histogramBefore.y + 30, 0);
  expect(histogramAfter.width).toBe(histogramBefore.width);
  expect(histogramAfter.height).toBe(histogramBefore.height);
  await expect(panel).toBeVisible();
});
