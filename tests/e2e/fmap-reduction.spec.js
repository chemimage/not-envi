import { test, expect } from "@playwright/test";

test("background moments resume after foreground preemption without double counting", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createFmapDataSource } = await import("/src/io/fmap/index.js");
    const wasmBytes = await (await fetch("/wasm/fmap/pkg/fmap_core.wasm")).arrayBuffer();
    const meta = { samples: 128, lines: 128, bands: 1, headerOffset: 0, interleave: "bsq",
      dataType: 4, littleEndian: true, dataTypeInfo: { bytes: 4, ctor: Float32Array } };
    const source = createFmapDataSource(new File([new Float32Array(16384).fill(7)], "preemption.f32"), meta, {
      wasmBytes, pageSize: 4096, poolBytes: 8192, concurrency: 1
    });
    try {
      await source.ready;
      let attempts = 0, cancellations = 0, foreground;
      const send = source.worker.postMessage.bind(source.worker);
      source.worker.postMessage = (message, ...args) => {
        if (message.type === "cancel") cancellations++;
        if (message.type === "reduce" && ++attempts === 1) {
          queueMicrotask(() => { foreground = source.readBandWindow(meta, 0, 0, 0, 1, 1, 1); });
        }
        return send(message, ...args);
      };
      const moments = await source.reduceStatisticsWindow(meta, 0, 0, 0, 128, 128, 1, { priority: "background" });
      await foreground;
      const stats = await source.getStats();
      return { attempts, cancellations, count: moments.count, sum: moments.sum, logical: stats.logicalBytesReserved };
    } finally { source.close(); }
  });
  expect(result.attempts).toBeGreaterThanOrEqual(2);
  expect(result.cancellations).toBeGreaterThanOrEqual(1);
  expect(result.count).toBe(16384);
  expect(result.sum).toBe(16384 * 7);
  expect(result.logical).toBe(0);
});

test("streamed Float32 moments and histograms use real WASM batches with compact transport", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createFmapDataSource } = await import("/src/io/fmap/index.js");
    const { createAnalysisPlan, analysisBudget } = await import("/src/core/analysis-batches.js");
    const { streamStatistics } = await import("/src/core/stream-statistics.js");
    const { computeHistogram } = await import("/src/render/display-math.js");
    const wasmBytes = await (await fetch("/wasm/fmap/pkg/fmap_core.wasm")).arrayBuffer();
    const meta = { samples: 200, lines: 200, bands: 1, headerOffset: 0, interleave: "bsq",
      dataType: 4, littleEndian: true, dataTypeInfo: { bytes: 4, ctor: Float32Array } };
    const data = Float32Array.from({ length: 40000 }, (_, i) => i % 47 ? (i % 251) / 3 : NaN);
    const source = createFmapDataSource(new File([data], "statistics.f32"), meta, {
      wasmBytes, pageSize: 4096, poolBytes: 32768
    });
    try {
      await source.ready;
      const ds = { meta, ds: source };
      const plan = createAnalysisPlan([{ bounds: { x0: 0, y0: 0 }, outW: 200, outH: 200 }], 1);
      const readWindow = () => { throw new Error("Unexpected raster materialization"); };
      const phases = [];
      const moments = await streamStatistics({ ds, band: 0, plan, readWindow });
      const histogram = await streamStatistics({ ds, band: 0, plan, readWindow, histogram: true,
        onProgress: (p) => phases.push(p) });
      const reference = computeHistogram(data);
      if (histogram.bins.some((n, i) => n !== reference.bins[i])) throw new Error("Histogram mismatch");
      if (moments.count !== reference.count || Math.abs(moments.sum / moments.count - reference.mean) > 1e-8) throw new Error("Moment mismatch");
      const stats = await source.getStats();
      return { count: moments.count, batchCount: plan.batchCount,
        last: phases.at(-1), phases: [...new Set(phases.map((p) => p.phase))],
        activeBytes: analysisBudget.stats().activeBytes, logicalBytes: stats.logicalBytesReserved };
    } finally { source.close(); }
  });
  expect(result.count).toBeGreaterThan(39000);
  expect(result.batchCount).toBeGreaterThan(1);
  expect(result.last.completed).toBe(result.last.total);
  expect(result.phases).toEqual(["range", "histogram"]);
  expect(result.activeBytes).toBe(0);
  expect(result.logicalBytes).toBe(0);
});

test("leased-span reductions match ordinary analysis across numeric types, layouts, masks and sampling", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { checkReductions } = await import("/tests/fixtures/fmap-reduction-workload.js");
    const wasm = await (await fetch("/wasm/fmap/pkg/fmap_core.wasm")).arrayBuffer();
    return checkReductions(wasm);
  });
  expect(result.cases).toBe(54);
});

test("reductions reject cancellation, clear, unmap and close without leaking reservations", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createFmapDataSource } = await import("/src/io/fmap/index.js");
    const wasmBytes = await (await fetch("/wasm/fmap/pkg/fmap_core.wasm")).arrayBuffer();
    const meta = { samples: 1024, lines: 1024, bands: 1, headerOffset: 0,
      interleave: "bsq", dataType: 4, littleEndian: true, dataTypeInfo: { bytes: 4, ctor: Float32Array } };
    const file = new File([new Float32Array(1024 * 1024).fill(7)], "cancel.f32");
    const names = [];
    for (const action of ["abort", "clear", "unmap", "close"]) {
      const source = createFmapDataSource(file, meta, { wasmBytes, pageSize: 4096, poolBytes: 8192, batchBytes: 128 });
      try {
        await source.ready;
        const controller = new AbortController();
        const pending = source.reduceBandWindow(meta, 0, 0, 0, 1024, 1024, 1, { signal: controller.signal });
        const outcome = pending.then(() => "unexpected success", error => error.name);
        await Promise.resolve();
        if (action === "abort") controller.abort();
        else if (action === "unmap") await source.mapping.release();
        else source[action]();
        names.push(await outcome);
        if (source.stats.logicalBytesReserved) throw new Error("Leaked logical reduction reservation");
        if (!source.closed) {
          const deadline = performance.now() + 2000;
          for (;;) {
            const stats = await source.getStats();
            if (!stats.activeRequests && !stats.fillActiveReads && !stats.pinnedBytes) break;
            if (performance.now() > deadline) throw new Error("Reduction work did not drain");
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
      } finally { source.close(); }
    }
    return names;
  });
  expect(result).toEqual(["AbortError", "AbortError", "AbortError", "AbortError"]);
});
