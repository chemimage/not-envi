import { test, expect } from "@playwright/test";

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
