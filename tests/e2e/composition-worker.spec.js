import { expect, test } from "@playwright/test";

test("composition worker matches progressive frames, settings, order and transparency without detaching source planes", async ({ page }) => {
  await page.goto("/");
  const report = await page.evaluate(async () => {
    const { compositionWorkerWorkload } = await import("/tests/fixtures/composition-worker-workload.js");
    return compositionWorkerWorkload();
  });
  expect(report.frames).toBe(12);
  expect(report.workerHashes).toEqual(report.referenceHashes);
  expect(report.sourceBytes).toBe(512 * 384 * 3 * 4);
  expect(report.submitCpuMs).toBeGreaterThanOrEqual(0);
  expect(report.stats.fallbackJobs).toBe(0);
  expect(report.stats.workerPixelsColored).toBeGreaterThan(0);
});

test("composition worker cancels active and queued requests and can restart after clear", async ({ page }) => {
  await page.goto("/");
  const report = await page.evaluate(async () => {
    const { createCompositionWorkerClient } = await import("/src/render/composition-worker-client.js");
    const client = createCompositionWorkerClient({ fallback: () => { throw new Error("Unexpected synchronous fallback."); } });
    const rasters = [0, 1, 2].map((band) => ({ compositionId: band + 10, revision: 1, previousRevision: 0,
      w: 512, h: 512, dataF32: new Float32Array(512 * 512).fill(band * 90), dirtyRects: [{ x: 0, y: 0, w: 512, h: 512 }] }));
    const params = [0, 1, 2].map(() => ({ minVal: 0, maxVal: 255, brightness: 0, gain: 1, contrast: 1 }));
    const settle = (promise) => promise.then((bitmap) => { bitmap?.close?.(); return "fulfilled"; }, (error) => error.name);
    try {
      const active = new AbortController(), queued = new AbortController();
      const first = settle(client.compose(rasters, params, {}, { key: "first", signal: active.signal }));
      const second = settle(client.compose(rasters, params, {}, { key: "second", signal: queued.signal }));
      active.abort(); queued.abort();
      const outcomes = await Promise.all([first, second]);
      client.clear();
      const drawable = await client.compose(rasters, params, {}, { key: "fresh" });
      const shape = [drawable.width, drawable.height]; drawable?.close?.();
      return { outcomes, shape, usingWorker: client.usingWorker() };
    } finally { client.dispose(); }
  });
  expect(report.outcomes).toEqual(["AbortError", "AbortError"]);
  expect(report.shape).toEqual([512, 512]);
  expect(report.usingWorker).toBe(true);
});

test("composition worker keeps the latest queued view and snapshots mutable data and tone settings", async ({ page }) => {
  await page.goto("/");
  const report = await page.evaluate(async () => {
    const { createCompositionWorkerClient } = await import("/src/render/composition-worker-client.js");
    const client = createCompositionWorkerClient({ fallback: () => { throw new Error("Unexpected synchronous fallback."); } });
    const rasters = [0, 1, 2].map((band) => ({ compositionId: band + 20, revision: 1, previousRevision: 0,
      w: 512, h: 512, dataF32: new Float32Array(512 * 512).fill(band * 90), dirtyRects: [{ x: 0, y: 0, w: 512, h: 512 }] }));
    const params = [0, 1, 2].map(() => ({ minVal: 0, maxVal: 255, brightness: 0, gain: 1, contrast: 1 }));
    const settle = (promise) => promise.then((bitmap) => { bitmap?.close?.(); return "fulfilled"; }, (error) => error.name);
    try {
      const busy = settle(client.compose(rasters, params, {}, { key: "busy" }));
      const obsolete = settle(client.compose(rasters, params, {}, { key: "view" }));
      const latest = client.compose(rasters, params, {}, { key: "view" });
      rasters.forEach((raster) => raster.dataF32.fill(255));
      params.forEach((param) => { param.brightness = 1; });
      const drawable = await latest;
      const canvas = document.createElement("canvas"); canvas.width = 1; canvas.height = 1;
      const context = canvas.getContext("2d"); context.drawImage(drawable, 0, 0);
      const pixel = [...context.getImageData(0, 0, 1, 1).data]; drawable?.close?.();
      return { busy: await busy, obsolete: await obsolete, pixel, stats: { ...client.stats } };
    } finally { client.dispose(); }
  });
  expect(report.busy).toBe("fulfilled");
  expect(report.obsolete).toBe("AbortError");
  expect(report.pixel).toEqual([0, 90, 180, 255]);
  expect(report.stats.cancelled).toBeGreaterThanOrEqual(1);
  expect(report.stats.queuedBytes).toBe(0);
  expect(report.stats.fallbackJobs).toBe(0);
});
