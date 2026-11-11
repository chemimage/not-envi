import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DATA_TYPES } from "../../src/core/envi-types.js";
import { FmapTiffDataSource } from "../../src/io/fmap/tiff-range-source.js";
import { BandOffsetTiffDataSource, TiffBlockIndexedDataSource } from "../../src/io/tiff/data-sources.js";
import { describeTiffDataset } from "../../src/io/tiff/describe.js";
import { resetTiffConcurrencyForTests } from "../../src/io/tiff/scheduler.js";
import { readSpectrumAtPixel as readRenderedSpectrum } from "../../src/render/spectrum-data.js";

afterEach(() => resetTiffConcurrencyForTests());

class MemoryRangeSource {
  constructor(bytes, { delayMs = 0 } = {}) {
    this.bytes = Uint8Array.from(bytes);
    this.size = this.bytes.byteLength;
    this.pageSize = 4096;
    this.maxBytes = 8192;
    this.concurrency = 3;
    this.ownerId = "test-tiff-fmap";
    this.delayMs = delayMs;
    this.reads = [];
    this.closed = false;
    this.ready = Promise.resolve(this);
    this.stats = { browserBytes: 0, copiedBytes: 0, residentBytes: 0, pinnedBytes: 0 };
  }

  async readRange(offset, length, _out = null, options = {}) {
    if (this.closed) throw new Error("closed");
    if (options.signal?.aborted || options.cancelled?.()) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (options.signal?.aborted || options.cancelled?.()) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    this.reads.push({ offset, length });
    this.stats.browserBytes += length;
    this.stats.copiedBytes += length;
    return this.bytes.slice(offset, offset + length);
  }

  async getStats() { return { ...this.stats }; }
  cacheBytes() { return this.stats.residentBytes; }
  setConcurrency(value) { this.concurrency = value; }
  setMaxBytes(value) { this.maxBytes = value; }
  clear() {}
  close() { this.closed = true; }
}

function fmapSource(bytes, options = {}) {
  const range = new MemoryRangeSource(bytes, options);
  return {
    range,
    source: new FmapTiffDataSource(range, {
      maxWorkingSetBytes: options.maxWorkingSetBytes ?? 256,
      maxLogicalResultBytes: options.maxLogicalResultBytes,
      maxQueuedReservations: 8,
      maxQueuedReservationBytes: 1024
    })
  };
}

function meta(width, height, bands = 1) {
  return {
    samples: width,
    lines: height,
    bands,
    interleave: bands === 1 ? "bsq" : "bip",
    littleEndian: true,
    dataType: 1,
    dataTypeInfo: DATA_TYPES.get(1)
  };
}

function literalLzw(bytes) {
  const codes = [256, ...bytes, 257];
  let bits = "";
  for (const code of codes) bits += code.toString(2).padStart(9, "0");
  bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, "0");
  return Uint8Array.from({ length: bits.length / 8 }, (_v, index) => Number.parseInt(bits.slice(index * 8, (index + 1) * 8), 2));
}

function blockSource({ encoded, compression, width = 4, height = 1, decodedCacheBytes = 64, workingBytes = 256 * 1024 }) {
  const { source: rangeSource, range } = fmapSource(encoded, { maxWorkingSetBytes: workingBytes });
  const imageMeta = meta(width, height);
  const block = { key: `codec-${compression}`, x0: 0, y0: 0, w: width, h: height, offset: 0, byteCount: encoded.byteLength };
  const table = {
    blockWidth: width,
    blockHeight: height,
    numBlocksX: 1,
    numBlocksY: 1,
    summary: {
      compression,
      fileDirectory: {
        Compression: compression,
        Predictor: 1,
        BitsPerSample: [8],
        SamplesPerPixel: 1,
        PlanarConfiguration: 1,
        ImageWidth: width,
        ImageLength: height
      }
    }
  };
  const source = new TiffBlockIndexedDataSource({
    file: new File([encoded], "codec.tif"),
    tiff: null,
    meta: imageMeta,
    rangeSource,
    bandSpecs: [{ kind: "raw", table, blocks: [block], sampleByteOffset: 0, bytesPerSample: 1, bytesPerPixel: 1, channel: 0 }],
    budgets: { rawCacheBytes: 0, decodedCacheBytes },
    concurrency: 3
  });
  return { source, range, imageMeta };
}

describe("TIFF fmap block path", () => {
  test.each([
    ["PackBits", 32773, Uint8Array.from([3, 10, 20, 30, 40])],
    ["LZW", 5, literalLzw([10, 20, 30, 40])],
    ["Deflate", 8, new Uint8Array(deflateSync(Uint8Array.from([10, 20, 30, 40])))]
  ])("decodes %s blocks from bounded fmap ranges and caches the decoded backing", async (_name, compression, encoded) => {
    const { source, range, imageMeta } = blockSource({ encoded, compression });
    try {
      expect(Array.from(await source.readBandWindow(imageMeta, 0, 0, 0, 4, 1, 1))).toEqual([10, 20, 30, 40]);
      const coldBytes = range.stats.browserBytes;
      expect(Array.from(await source.readBandWindow(imageMeta, 0, 0, 0, 4, 1, 1))).toEqual([10, 20, 30, 40]);
      expect(range.stats.browserBytes).toBe(coldBytes);
      const stats = await source.getStats();
      expect(stats.isFmap).toBe(true);
      expect(stats.retainedBackingBytes).toBe(4);
      expect(stats.decodedCacheHits).toBeGreaterThan(0);
      expect(stats.peakReservationBytes).toBeLessThanOrEqual(256 * 1024);
    } finally {
      source.close();
    }
  });

  test("rejects an oversized compressed block before reading it", async () => {
    const encoded = new Uint8Array(40);
    const { source, range, imageMeta } = blockSource({ encoded, compression: 8, width: 64, workingBytes: 64, decodedCacheBytes: 128 });
    try {
      await expect(source.readBandWindow(imageMeta, 0, 0, 0, 64, 1, 1)).rejects.toThrow(/working-set limit/i);
      expect(range.reads).toHaveLength(0);
    } finally {
      source.close();
    }
  });

  test("rejects decoded backing that cannot fit the cache budget before I/O", async () => {
    const { source, range, imageMeta } = blockSource({ encoded: Uint8Array.from([1, 2, 3, 4]), compression: 1, decodedCacheBytes: 3 });
    try {
      await expect(source.readBandWindow(imageMeta, 0, 0, 0, 4, 1, 1)).rejects.toThrow(/decoded-cache budget/i);
      expect(range.reads).toHaveLength(0);
    } finally {
      source.close();
    }
  });

  test("rejects oversized automatic window output before block I/O", async () => {
    const encoded = Uint8Array.from([1, 2, 3, 4]);
    const { source: rangeSource, range } = fmapSource(encoded, { maxLogicalResultBytes: 4 });
    const imageMeta = meta(4, 1);
    const table = { blockWidth: 4, blockHeight: 1, numBlocksX: 1, numBlocksY: 1, summary: { compression: 1 } };
    const source = new TiffBlockIndexedDataSource({
      file: new File([encoded], "logical-limit.tif"), tiff: null, meta: imageMeta, rangeSource,
      bandSpecs: [{ kind: "raw", table,
        blocks: [{ key: "limit", x0: 0, y0: 0, w: 4, h: 1, offset: 0, byteCount: 4 }],
        sampleByteOffset: 0, bytesPerSample: 1, bytesPerPixel: 1, channel: 0 }],
      budgets: { rawCacheBytes: 0, decodedCacheBytes: 8 }
    });
    try {
      await expect(source.readBandWindow(imageMeta, 0, 0, 0, 5, 1, 1)).rejects.toThrow(/logical-result limit/i);
      expect(range.reads).toHaveLength(0);
    } finally { source.close(); }
  });

  test("normalizes render-helper spectrum options for block and band-offset sources", async () => {
    const encoded = Uint8Array.from([7]);
    const { source: rangeSource } = fmapSource(encoded);
    const imageMeta = meta(1, 1);
    const table = { blockWidth: 1, blockHeight: 1, numBlocksX: 1, numBlocksY: 1, summary: { compression: 1 } };
    const block = new TiffBlockIndexedDataSource({
      file: new File([encoded], "spectrum-options.tif"), tiff: null, meta: imageMeta, rangeSource,
      bandSpecs: [{ kind: "raw", table,
        blocks: [{ key: "spectrum", x0: 0, y0: 0, w: 1, h: 1, offset: 0, byteCount: 1 }],
        sampleByteOffset: 0, bytesPerSample: 1, bytesPerPixel: 1, channel: 0 }],
      budgets: { rawCacheBytes: 0, decodedCacheBytes: 1 }
    });
    const cancelled = { cancelled: () => true };
    await expect(readRenderedSpectrum({ meta: imageMeta, ds: block }, 0, 0, 2, cancelled))
      .rejects.toMatchObject({ name: "AbortError" });
    block.close();

    const bandSource = new BandOffsetTiffDataSource({ isFmap: true, maxLogicalResultBytes: 16 }, imageMeta, [0]);
    await expect(readRenderedSpectrum({ meta: imageMeta, ds: bandSource }, 0, 0, 2, cancelled))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  test("reads planar edge tiles and separate page bands through one fmap source", async () => {
    const bytes = Uint8Array.from([1, 2, 4, 5, 3, 0, 6, 0, 11, 12, 14, 15, 13, 0, 16, 0]);
    const { source: rangeSource } = fmapSource(bytes);
    const imageMeta = meta(3, 2, 2);
    imageMeta.interleave = "bsq";
    const table = { blockWidth: 2, blockHeight: 2, numBlocksX: 2, numBlocksY: 1, summary: { compression: 1 } };
    const makeBlocks = (prefix, offset) => [
      { key: `${prefix}-0`, x0: 0, y0: 0, w: 2, h: 2, offset, byteCount: 4 },
      { key: `${prefix}-1`, x0: 2, y0: 0, w: 1, h: 2, offset: offset + 4, byteCount: 4 }
    ];
    const source = new TiffBlockIndexedDataSource({
      file: new File([bytes], "planar-pages.tif"), tiff: null, meta: imageMeta, rangeSource,
      bandSpecs: [0, 1].map((band) => ({
        kind: "raw", table, blocks: makeBlocks(`page-${band}`, band * 8), sampleByteOffset: 0,
        bytesPerSample: 1, bytesPerPixel: 1, channel: 0
      })),
      budgets: { rawCacheBytes: 0, decodedCacheBytes: 16 }, concurrency: 2
    });
    try {
      expect(Array.from(await source.readBandWindow(imageMeta, 0, 0, 0, 3, 2, 1))).toEqual([1, 2, 3, 4, 5, 6]);
      expect(Array.from(await source.readBandWindow(imageMeta, 1, 0, 0, 3, 2, 1))).toEqual([11, 12, 13, 14, 15, 16]);
    } finally { source.close(); }
  });

  test("uses actual rows for a compressed final partial strip", async () => {
    const first = new Uint8Array(deflateSync(Uint8Array.from([1, 2, 3, 4])));
    const last = new Uint8Array(deflateSync(Uint8Array.from([5, 6])));
    const bytes = new Uint8Array(first.byteLength + last.byteLength);
    bytes.set(first, 0);
    bytes.set(last, first.byteLength);
    const { source: rangeSource } = fmapSource(bytes, { maxWorkingSetBytes: 256 * 1024 });
    const imageMeta = meta(2, 3);
    const fileDirectory = {
      Compression: 8, Predictor: 1, BitsPerSample: [8], SamplesPerPixel: 1,
      PlanarConfiguration: 1, ImageWidth: 2, ImageLength: 3, RowsPerStrip: 2
    };
    const table = {
      isTiled: false, blockWidth: 2, blockHeight: 2, numBlocksX: 1, numBlocksY: 2,
      summary: { compression: 8, fileDirectory }
    };
    const blocks = [
      { key: "strip-0", x0: 0, y0: 0, w: 2, h: 2, offset: 0, byteCount: first.byteLength },
      { key: "strip-1", x0: 0, y0: 2, w: 2, h: 1, offset: first.byteLength, byteCount: last.byteLength }
    ];
    const source = new TiffBlockIndexedDataSource({
      file: new File([bytes], "partial-strip.tif"), tiff: null, meta: imageMeta, rangeSource,
      bandSpecs: [{ kind: "raw", table, blocks, sampleByteOffset: 0, bytesPerSample: 1, bytesPerPixel: 1, channel: 0 }],
      budgets: { rawCacheBytes: 0, decodedCacheBytes: 8 }, concurrency: 2
    });
    try {
      expect(Array.from(await source.readBandWindow(imageMeta, 0, 0, 0, 2, 3, 1))).toEqual([1, 2, 3, 4, 5, 6]);
    } finally { source.close(); }
  });

  test("uses a raw-compatible overview without touching base blocks", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 21, 22]);
    const { source: rangeSource, range } = fmapSource(bytes);
    const imageMeta = meta(4, 2);
    const table = { blockWidth: 4, blockHeight: 2, numBlocksX: 1, numBlocksY: 1, summary: { compression: 1 } };
    const baseSpec = { kind: "raw", table,
      blocks: [{ key: "base", x0: 0, y0: 0, w: 4, h: 2, offset: 0, byteCount: 8 }],
      sampleByteOffset: 0, bytesPerSample: 1, bytesPerPixel: 1, channel: 0 };
    const overview = {
      image: {}, width: 2, height: 1, samplesPerPixel: 1, planarConfiguration: 1,
      photometricInterpretation: 1, compression: 1, rowsPerStrip: 1, tileOffsets: [],
      stripOffsets: [8], stripByteCounts: [2], fileDirectory: { StripByteCounts: [2] }
    };
    const source = new TiffBlockIndexedDataSource({
      file: new File([bytes], "overview.tif"), tiff: null, meta: imageMeta, rangeSource,
      bandSpecs: [baseSpec], overviewSummaries: [overview],
      budgets: { rawCacheBytes: 0, decodedCacheBytes: 16 }, concurrency: 1
    });
    try {
      expect(Array.from(await source.readBandWindow(imageMeta, 0, 0, 0, 2, 1, 2))).toEqual([21, 22]);
      expect(range.reads).toEqual([{ offset: 8, length: 2 }]);
    } finally { source.close(); }
  });

  test("ignores an overview whose compression lacks a bounded fmap decoder", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 99, 100]);
    const { source: rangeSource, range } = fmapSource(bytes);
    const imageMeta = meta(4, 2);
    const table = { blockWidth: 4, blockHeight: 2, numBlocksX: 1, numBlocksY: 1, summary: { compression: 1 } };
    const overview = {
      image: {}, width: 2, height: 1, samplesPerPixel: 1, planarConfiguration: 1,
      photometricInterpretation: 1, compression: 7, rowsPerStrip: 1, tileOffsets: [],
      stripOffsets: [8], stripByteCounts: [2], fileDirectory: { Compression: 7, StripByteCounts: [2] }
    };
    const source = new TiffBlockIndexedDataSource({
      file: new File([bytes], "unsupported-overview.tif"), tiff: null, meta: imageMeta, rangeSource,
      bandSpecs: [{ kind: "raw", table,
        blocks: [{ key: "base-fallback", x0: 0, y0: 0, w: 4, h: 2, offset: 0, byteCount: 8 }],
        sampleByteOffset: 0, bytesPerSample: 1, bytesPerPixel: 1, channel: 0 }],
      overviewSummaries: [overview], budgets: { rawCacheBytes: 0, decodedCacheBytes: 16 }
    });
    try {
      expect(source.overviewCount).toBe(0);
      expect(Array.from(await source.readBandWindow(imageMeta, 0, 0, 0, 2, 1, 2))).toEqual([1, 3]);
      expect(range.reads).toEqual([{ offset: 0, length: 8 }]);
    } finally { source.close(); }
  });

  test("churns a one-block decoded cache without deadlock or retained-accounting overflow", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const { source: rangeSource } = fmapSource(bytes, { maxWorkingSetBytes: 12 });
    const imageMeta = meta(6, 1);
    const table = { blockWidth: 2, blockHeight: 1, numBlocksX: 3, numBlocksY: 1, summary: { compression: 1 } };
    const blocks = [0, 1, 2].map((index) => ({
      key: `churn-${index}`, x0: index * 2, y0: 0, w: 2, h: 1, offset: index * 2, byteCount: 2
    }));
    const source = new TiffBlockIndexedDataSource({
      file: new File([bytes], "churn.tif"), tiff: null, meta: imageMeta, rangeSource,
      bandSpecs: [{ kind: "raw", table, blocks, sampleByteOffset: 0, bytesPerSample: 1, bytesPerPixel: 1, channel: 0 }],
      budgets: { rawCacheBytes: 0, decodedCacheBytes: 2 }, concurrency: 3
    });
    try {
      expect(Array.from(await source.readBandWindow(imageMeta, 0, 0, 0, 6, 1, 1))).toEqual([1, 2, 3, 4, 5, 6]);
      const stats = await source.getStats();
      expect(stats.retainedBackingBytes).toBeLessThanOrEqual(2);
      expect(stats.activeReservationBytes).toBe(0);
      source.clear();
      expect((await rangeSource.getStats()).retainedBackingBytes).toBe(0);
    } finally { source.close(); }
  });
});

describe("TIFF fmap reservation lifecycle", () => {
  test("grants queued reservations atomically and cancels a queued waiter", async () => {
    const { source } = fmapSource(new Uint8Array(16), { maxWorkingSetBytes: 8 });
    const first = await source.reserveWorkingSet({ encodedBytes: 8 });
    const controller = new AbortController();
    const cancelled = source.reserveWorkingSet({ encodedBytes: 8, signal: controller.signal });
    const next = source.reserveWorkingSet({ encodedBytes: 8 });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    first.release();
    const granted = await next;
    const stats = await source.getStats();
    expect(stats.peakReservationBytes).toBeLessThanOrEqual(8);
    expect(stats.queuedReservations).toBe(0);
    granted.release();
    source.close();
  });
});

describe("TIFF fmap fallback policy", () => {
  function fallbackHarness({ width = 2, height = 2, compression = 7, byteCount = 4 } = {}) {
    const image = {
      tiles: {},
      getWidth: () => width,
      getHeight: () => height,
      getSamplesPerPixel: () => 1,
      getBitsPerSample: () => 8,
      getSampleFormat: () => 1,
      getFileDirectory: () => ({
        Compression: compression,
        RowsPerStrip: height,
        StripOffsets: [0],
        StripByteCounts: [byteCount],
        PhotometricInterpretation: 1
      }),
      readRasters: vi.fn(async () => new Uint8Array(width * height))
    };
    const tiff = {
      littleEndian: true,
      bigTiff: false,
      getImageCount: async () => 1,
      getImage: async () => image,
      close: vi.fn()
    };
    const fmap = { close: vi.fn() };
    return { image, tiff, fmap };
  }

  test("rejects an unsupported codec before payload I/O when fmap is requested", async () => {
    const { tiff, fmap } = fallbackHarness();
    const file = new File([new Uint8Array(4)], "jpeg-gray.tif", { type: "image/tiff" });
    await expect(describeTiffDataset(tiff, file, {
      tiffFmapRangeSource: fmap,
      cacheBytes: 64
    })).rejects.toThrow(/does not have a verified bounded decoder for compression 7.*Disable fmap/i);
    expect(fmap.close).toHaveBeenCalledTimes(1);
  });

  test("preserves the existing unsupported-codec fallback when fmap is disabled", async () => {
    const { tiff } = fallbackHarness();
    const file = new File([new Uint8Array(4)], "jpeg-gray.tif", { type: "image/tiff" });
    const result = await describeTiffDataset(tiff, file, { cacheBytes: 64 });
    expect(result.raw.fmap).toBe(false);
    expect(result.cached.isFmap).toBe(false);
    result.cached.close();
  });
});
