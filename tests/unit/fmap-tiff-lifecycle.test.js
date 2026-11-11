import { afterEach, describe, expect, test, vi } from "vitest";
import { DATA_TYPES } from "../../src/core/envi-types.js";
import { FmapTiffDataSource } from "../../src/io/fmap/tiff-range-source.js";
import { TiffBlockIndexedDataSource } from "../../src/io/tiff/data-sources.js";
import { describeTiffDataset } from "../../src/io/tiff/describe.js";
import { resetTiffConcurrencyForTests } from "../../src/io/tiff/scheduler.js";

afterEach(() => {
  resetTiffConcurrencyForTests();
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class FakeRangeSource {
  constructor(bytes, { deferReads = false } = {}) {
    this.bytes = Uint8Array.from(bytes);
    this.size = this.bytes.byteLength;
    this.ownerId = "fake-fmap-range";
    this.pageSize = 4096;
    this.chunkSize = 4096;
    this.maxBytes = 8192;
    this.concurrency = 2;
    this.ready = Promise.resolve(this);
    this.stats = {};
    this.deferReads = deferReads;
    this.readStarted = deferred();
    this.readGate = deferred();
    this.closed = false;
  }

  async readRange(offset, length) {
    this.readStarted.resolve();
    if (this.deferReads) await this.readGate.promise;
    return this.bytes.slice(offset, offset + length);
  }

  resolveReads() { this.readGate.resolve(); }
  setConcurrency(value) { this.concurrency = value; }
  setMaxBytes(value) { this.maxBytes = value; }
  cacheBytes() { return this.closed ? 0 : this.maxBytes; }
  async getStats() { return { ...this.stats }; }
  clear() {}
  close() { this.closed = true; }
}

function createRawBlockHarness(bytes, options = {}) {
  const base = new FakeRangeSource(bytes, options);
  const range = new FmapTiffDataSource(base, {
    maxWorkingSetBytes: options.maxWorkingSetBytes ?? 16,
    maxQueuedReservations: 8,
    maxQueuedReservationBytes: 64
  });
  const meta = {
    samples: bytes.length,
    lines: 1,
    bands: 1,
    interleave: "bsq",
    littleEndian: true,
    dataType: 1,
    dataTypeInfo: DATA_TYPES.get(1)
  };
  const blocks = bytes.map((_value, index) => ({
    key: `b${index}`,
    x0: index,
    y0: 0,
    w: 1,
    h: 1,
    offset: index,
    byteCount: 1
  }));
  const table = {
    blockWidth: 1,
    blockHeight: 1,
    numBlocksX: bytes.length,
    numBlocksY: 1,
    summary: { compression: 1 }
  };
  const source = new TiffBlockIndexedDataSource({
    file: new File([Uint8Array.from(bytes)], "fmap-lifecycle.tif", { type: "image/tiff" }),
    tiff: null,
    meta,
    rangeSource: range,
    bandSpecs: [{
      kind: "raw",
      table,
      blocks,
      sampleByteOffset: 0,
      bytesPerSample: 1,
      bytesPerPixel: 1,
      channel: 0
    }],
    concurrency: 2,
    budgets: { rawCacheBytes: 0, decodedCacheBytes: options.decodedCacheBytes ?? 1 }
  });
  return { base, range, source, meta };
}

describe("fmap TIFF lifecycle bounds", () => {
  test("grants at most one queued reservation and rejects remaining waiters on clear", async () => {
    const base = new FakeRangeSource([1]);
    const source = new FmapTiffDataSource(base, {
      maxWorkingSetBytes: 8,
      maxQueuedReservations: 4,
      maxQueuedReservationBytes: 16
    });
    const first = await source.reserveWorkingSet({ encodedBytes: 8 });
    let secondSettled = false;
    let thirdSettled = false;
    const secondPromise = source.reserveWorkingSet({ encodedBytes: 6 })
      .then((lease) => { secondSettled = true; return lease; });
    const thirdPromise = source.reserveWorkingSet({ encodedBytes: 6 })
      .then((lease) => { thirdSettled = true; return lease; });
    await nextTurn();
    expect((await source.getStats()).queuedReservations).toBe(2);

    first.release();
    const second = await secondPromise;
    await nextTurn();
    expect(secondSettled).toBe(true);
    expect(thirdSettled).toBe(false);
    expect((await source.getStats()).activeReservationBytes).toBeLessThanOrEqual(8);

    source.clear();
    await expect(thirdPromise).rejects.toMatchObject({ name: "AbortError" });
    second.release();
    expect((await source.getStats()).activeReservationBytes).toBe(0);
    source.close();
  });

  test.each(["clear", "close"])("%s invalidates a delayed block read without cache resurrection", async (action) => {
    const { base, range, source, meta } = createRawBlockHarness([9], { deferReads: true });
    const pending = source.readBandWindow(meta, 0, 0, 0, 1, 1, 1);
    await base.readStarted.promise;

    source[action]();
    base.resolveReads();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await nextTurn();
    expect(source.stats.decodedCacheBytes).toBe(0);
    expect((await range.getStats()).retainedBackingBytes).toBe(0);
    if (action === "clear") source.close();
  });

  test("churns a one-block decoded cache without leaking leases or deadlocking", async () => {
    const { range, source, meta } = createRawBlockHarness([3, 5, 7], {
      decodedCacheBytes: 1,
      maxWorkingSetBytes: 8
    });
    try {
      const values = await source.readBandWindow(meta, 0, 0, 0, 3, 1, 1);
      expect(Array.from(values)).toEqual([3, 5, 7]);
      expect(source.stats.decodedCacheBytes).toBe(1);
      const stats = await range.getStats();
      expect(stats.retainedBackingBytes).toBeLessThanOrEqual(1);
      expect(stats.activeReservationBytes).toBe(0);
    } finally {
      source.close();
    }
  });

  test("failed raw validation keeps the shared fmap source open for block fallback", async () => {
    const shared = {
      isFmap: true,
      size: 1,
      ownerId: "shared-fmap",
      stats: {},
      close: vi.fn(),
      clear: vi.fn(),
      setConcurrency: vi.fn(),
      setMaxBytes: vi.fn(),
      cacheBytes: vi.fn(() => 0),
      read: vi.fn(async () => Uint8Array.of(7)),
      readInto: vi.fn(async (_offset, destination, destinationOffset = 0) => {
        destination[destinationOffset] = 7;
        return 1;
      })
    };
    const image = {
      tiles: {},
      getWidth: () => 1,
      getHeight: () => 1,
      getSamplesPerPixel: () => 1,
      getBitsPerSample: () => 8,
      getSampleFormat: () => 1,
      getFileDirectory: () => ({
        Compression: 1,
        RowsPerStrip: 1,
        StripOffsets: [0],
        StripByteCounts: [1],
        PhotometricInterpretation: 1
      }),
      readRasters: vi.fn(async () => Uint8Array.of(42))
    };
    const tiff = {
      littleEndian: true,
      bigTiff: false,
      getImageCount: async () => 1,
      getImage: async () => image,
      close: vi.fn()
    };
    const file = new File([Uint8Array.of(7)], "mismatch-fmap.tif", { type: "image/tiff" });
    const description = await describeTiffDataset(tiff, file, {
      tiffFmapRangeSource: shared,
      ioConcurrency: 1
    });

    expect(description.mode).toBe("block-indexed");
    expect(description.cached.rawSource).toBe(shared);
    expect(shared.close).not.toHaveBeenCalled();

    description.cached.close();
    expect(shared.close).toHaveBeenCalledTimes(1);
  });
});
