import { beforeEach, describe, expect, test, vi } from "vitest";

const codecState = vi.hoisted(() => ({ calls: [] }));

vi.mock("../../src/io/fmap/tiff-codecs.js", () => ({
  estimateBoundedTiffScratchBytes: () => 0,
  decodeBoundedTiffBlock: vi.fn((_directory, _buffer, _expected, options = {}) => new Promise((resolve, reject) => {
    const signals = [options.signal, ...(options.signals || [])].filter(Boolean);
    const call = { signals, resolve, reject };
    codecState.calls.push(call);
    const onAbort = () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    };
    for (const signal of signals) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  }))
}));

import { DATA_TYPES } from "../../src/core/envi-types.js";
import { FmapTiffDataSource } from "../../src/io/fmap/tiff-range-source.js";
import { TiffBlockIndexedDataSource } from "../../src/io/tiff/data-sources.js";

class RangeSource {
  constructor() {
    this.size = 2;
    this.pageSize = 4096;
    this.maxBytes = 4096;
    this.ownerId = "codec-generation";
    this.ready = Promise.resolve(this);
  }

  async readRange() { return Uint8Array.from([0, 7]); }
  clear() {}
  close() {}
  cacheBytes() { return 0; }
  async getStats() { return {}; }
}

function harness() {
  const range = new FmapTiffDataSource(new RangeSource(), {
    maxWorkingSetBytes: 1024,
    maxRetainedBytes: 16
  });
  const meta = {
    samples: 1, lines: 1, bands: 1, interleave: "bsq", littleEndian: true,
    dataType: 1, dataTypeInfo: DATA_TYPES.get(1)
  };
  const table = {
    isTiled: false, blockWidth: 1, blockHeight: 1, numBlocksX: 1, numBlocksY: 1,
    summary: { compression: 32773, fileDirectory: {
      Compression: 32773, BitsPerSample: [8], SamplesPerPixel: 1, PlanarConfiguration: 1
    } }
  };
  const source = new TiffBlockIndexedDataSource({
    file: new File([Uint8Array.from([0, 7])], "generation.tif"), tiff: null, meta, rangeSource: range,
    bandSpecs: [{ kind: "raw", table,
      blocks: [{ key: "generation", x0: 0, y0: 0, w: 1, h: 1, offset: 0, byteCount: 2 }],
      sampleByteOffset: 0, bytesPerSample: 1, bytesPerPixel: 1, channel: 0 }],
    budgets: { rawCacheBytes: 0, decodedCacheBytes: 16 }
  });
  return { source, meta };
}

beforeEach(() => { codecState.calls.length = 0; });

describe("TIFF codec generation cancellation", () => {
  test.each(["clear", "close"])("%s aborts a codec worker owned by the old datasource generation", async (action) => {
    const { source, meta } = harness();
    const pending = source.readBandWindow(meta, 0, 0, 0, 1, 1, 1);
    while (codecState.calls.length === 0) await Promise.resolve();
    expect(codecState.calls[0].signals.some((signal) => signal.aborted)).toBe(false);

    source[action]();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(codecState.calls[0].signals.some((signal) => signal.aborted)).toBe(true);
    if (action === "clear") source.close();
  });
});
