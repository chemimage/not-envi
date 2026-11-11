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

  test("ChunkCacheDataSource returns consistent short reads at EOF", async () => {
    const chunkSize = 64 * 1024;
    const data = new Uint8Array(chunkSize + 2).fill(7);
    const ds = new ChunkCacheDataSource(new BlobDataSource(makeFile(data)), {
      chunkSize,
      maxBytes: 2 * chunkSize
    });

    expect(Array.from(await ds.read(chunkSize, 8))).toEqual([7, 7]);
    expect(Array.from(await ds.read(chunkSize - 2, 8))).toEqual([7, 7, 7, 7]);
    expect(await ds.readInto(chunkSize + 2, new Uint8Array(4))).toBe(0);
  });

  test("ChunkCacheDataSource returns owned bytes instead of mutable cache views", async () => {
    const chunkSize = 64 * 1024;
    const ds = new ChunkCacheDataSource(
      new BlobDataSource(makeFile(new Uint8Array(chunkSize).fill(11))),
      { chunkSize, maxBytes: 2 * chunkSize }
    );

    const first = await ds.read(0, 1);
    first[0] = 99;
    expect(Array.from(await ds.read(0, 1))).toEqual([11]);
    expect(first.buffer.byteLength).toBe(1);
  });

  test("ChunkCacheDataSource visits a large range incrementally", async () => {
    const chunkSize = 64 * 1024;
    let sourceReads = 0;
    const source = {
      size: 6 * chunkSize,
      async read(_offset, length) {
        sourceReads += 1;
        return new Uint8Array(length);
      }
    };
    const ds = new ChunkCacheDataSource(source, {
      chunkSize,
      maxBytes: 2 * chunkSize,
      concurrency: 4
    });
    const readsSeenByVisitor = [];

    await ds.visitPages(0, source.size, () => {
      readsSeenByVisitor.push(sourceReads);
    });

    expect(readsSeenByVisitor[0]).toBe(1);
    expect(readsSeenByVisitor).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ds.cacheBytes()).toBeLessThanOrEqual(2 * chunkSize);
  });

  test("clear prevents an older in-flight read from repopulating the cache", async () => {
    const chunkSize = 64 * 1024;
    let release;
    const source = {
      size: chunkSize,
      read: () => new Promise((resolve) => { release = resolve; })
    };
    const ds = new ChunkCacheDataSource(source, {
      chunkSize,
      maxBytes: 2 * chunkSize
    });

    const pending = ds.read(0, 1);
    await Promise.resolve();
    await Promise.resolve();
    ds.clear();
    release(new Uint8Array(chunkSize).fill(3));

    expect(Array.from(await pending)).toEqual([3]);
    expect(ds.cacheBytes()).toBe(0);
  });

  test("concurrency limits aggregate source reads across independent calls", async () => {
    const chunkSize = 64 * 1024;
    let active = 0;
    let maxActive = 0;
    const source = {
      size: 4 * chunkSize,
      async read(_offset, length) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return new Uint8Array(length);
      }
    };
    const ds = new ChunkCacheDataSource(source, {
      chunkSize,
      maxBytes: 2 * chunkSize,
      concurrency: 1
    });

    await Promise.all([0, 1, 2, 3].map((index) => ds.read(index * chunkSize, 1)));
    expect(maxActive).toBe(1);
  });

  test("source instances receive distinct cancellation owners", () => {
    const file = makeFile([1, 2, 3]);
    const first = new BlobDataSource(file);
    const second = new BlobDataSource(file);
    expect(first.ownerId).not.toBe(second.ownerId);

    const firstCache = new ChunkCacheDataSource(first);
    const secondCache = new ChunkCacheDataSource(second);
    expect(firstCache.ownerId).not.toBe(secondCache.ownerId);
  });
});
