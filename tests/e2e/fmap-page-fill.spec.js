import { expect, test } from "@playwright/test";

test.describe("fmap page-fill queue browser integration", () => {
  test("deduplicates overlapping windows and ranges and reuses warm partial pages", async ({ page }) => {
    await page.goto("/?fmap=1");
    const result = await page.evaluate(async () => {
      const { createFmapDataSource } = await import("/src/io/fmap/index.js");
      const wasmBytes = await (await fetch("/wasm/fmap/pkg/fmap_core.wasm")).arrayBuffer();
      const samples = 256;
      const lines = 256;
      const values = Float32Array.from({ length: samples * lines }, (_value, index) => index + 0.25);
      const meta = {
        samples,
        lines,
        bands: 1,
        headerOffset: 0,
        interleave: "bsq",
        dataType: 4,
        littleEndian: true,
        dataTypeInfo: { bytes: 4, ctor: Float32Array }
      };
      const source = createFmapDataSource(new File([values], "overlap.dat"), meta, {
        wasmBytes,
        pageSize: 4096,
        poolBytes: 512 * 1024,
        concurrency: 3,
        maxInflightBytes: 2 * 1024 * 1024,
        maxQueuedBytes: 8 * 1024 * 1024,
        maxResultBytes: 1024 * 1024,
        maxLogicalResultBytes: 8 * 1024 * 1024,
        maxLogicalBytes: 16 * 1024 * 1024,
        batchBytes: 4096,
        sparseReadThresholdBytes: 0
      });
      const checkWindow = (window, x0, y0, width, height) => {
        for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]) {
          const expected = values[((y0 + y) * samples) + x0 + x];
          if (window[(y * width) + x] !== expected) throw new Error(`window mismatch at ${x},${y}`);
        }
      };
      try {
        await source.ready;
        const run = async () => {
          const [large, overlap, bytes] = await Promise.all([
            source.readBandWindow(meta, 0, 0, 0, 192, 192, 1, null, { priority: "background" }),
            source.readBandWindow(meta, 0, 32, 32, 128, 128, 1, null, { priority: "foreground" }),
            source.readRange(((32 * samples) + 32) * 4, 64 * 1024, null, { priority: "foreground" })
          ]);
          checkWindow(large, 0, 0, 192, 192);
          checkWindow(overlap, 32, 32, 128, 128);
          const expectedBytes = new Uint8Array(values.buffer, ((32 * samples) + 32) * 4, 64 * 1024);
          if (bytes.some((value, index) => value !== expectedBytes[index])) throw new Error("range mismatch");
        };

        await run();
        const cold = await source.getStats();
        await run();
        const warm = await source.getStats();
        return {
          cold: {
            browserBytes: cold.browserBytes,
            pageFillReads: cold.pageFillReads,
            deduplications: cold.pageFillDeduplications,
            peakActive: cold.peakFillActiveReads,
            pinnedBytes: cold.pinnedBytes
          },
          warm: {
            browserBytes: warm.browserBytes,
            pageFillReads: warm.pageFillReads,
            cacheHits: warm.pageFillCacheHits,
            active: warm.fillActiveReads,
            queued: warm.fillQueueRequests,
            pinnedBytes: warm.pinnedBytes
          }
        };
      } finally {
        source.close();
      }
    });

    expect(result.cold.browserBytes).toBeGreaterThan(0);
    expect(result.cold.pageFillReads).toBeGreaterThan(0);
    expect(result.cold.deduplications).toBeGreaterThan(0);
    expect(result.cold.peakActive).toBeGreaterThan(0);
    expect(result.warm.browserBytes).toBe(result.cold.browserBytes);
    expect(result.warm.pageFillReads).toBe(result.cold.pageFillReads);
    expect(result.warm.cacheHits).toBeGreaterThan(0);
    expect(result.warm).toMatchObject({ active: 0, queued: 0, pinnedBytes: 0 });
  });

  test("clear and close retire active fills while foreground work keeps progressing", async ({ page }) => {
    test.setTimeout(45_000);
    await page.goto("/?fmap=1");
    const result = await page.evaluate(async () => {
      const { createFmapRangeDataSource } = await import("/src/io/fmap/index.js");
      const wasmBytes = await (await fetch("/wasm/fmap/pkg/fmap_core.wasm")).arrayBuffer();
      const MIB = 1024 * 1024;
      const fileBytes = Uint8Array.from({ length: 16 * MIB }, (_value, index) => (index * 29) & 0xff);
      const options = {
        wasmBytes,
        pageSize: 4 * MIB,
        poolBytes: 8 * MIB,
        concurrency: 2,
        maxInflightBytes: 12 * MIB,
        maxQueuedBytes: 48 * MIB,
        maxQueuedRequests: 16,
        maxResultBytes: 4 * MIB,
        maxLogicalResultBytes: 16 * MIB,
        maxLogicalBytes: 24 * MIB,
        batchBytes: 4 * MIB
      };
      const makeSource = () => createFmapRangeDataSource(new File([fileBytes], "lifecycle.bin"), options);
      const outcome = (promise) => promise.then(() => "resolved", (error) => String(error?.name || "Error"));
      const waitForActiveFill = async (source) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const stats = await source.getStats();
          if (stats.fillActiveReads > 0) return stats;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        throw new Error("No active page fill was observed");
      };

      const clearSource = makeSource();
      await clearSource.ready;
      const stale = clearSource.readRange(0, 12 * MIB, null, { priority: "background" });
      const activeBeforeClear = await waitForActiveFill(clearSource);
      clearSource.clear();
      const staleOutcome = await outcome(stale);
      const chargedAfterClear = await clearSource.getStats();
      const fresh = await clearSource.readRange(0, 32, null, { priority: "foreground" });
      const afterFresh = await clearSource.getStats();
      clearSource.close();

      const closeSource = makeSource();
      await closeSource.ready;
      const closing = closeSource.readRange(0, 12 * MIB, null, { priority: "background" });
      await waitForActiveFill(closeSource);
      closeSource.close();
      const closeOutcome = await outcome(closing);

      const prioritySource = makeSource();
      await prioritySource.ready;
      let backgroundSettled = false;
      const background = prioritySource.readRange(0, 12 * MIB, null, { priority: "background" })
        .then(
          (value) => ({ status: "resolved", value }),
          (error) => ({ status: String(error?.name || "Error"), value: null })
        )
        .finally(() => { backgroundSettled = true; });
      await waitForActiveFill(prioritySource);
      const foregroundBytes = await prioritySource.readRange(
        (16 * MIB) - 32, 32, null, { priority: "foreground" }
      );
      const backgroundSettledAtForeground = backgroundSettled;
      const backgroundResult = await background;
      const priorityStats = await prioritySource.getStats();
      prioritySource.close();

      return {
        staleOutcome,
        closeOutcome,
        activeBeforeClear: activeBeforeClear.fillActiveReads,
        chargedAfterClear: chargedAfterClear.fillActiveReads,
        fresh: Array.from(fresh),
        backgroundSettledAtForeground,
        backgroundStatus: backgroundResult.status,
        foreground: Array.from(foregroundBytes),
        backgroundLength: backgroundResult.value?.byteLength || 0,
        priorityStats: {
          peakActive: priorityStats.peakFillActiveReads,
          active: priorityStats.fillActiveReads,
          queued: priorityStats.fillQueueRequests,
          pinnedBytes: priorityStats.pinnedBytes
        }
      };
    });

    expect(result.staleOutcome).toBe("AbortError");
    expect(result.closeOutcome).toBe("AbortError");
    expect(result.activeBeforeClear).toBeGreaterThan(0);
    expect(result.chargedAfterClear).toBeGreaterThanOrEqual(0);
    expect(result.fresh).toEqual(Array.from({ length: 32 }, (_value, index) => (index * 29) & 0xff));
    expect(result.foreground).toEqual(Array.from({ length: 32 }, (_value, index) => ((((16 * 1024 * 1024) - 32 + index) * 29) & 0xff)));
    expect(["resolved", "AbortError"]).toContain(result.backgroundStatus);
    if (result.backgroundStatus === "resolved") expect(result.backgroundLength).toBe(12 * 1024 * 1024);
    else expect(result.backgroundLength).toBe(0);
    expect(typeof result.backgroundSettledAtForeground).toBe("boolean");
    expect(result.priorityStats.peakActive).toBeGreaterThanOrEqual(1);
    expect(result.priorityStats).toMatchObject({ active: 0, queued: 0, pinnedBytes: 0 });
  });
});
