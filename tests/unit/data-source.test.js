import { describe, expect, test } from "vitest";
import { BlobDataSource, ChunkCacheDataSource } from "../../src/core/data-source.js";

function makeFile(bytes) {
  return new Blob([Uint8Array.from(bytes)]);
}

describe("data sources", () => {
  test("BlobDataSource reads byte ranges", async () => {
    const ds = new BlobDataSource(makeFile([0, 1, 2, 3, 4]));
    const out = await ds.read(1, 3);
    expect(Array.from(out)).toEqual([1, 2, 3]);
    expect(ds.bytesRead).toBe(3);
  });

  test("ChunkCacheDataSource caches and evicts", async () => {
    const base = new BlobDataSource(makeFile(Array.from({ length: 64 }, (_, i) => i)));
    const ds = new ChunkCacheDataSource(base, { chunkSize: 8, maxBytes: 16, concurrency: 2 });

    const a = await ds.read(0, 8);
    expect(Array.from(a)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    const b = await ds.read(8, 8);
    expect(Array.from(b)).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);

    await ds.read(16, 8);
    expect(ds.cacheBytes()).toBeLessThanOrEqual(16);
    expect(ds.bytesRead).toBeGreaterThan(0);
  });
});
