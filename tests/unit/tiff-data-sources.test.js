import { afterEach, describe, expect, test } from "vitest";
import { DATA_TYPES } from "../../src/core/envi-types.js";
import { TiffBlockIndexedDataSource } from "../../src/io/tiff/data-sources.js";
import { resetTiffConcurrencyForTests } from "../../src/io/tiff/scheduler.js";

afterEach(() => {
  resetTiffConcurrencyForTests();
});

function createRawBlockSource({ bytes, meta, bandSpecs, concurrency = 3 }) {
  return new TiffBlockIndexedDataSource({
    file: new File([Uint8Array.from(bytes)], "raw-blocks.bin", { type: "application/octet-stream" }),
    tiff: null,
    meta,
    bandSpecs,
    concurrency,
    budgets: {
      rawCacheBytes: 1 << 20,
      decodedCacheBytes: 1 << 20
    }
  });
}

function withTimeout(promise, ms = 1000) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve("timeout"), ms))
  ]);
}

describe("tiff block indexed data source", () => {
  test("raw tiled band reads do not deadlock nested scheduler work", async () => {
    const meta = {
      samples: 6,
      lines: 2,
      bands: 1,
      interleave: "bsq",
      littleEndian: true,
      dataType: 1,
      dataTypeInfo: DATA_TYPES.get(1)
    };
    const table = {
      blockWidth: 2,
      blockHeight: 2,
      numBlocksX: 3,
      numBlocksY: 1,
      summary: { compression: 1 }
    };
    const blocks = [
      { key: "b0", x0: 0, y0: 0, w: 2, h: 2, offset: 0, byteCount: 4 },
      { key: "b1", x0: 2, y0: 0, w: 2, h: 2, offset: 4, byteCount: 4 },
      { key: "b2", x0: 4, y0: 0, w: 2, h: 2, offset: 8, byteCount: 4 }
    ];
    const source = createRawBlockSource({
      bytes: [1, 2, 7, 8, 3, 4, 9, 10, 5, 6, 11, 12],
      meta,
      bandSpecs: [{
        kind: "raw",
        table,
        blocks,
        sampleByteOffset: 0,
        bytesPerSample: 1,
        bytesPerPixel: 1,
        channel: 0
      }]
    });

    try {
      const result = await withTimeout(source.readBandWindow(meta, 0, 0, 0, 6, 2, 1), 1000);
      expect(result).not.toBe("timeout");
      expect(Array.from(result)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    } finally {
      source.close();
    }
  });

  test("raw tiled composite reads do not deadlock nested scheduler work", async () => {
    const meta = {
      samples: 6,
      lines: 2,
      bands: 3,
      interleave: "bip",
      littleEndian: true,
      dataType: 1,
      dataTypeInfo: DATA_TYPES.get(1)
    };
    const table = {
      blockWidth: 2,
      blockHeight: 2,
      numBlocksX: 3,
      numBlocksY: 1,
      summary: { compression: 1 }
    };
    const blocks = [
      { key: "b0", x0: 0, y0: 0, w: 2, h: 2, offset: 0, byteCount: 12 },
      { key: "b1", x0: 2, y0: 0, w: 2, h: 2, offset: 12, byteCount: 12 },
      { key: "b2", x0: 4, y0: 0, w: 2, h: 2, offset: 24, byteCount: 12 }
    ];
    const bytes = [
      10, 101, 201, 20, 102, 202, 70, 107, 207, 80, 108, 208,
      30, 103, 203, 40, 104, 204, 90, 109, 209, 100, 110, 210,
      50, 105, 205, 60, 106, 206, 110, 111, 211, 120, 112, 212
    ];
    const bandSpecs = [0, 1, 2].map((channel) => ({
      kind: "raw",
      table,
      blocks,
      sampleByteOffset: channel,
      bytesPerSample: 1,
      bytesPerPixel: 3,
      channel
    }));
    const source = createRawBlockSource({ bytes, meta, bandSpecs });

    try {
      const result = await withTimeout(source.readCompositeWindow(meta, 0, 0, 6, 2, 1), 1000);
      expect(result).not.toBe("timeout");
      expect(Array.from(result.bands[0])).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
      expect(Array.from(result.bands[1])).toEqual([101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112]);
      expect(Array.from(result.bands[2])).toEqual([201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212]);
    } finally {
      source.close();
    }
  });

  test("raw tiled composite preview averages coarse RGB samples instead of nearest-picking one column", async () => {
    const meta = {
      samples: 4,
      lines: 1,
      bands: 3,
      interleave: "bip",
      littleEndian: true,
      dataType: 1,
      dataTypeInfo: DATA_TYPES.get(1)
    };
    const table = {
      blockWidth: 2,
      blockHeight: 1,
      numBlocksX: 2,
      numBlocksY: 1,
      summary: { compression: 1 }
    };
    const blocks = [
      { key: "b0", x0: 0, y0: 0, w: 2, h: 1, offset: 0, byteCount: 6 },
      { key: "b1", x0: 2, y0: 0, w: 2, h: 1, offset: 6, byteCount: 6 }
    ];
    const bytes = [
      255, 0, 0, 0, 255, 0,
      255, 0, 0, 0, 255, 0
    ];
    const bandSpecs = [0, 1, 2].map((channel) => ({
      kind: "raw",
      table,
      blocks,
      sampleByteOffset: channel,
      bytesPerSample: 1,
      bytesPerPixel: 3,
      channel
    }));
    const source = createRawBlockSource({ bytes, meta, bandSpecs });

    try {
      const result = await source.readCompositeWindow(meta, 0, 0, 2, 1, 2);
      expect(Array.from(result.bands[0])).toEqual([127.5, 127.5]);
      expect(Array.from(result.bands[1])).toEqual([127.5, 127.5]);
      expect(Array.from(result.bands[2])).toEqual([0, 0]);
    } finally {
      source.close();
    }
  });
});
