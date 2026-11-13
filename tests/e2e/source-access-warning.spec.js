import { test, expect } from "@playwright/test";

test("real worker detects only successfully completed slow foreground reads", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createFmapRangeDataSource } = await import("/src/io/fmap/index.js");
    const wasmBytes = await (await fetch("/wasm/fmap/pkg/fmap_core.wasm")).arrayBuffer();
    const workerUrl = URL.createObjectURL(new Blob([`
      import ${JSON.stringify(`${location.origin}/src/io/fmap/fmap.worker.js`)};
      const native = Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer = async function () {
        const result = await native.call(this);
        if (this.size >= 32768 && this.size <= 262144) await new Promise(resolve => setTimeout(resolve, 35));
        return result;
      };
    `], { type: "text/javascript" }));
    const bytes = new Uint8Array(4 * 1024 * 1024).fill(17);
    const create = () => createFmapRangeDataSource(new File([bytes], "slow.bin"), {
      wasmBytes, pageSize: 65536, poolBytes: bytes.length, concurrency: 2,
      maxResultBytes: bytes.length, maxInflightBytes: 8 * 1024 * 1024,
      maxQueuedBytes: 8 * 1024 * 1024, workerFactory: () => new Worker(workerUrl, { type: "module" })
    });
    const foreground = create(), background = create(), canceled = create();
    try {
      await Promise.all([foreground.ready, background.ready, canceled.ready]);
      const output = await foreground.readRange(0, 40 * 65536);
      if (output.length !== 40 * 65536 || output[0] !== 17 || output.at(-1) !== 17) throw new Error("Changed source values");
      const slow = await foreground.getStats();
      await foreground.readRange(0, 40 * 65536);
      const warm = await foreground.getStats();
      foreground.clear();
      const cleared = await foreground.getStats();
      await background.readRange(0, 40 * 65536, null, { priority: "background", maxAgeMs: Infinity });
      const bg = await background.getStats();
      const controller = new AbortController();
      const pending = canceled.readRange(0, 40 * 65536, null, { signal: controller.signal }).then(() => "success", (error) => error.name);
      setTimeout(() => controller.abort(), 200);
      const canceledResult = await pending;
      const afterCancel = await canceled.getStats();
      return { slow, warm, cleared, bg, canceledResult, afterCancel };
    } finally {
      foreground.close(); background.close(); canceled.close(); URL.revokeObjectURL(workerUrl);
    }
  });
  expect(result.slow.sourceReadWarning).toBe(1);
  expect(result.slow.sourceReadQualifiedSamples).toBe(40);
  expect(result.slow.sourceReadSlowWindows).toBe(2);
  expect(result.slow.sourceReadWaitMs).toBeGreaterThan(1000);
  expect(result.warm.readCalls).toBe(result.slow.readCalls);
  expect(result.cleared.sourceReadWarning).toBe(1);
  expect(result.cleared.sourceReadQualifiedSamples).toBe(0);
  expect(result.bg.sourceReadWarning).toBe(0);
  expect(result.bg.sourceReadQualifiedSamples).toBe(0);
  expect(result.canceledResult).toBe("AbortError");
  expect(result.afterCancel.sourceReadWarning).toBe(0);
});

test("delivered diagnostics show a nonblocking dismissible warning per file", async ({ page }, testInfo) => {
  // Test UI wiring independently from the timed-worker test above. Deliver a
  // detected warning through the real worker response rather than altering app state.
  await page.addInitScript(() => {
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", ({ data }) => {
          const stats = data.result?.stats;
          if (stats && "sourceReadQualifiedSamples" in stats) {
            stats.sourceReadWarning = 1;
            stats.sourceReadQualifiedSamples = 40;
            stats.sourceReadMedianMs = 6;
            stats.sourceReadSlowWindows = 2;
            stats.sourceReadWaitMs = 1200;
            stats.sourceReadWarningRequestId = data.id;
            stats.sourceReadWarningEpoch = 0;
            stats.sourceReadWarningMedianMs = 6;
            stats.sourceReadWarningWaitMs = 1200;
          }
        });
      }
    };
  });
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  const warning = page.locator("#sourceAccessWarning");
  await expect(warning).toBeHidden();
  const load = async (name) => page.locator("#filePicker").setInputFiles([
    { name: `${name}.hdr`, mimeType: "text/plain", buffer: Buffer.from("ENVI\nsamples = 100\nlines = 80\nbands = 1\ndata type = 4\ninterleave = bsq\nbyte order = 0\n") },
    { name: `${name}.dat`, mimeType: "application/octet-stream", buffer: Buffer.alloc(32000) }
  ]);
  await load("first");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("first");
  await expect(page.locator("#metaSourceAccess")).toContainText("40 distinct small reads");
  await expect(page.locator("#metaSourceAccess")).toContainText("6.0 ms median");
  await expect(warning).not.toContainText("HDD");
  await page.screenshot({ path: testInfo.outputPath("source-access-warning.png") });
  await warning.getByRole("button", { name: "Dismiss slow file access warning" }).click();
  await page.mouse.move(500, 300); await page.mouse.wheel(0, -200);
  await expect(warning).toBeHidden();
  await load("second");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("second");
  await page.setViewportSize({ width: 390, height: 640 });
  const box = await warning.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await warning.getByRole("button", { name: "Dismiss slow file access warning" }).click();
  await expect(warning).toBeHidden();
});
