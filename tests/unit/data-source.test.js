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

  test("ChunkCacheDataSource reuses cached reads, evicts, and releases resources on close", async () => {
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

    const bytesAfterFirstRead = base.bytesRead;
    expect(Array.from(await ds.read(0, 8))).toEqual(Array.from(a));
    expect(base.bytesRead).toBe(bytesAfterFirstRead);

    const b = await ds.read(64 * 1024 + 8, 8);
    expect(Array.from(b)).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);

    await ds.read(2 * 64 * 1024 + 8, 8);
    expect(ds.cacheBytes()).toBeLessThanOrEqual(2 * 64 * 1024);
    expect(ds.bytesRead).toBeGreaterThan(0);
    expect(ds.stats.cacheMisses).toBeGreaterThan(0);
    expect(ds.stats.cacheEvictions).toBeGreaterThan(0);
    ds.close();
    expect(ds.cacheBytes()).toBe(0);
    expect(base.closed).toBe(true);
    await expect(ds.read(0, 1)).rejects.toThrow("Data source closed");
  });

  test("ChunkCacheDataSource readInto fills caller-owned buffers across chunks", async () => {
    const chunkSize = 64 * 1024;
    const data = new Uint8Array((2 * chunkSize) + 8);
    for (let i = 0; i < data.length; i += 1) data[i] = i;
    const base = new BlobDataSource(makeFile(data));
    const ds = new ChunkCacheDataSource(base, {
      chunkSize,
      maxBytes: 2 * chunkSize,
      concurrency: 2
    });

    const out = new Uint8Array(6);
    const bytesRead = await ds.readInto(chunkSize - 2, out);

    expect(bytesRead).toBe(6);
    expect(Array.from(out)).toEqual([254, 255, 0, 1, 2, 3]);
    expect(ds.stats.readIntoCalls).toBe(1);
  });

  test("ChunkCacheDataSource visitPages yields chunk slices in order", async () => {
    const chunkSize = 64 * 1024;
    const data = new Uint8Array((3 * chunkSize) + 8);
    for (let i = 0; i < data.length; i += 1) data[i] = i;
    const base = new BlobDataSource(makeFile(data));
    const ds = new ChunkCacheDataSource(base, {
      chunkSize,
      maxBytes: 3 * chunkSize,
      concurrency: 2
    });

    const parts = [];
    await ds.visitPages(chunkSize - 2, chunkSize + 4, async (view, offset) => {
      parts.push({ offset, bytes: Array.from(view) });
    });

    expect(parts).toEqual([
      { offset: chunkSize - 2, bytes: [254, 255] },
      { offset: chunkSize, bytes: Array.from({ length: chunkSize }, (_unused, index) => index % 256) },
      { offset: 2 * chunkSize, bytes: [0, 1] }
    ]);
  });
});
