import { expect, test } from "@playwright/test";

test("mapped pointers share file pages and survive cache clear independently of mapping release", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createFmapRangeDataSource } = await import("/src/io/fmap/index.js");
    const wasmBytes = await (await fetch("/wasm/fmap/pkg/fmap_core.wasm")).arrayBuffer();
    const bytes = Uint8Array.from({ length: 12288 }, (_v, i) => i % 251);
    const source = createFmapRangeDataSource(new File([bytes], "mapped.bin"), {
      wasmBytes, pageSize: 4096, poolBytes: 12288
    });
    try {
      const a = await source.map({ offset: 4000, length: 300 });
      const b = await source.map({ offset: 4000, length: 300 });
      const pointer = a.ptr(0);
      const first = await a.read(pointer, 300);
      const cold = await source.getStats();
      const second = await b.read(b.ptr(), 300);
      const warm = await source.getStats();
      source.clear();
      const afterClear = await a.read(pointer, 300);
      await source.mapping.release();
      const afterRootRelease = await b.read(b.ptr(), 300);
      let rootError;
      try { await source.readRange(4000, 8); } catch (error) { rootError = error.message; }
      await a.release();
      let staleError;
      try { await a.read(pointer, 8); } catch (error) { staleError = error.name; }
      const replacement = await source.map({ offset: 10, length: 300, address: a.address });
      let workerStaleError;
      try {
        await source.readRange(4000, 8, null, { mappingId: a.mappingId, virtualAddress: a.address });
      } catch (error) { workerStaleError = error.message; }
      const newBytes = await replacement.read(replacement.ptr(), 16);
      const high = await source.map({ offset: 9000, length: 100,
        address: Math.floor(Number.MAX_SAFE_INTEGER / 4096) * 4096 });
      const highBytes = await high.read(high.ptr(7), 32);
      await high.release();
      const pendingMap = source.map({ offset: 30, length: 12 });
      await Promise.resolve();
      source.clear();
      const createdAcrossClear = await pendingMap;
      const clearBytes = await createdAcrossClear.read(createdAcrossClear.ptr(), 12);
      const pendingRelease = createdAcrossClear.release();
      await Promise.resolve();
      source.clear();
      await pendingRelease;
      const stats = await source.getStats();
      return {
        first: [...first], second: [...second], afterClear: [...afterClear], afterRootRelease: [...afterRootRelease],
        expected: [...bytes.slice(4000, 4300)], coldBytes: cold.browserBytes, warmBytes: warm.browserBytes,
        addresses: [a.address, b.address], rootError, staleError, workerStaleError,
        replacementId: replacement.mappingId, oldId: a.mappingId,
        newBytes: [...newBytes], expectedNew: [...bytes.slice(10, 26)], mappingCount: stats.mappingCount,
        highBytes: [...highBytes], expectedHigh: [...bytes.slice(9007, 9039)],
        clearBytes: [...clearBytes], expectedClear: [...bytes.slice(30, 42)],
        pinnedBytes: stats.pinnedBytes
      };
    } finally { source.close(); }
  });
  for (const key of ["first", "second", "afterClear", "afterRootRelease"]) expect(result[key]).toEqual(result.expected);
  expect(result.warmBytes).toBe(result.coldBytes);
  expect(result.addresses.every((address) => address % 4096 === 0)).toBe(true);
  expect(result.addresses[0]).not.toBe(result.addresses[1]);
  expect(result.rootError).toMatch(/unmapped/);
  expect(result.staleError).toBe("AbortError");
  expect(result.workerStaleError).toMatch(/unmapped/);
  expect(result.replacementId).not.toBe(result.oldId);
  expect(result.newBytes).toEqual(result.expectedNew);
  expect(result.highBytes).toEqual(result.expectedHigh);
  expect(result.clearBytes).toEqual(result.expectedClear);
  expect(result.mappingCount).toBe(2);
  expect(result.pinnedBytes).toBe(0);
});

test("required mapped reads wait through tiny execution budgets instead of queue rejection", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createFmapRangeDataSource } = await import("/src/io/fmap/index.js");
    const wasmBytes = await (await fetch("/wasm/fmap/pkg/fmap_core.wasm")).arrayBuffer();
    const bytes = Uint8Array.from({ length: 16384 }, (_v, i) => i % 251);
    const source = createFmapRangeDataSource(new File([bytes], "pressure.bin"), {
      wasmBytes, pageSize: 4096, poolBytes: 4096, concurrency: 1,
      maxQueuedRequests: 1, maxQueuedBytes: 8192, maxInflightBytes: 8192,
      maxResultBytes: 4096, maxLogicalResultBytes: 2048, maxLogicalBytes: 2048
    });
    try {
      const region = await source.map({ offset: 3, length: bytes.length - 3 });
      const reads = Array.from({ length: 100 }, (_v, i) => {
        const offset = (i * 113) % (region.length - 1024);
        return region.read(region.ptr(offset), 1024).then((data) =>
          data.every((value, j) => value === bytes[offset + 3 + j]));
      });
      const valid = await Promise.all(reads);
      const destination = new Uint8Array(8192);
      const written = await region.readInto(region.ptr(5), destination);
      const stats = await source.getStats();
      return { valid: valid.every(Boolean), stats, written,
        streamed: destination.every((value, i) => value === bytes[8 + i]) };
    } finally { source.close(); }
  });
  expect(result.valid).toBe(true);
  expect(result.streamed).toBe(true);
  expect(result.written).toBe(8192);
  expect(result.stats.rejectedRequests).toBe(0);
  expect(result.stats.peakQueuedRequests).toBeLessThanOrEqual(1);
  expect(result.stats.peakLogicalBytes).toBeLessThanOrEqual(2048);
  expect(result.stats.peakInflightBytes).toBeLessThanOrEqual(8192);
  expect(result.stats.pinnedBytes).toBe(0);
});

test("empty root mapping can be read and released without making released addresses valid", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createFmapRangeDataSource } = await import("/src/io/fmap/index.js");
    const wasmBytes = await (await fetch("/wasm/fmap/pkg/fmap_core.wasm")).arrayBuffer();
    const source = createFmapRangeDataSource(new File([], "empty.bin"), { wasmBytes, pageSize: 4096, poolBytes: 4096 });
    try {
      const initial = await source.mapping.read(source.mapping.ptr(), 0);
      await source.mapping.release();
      let error;
      try { await source.readRange(0, 0); } catch (failure) { error = failure.message; }
      return { initial: initial.length, error };
    } finally { source.close(); }
  });
  expect(result.initial).toBe(0);
  expect(result.error).toMatch(/unmapped/);
});
