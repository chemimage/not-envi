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
    const data = new Uint8Array(3 * 64 * 1024);
    for (let i = 0; i < data.length; i += 1) data[i] = i % 256;
    const base = new BlobDataSource(makeFile(data));
    const ds = new ChunkCacheDataSource(base, {
      chunkSize: 64 * 1024,
      maxBytes: 2 * 64 * 1024,
      concurrency: 2
    });

    const a = await ds.read(0, 8);
    expect(Array.from(a)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    const b = await ds.read(64 * 1024 + 8, 8);
    expect(Array.from(b)).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);

    await ds.read(2 * 64 * 1024 + 8, 8);
    expect(ds.cacheBytes()).toBeLessThanOrEqual(2 * 64 * 1024);
    expect(ds.bytesRead).toBeGreaterThan(0);
  });

  test("ChunkCacheDataSource close clears cache and closes the base source", async () => {
    const base = new BlobDataSource(makeFile([0, 1, 2, 3, 4, 5, 6, 7]));
    const ds = new ChunkCacheDataSource(base, {
      chunkSize: 4,
      maxBytes: 8,
      concurrency: 1
    });

    await ds.read(0, 4);
    expect(ds.cacheBytes()).toBeGreaterThan(0);

    ds.close();

    expect(ds.cacheBytes()).toBe(0);
    expect(base.closed).toBe(true);
    await expect(ds.read(0, 1)).rejects.toThrow("Data source closed");
  });
});
