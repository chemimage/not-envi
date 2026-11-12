import { test, expect } from "@playwright/test";

test("profile region movement while spectrum is open", async ({ page }, testInfo) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.dragWorkerProbe = { pending: 0, lastActivity: 0 };
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.pendingIds = new Set();
        this.addEventListener("message", ({ data }) => {
          if (this.pendingIds.delete(data?.id)) window.dragWorkerProbe.pending -= 1;
          window.dragWorkerProbe.lastActivity = performance.now();
        });
      }
      postMessage(message, ...args) {
        if (Number.isSafeInteger(message?.id) && !this.pendingIds.has(message.id)) {
          this.pendingIds.add(message.id); window.dragWorkerProbe.pending += 1;
        }
        window.dragWorkerProbe.lastActivity = performance.now();
        return super.postMessage(message, ...args);
      }
      terminate() {
        window.dragWorkerProbe.pending -= this.pendingIds.size; this.pendingIds.clear();
        return super.terminate();
      }
    };
  });
  await page.route("**/src/app/runtime.js*", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const index = body.lastIndexOf("})();");
    await route.fulfill({ response, body: `${body.slice(0, index)}window.dragDataset = () => getActive();\n${body.slice(index)}` });
  });
  await page.goto("/");
  const side = 512, bands = 32;
  const values = new Float32Array(side * side * bands);
  for (let i = 0; i < values.length; i++) values[i] = i % 251;
  await page.locator("#filePicker").setInputFiles([
    { name: "drag.hdr", mimeType: "text/plain", buffer: Buffer.from(`ENVI\nsamples = ${side}\nlines = ${side}\nbands = ${bands}\ndata type = 4\ninterleave = bsq\nbyte order = 0\n`) },
    { name: "drag.raw", mimeType: "application/octet-stream", buffer: Buffer.from(values.buffer) }
  ]);
  await expect(page.locator("#displayDock")).toBeVisible();
  await page.mouse.move(350, 200);
  await page.mouse.down();
  await page.mouse.move(600, 500, { steps: 10 });
  await page.mouse.up();
  await page.locator("#btnToolSpectral").click();
  await expect(page.locator("#specFoot")).toContainText("Mean", { timeout: 30000 });
  // Analysis completion does not imply that the initial display workers have
  // drained. Measure drag work only after file/tile queues and worker replies
  // settle; retain the zero-worker-message assertion throughout the drag.
  await page.waitForFunction(() => {
    const pyr = window.dragDataset()?.pyramid;
    return pyr && !pyr.qHi.length && !pyr.qLo.length && !pyr.inflight.size
      && !pyr.pending.size && window.dragWorkerProbe.pending === 0
      && performance.now() - window.dragWorkerProbe.lastActivity > 200;
  });
  const session = await page.context().newCDPSession(page);
  await session.send("Profiler.enable");
  await session.send("Profiler.setSamplingInterval", { interval: 500 });
  await page.evaluate(() => {
    window.dragMetrics = { clears: 0, imagePaints: 0, messages: 0 };
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.id === "overlayCanvas") window.dragMetrics.clears++;
      if (this.canvas.id === "cpuCanvas") window.dragMetrics.imagePaints++;
      return clear.apply(this, args);
    };
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (...args) {
      window.dragMetrics.messages++;
      return post.apply(this, args);
    };
  });
  await page.mouse.move(400, 300);
  await page.mouse.down();
  await session.send("Profiler.start");
  const start = Date.now();
  await page.mouse.move(500, 350, { steps: 60 });
  const metrics = await page.evaluate(() => window.dragMetrics);
  const { profile } = await session.send("Profiler.stop");
  await page.mouse.up();
  const functions = new Map();
  for (const node of profile.nodes) {
    const name = node.callFrame.functionName || node.callFrame.url;
    functions.set(name, (functions.get(name) || 0) + (node.hitCount || 0));
  }
  const result = { elapsedMs: Date.now() - start, ...metrics,
    samples: [...functions].sort((a, b) => b[1] - a[1]).slice(0, 18) };
  console.log(JSON.stringify(result));
  await testInfo.attach("drag-profile", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
  expect(metrics.messages).toBe(0);
  await expect(page.locator("#specPanel")).toBeVisible();
});
