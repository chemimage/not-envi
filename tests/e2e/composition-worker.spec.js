import { expect, test } from "@playwright/test";

test("SIMD math matches JS independently of worker canvas availability", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const bytes = await (await fetch("/wasm/rgb/pkg/rgb.wasm")).arrayBuffer();
    if (!WebAssembly.validate(bytes)) return { supported: false };
    const { createRgbSimdKernel } = await import("/src/render/rgb-simd.js");
    const { tone01 } = await import("/src/render/display-math.js");
    const kernel = await createRgbSimdKernel(bytes), w = 16391, h = 3;
    const rasters = [0, 1, 2].map(c => ({ dataF32: Float32Array.from({ length: w * h }, (_, i) => i % 997 === 0 ? NaN : (i * 17 + c * 61) % 4096 / 16) }));
    const params = [0, 1, 2].map(() => ({ minVal: 4, maxVal: 230, brightness: 0.03, gain: 1.1, contrast: 0.9 }));
    const output = new Uint8ClampedArray(w * h * 4);
    kernel.colorize(rasters, params, output, w, { x: 0, y: 0, w, h }, true);
    for (let i = 0; i < w * h; i++) {
      if (rasters.some(r => !Number.isFinite(r.dataF32[i]))) {
        if (output.subarray(i * 4, i * 4 + 4).some(v => v !== 0)) return { supported: true, parity: false };
      } else {
        for (let c = 0; c < 3; c++) {
          const p = params[c], expected = Math.round(tone01(rasters[c].dataF32[i], p.minVal, p.maxVal, p.brightness, p.gain, p.contrast) * 255);
          if (output[i * 4 + c] !== expected) return { supported: true, parity: false };
        }
        if (output[i * 4 + 3] !== 255) return { supported: true, parity: false };
      }
    }
    return { supported: true, parity: true, bytes: kernel.stats.allocatedBytes };
  });
  test.skip(!result.supported, "SIMD is unsupported by this engine; loader fallback is covered separately.");
  expect(result).toEqual({ supported: true, parity: true, bytes: 384 * 1024 });
});

async function requireCompositionWorker(page) {
  await page.goto("/");
  const supported = await page.evaluate(() => typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function");
  test.skip(!supported, "This browser lacks the worker canvas API; synchronous fallback is tested separately.");
}

test("missing worker canvas APIs use the actual synchronous compositor", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    Object.defineProperty(globalThis, "OffscreenCanvas", { configurable: true, value: undefined });
    const { createCompositionWorkerClient } = await import("/src/render/composition-worker-client.js");
    const { createRgbCompositor } = await import("/src/render/rgb-composition.js");
    const { tone01 } = await import("/src/render/display-math.js");
    const compositor = createRgbCompositor({ tone01, createCanvas: () => document.createElement("canvas"), createImageData: (w, h) => new ImageData(w, h) });
    const client = createCompositionWorkerClient({ fallback: (...args) => compositor.compose(...args) });
    const rasters = [10, 90, 180].map(value => ({ w: 2, h: 2, dataF32: new Float32Array(4).fill(value) }));
    const params = [0, 1, 2].map(() => ({ minVal: 0, maxVal: 255, brightness: 0, gain: 1, contrast: 1 }));
    try {
      const canvas = await client.compose(rasters, params);
      return { pixel: [...canvas.getContext("2d").getImageData(0, 0, 1, 1).data], fallbackJobs: client.stats.fallbackJobs, worker: client.usingWorker() };
    } finally { client.dispose(); compositor.clear(); }
  });
  expect(result).toEqual({ pixel: [10, 90, 180, 255], fallbackJobs: 1, worker: false });
});

test("composition worker matches progressive frames, settings, order and transparency without detaching source planes", async ({ page }) => {
  await requireCompositionWorker(page);
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
  expect(report.stats.workerBackend).toBe("simd");
  expect(report.stats.workerKernelBytes).toBe(384 * 1024);
});

test("worker keeps matching JS output when the optional SIMD loader is unavailable", async ({ page }) => {
  let replaced = false;
  await page.route("**/src/render/rgb-simd-loader.js", route => {
    replaced = true;
    return route.fulfill({ contentType: "application/javascript", body: "export async function loadRgbSimdKernel() { return null; }" });
  });
  await requireCompositionWorker(page);
  const report = await page.evaluate(async () => {
    const { compositionWorkerWorkload } = await import("/tests/fixtures/composition-worker-workload.js");
    return compositionWorkerWorkload();
  });
  expect(replaced).toBe(true);
  expect(report.workerHashes).toEqual(report.referenceHashes);
  expect(report.stats.workerBackend).toBe("js");
  expect(report.stats.workerKernelBytes).toBe(0);
  expect(report.stats.fallbackJobs).toBe(0);
});

test("tone bursts reuse resident pixels after coalescing and retain fixed SIMD scratch", async ({ page }) => {
  await requireCompositionWorker(page);
  const result = await page.evaluate(async () => {
    const { createCompositionWorkerClient } = await import("/src/render/composition-worker-client.js");
    const client = createCompositionWorkerClient({ fallback: () => { throw new Error("Unexpected fallback"); } });
    const rasters = [0, 1, 2].map(c => ({ compositionId: c + 50, revision: 1, previousRevision: 0,
      w: 1024, h: 768, dataF32: new Float32Array(1024 * 768).fill(c * 90), dirtyRects: [{ x: 0, y: 0, w: 1024, h: 768 }] }));
    const params = [0, 1, 2].map(() => ({ minVal: 0, maxVal: 255, brightness: 0, gain: 1, contrast: 1 }));
    try {
      (await client.compose(rasters, params)).close();
      const before = client.stats.packedBytes;
      const jobs = [];
      for (let i = 0; i < 20; i++) {
        params.forEach(p => { p.brightness = i / 100; });
        jobs.push(client.compose(rasters, params).then(bitmap => ({ bitmap }), error => ({ error: error.name })));
      }
      const outcomes = await Promise.all(jobs), bitmap = outcomes.at(-1).bitmap;
      const canvas = document.createElement("canvas"); canvas.width = 1; canvas.height = 1;
      const ctx = canvas.getContext("2d"); ctx.drawImage(bitmap, 0, 0); bitmap.close();
      return { before, stats: { ...client.stats }, errors: outcomes.slice(0, -1).map(x => x.error), pixel: [...ctx.getImageData(0, 0, 1, 1).data] };
    } finally { client.dispose(); }
  });
  expect(result.errors).toEqual(Array(19).fill("AbortError"));
  expect(result.pixel).toEqual([48, 138, 228, 255]);
  expect(result.stats.packedBytes).toBe(result.before);
  expect(result.stats.workerKernelBytes).toBe(384 * 1024);
  expect(result.stats.fallbackJobs).toBe(0);
});

test("composition worker cancels active and queued requests and can restart after clear", async ({ page }) => {
  await requireCompositionWorker(page);
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
  await requireCompositionWorker(page);
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
