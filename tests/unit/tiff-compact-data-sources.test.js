import { deflateSync } from "node:zlib";
import { afterEach, expect, test, vi } from "vitest";
import { DATA_TYPES } from "../../src/core/envi-types.js";
import { FmapTiffDataSource } from "../../src/io/fmap/tiff-range-source.js";
import { buildRawBandSpecs, TiffBlockIndexedDataSource } from "../../src/io/tiff/data-sources.js";
import { resetTiffConcurrencyForTests } from "../../src/io/tiff/scheduler.js";

afterEach(() => resetTiffConcurrencyForTests());

function imageMeta(width, height, bands = 1, dataType = 1) {
  return { samples: width, lines: height, bands, interleave: "bsq", littleEndian: true,
    dataType, dataTypeInfo: DATA_TYPES.get(dataType) };
}

function rangeSource(bytes) {
  return new FmapTiffDataSource({ size: bytes.length, ready: Promise.resolve(), ownerId: "compact-tiff-test",
    stats: {}, readRange: async (offset, length) => bytes.slice(offset, offset + length),
    cacheBytes: () => 0, clear() {}, close() {} }, { maxWorkingSetBytes: 256 * 1024 });
}

function sourceFor(bytes, meta, bandSpecs, options = {}) {
  return new TiffBlockIndexedDataSource({ file: new File([bytes], "compact.tif"), tiff: null, meta, bandSpecs,
    budgets: { rawCacheBytes: 1 << 20, decodedCacheBytes: 1 << 20 }, ...options });
}

test("a small window in a many-tile TIFF creates descriptors only for its intersecting tiles", async () => {
  const count = 65536;
  const bytes = Uint8Array.from({ length: count }, (_value, index) => index % 251);
  const offsets = Uint32Array.from({ length: count }, (_value, index) => index);
  const summary = { image: {}, width: count, height: 1, samplesPerPixel: 1, planarConfiguration: 1,
    compression: 1, tileOffsets: offsets, stripOffsets: [], stripByteCounts: [],
    fileDirectory: { TileWidth: 1, TileLength: 1, TileByteCounts: new Uint32Array(count).fill(1) } };
  const meta = imageMeta(count, 1);
  const specs = buildRawBandSpecs(summary, { dataTypeInfo: meta.dataTypeInfo });
  const blocks = specs[0].blocks;
  expect(Array.isArray(blocks)).toBe(false);
  expect(blocks.length).toBe(count);
  const at = vi.fn((index) => blocks.at(index));
  specs[0].blocks = { length: blocks.length, at };
  const source = sourceFor(bytes, meta, specs);
  try {
    expect(Array.from(await source.readBandWindow(meta, 0, count - 3, 0, 3, 1, 1)))
      .toEqual(Array.from(bytes.subarray(count - 3)));
    expect(at.mock.calls.map(([index]) => index)).toEqual([count - 3, count - 2, count - 1]);
  } finally { source.close(); }
});

test.each([1, 2])("compact tile planes preserve RGB edge values with planar configuration %s", async (planarConfiguration) => {
  const width = 3, height = 3, bands = 3, blockSize = 2;
  const groups = planarConfiguration === 2 ? bands : 1;
  const bytes = [], offsets = [], byteCounts = [];
  const value = (band, x, y) => band * 50 + y * width + x + 1;
  for (let group = 0; group < groups; group += 1) {
    for (let by = 0; by < 2; by += 1) for (let bx = 0; bx < 2; bx += 1) {
      offsets.push(bytes.length);
      for (let y = 0; y < blockSize; y += 1) for (let x = 0; x < blockSize; x += 1) {
        const sourceX = bx * blockSize + x, sourceY = by * blockSize + y;
        for (let sample = 0; sample < (planarConfiguration === 2 ? 1 : bands); sample += 1) {
          bytes.push(sourceX < width && sourceY < height ? value(planarConfiguration === 2 ? group : sample, sourceX, sourceY) : 0);
        }
      }
      byteCounts.push(bytes.length - offsets.at(-1));
    }
  }
  const summary = { image: {}, width, height, samplesPerPixel: bands, planarConfiguration,
    compression: 1, tileOffsets: offsets, stripOffsets: [], stripByteCounts: [],
    fileDirectory: { TileWidth: blockSize, TileLength: blockSize, TileByteCounts: byteCounts } };
  const meta = imageMeta(width, height, bands);
  const specs = buildRawBandSpecs(summary, { dataTypeInfo: meta.dataTypeInfo });
  expect(specs[0].blocks === specs[1].blocks).toBe(planarConfiguration === 1);
  const source = sourceFor(Uint8Array.from(bytes), meta, specs);
  try {
    const result = await source.readCompositeWindow(meta, 0, 0, width, height, 1);
    for (let band = 0; band < bands; band += 1) {
      expect(Array.from(result.bands[band])).toEqual(Array.from({ length: width * height }, (_v, index) => value(band, index % width, Math.floor(index / width))));
    }
    expect(Array.from(await source.readSpectrumAtPixel(meta, 2, 2))).toEqual([9, 59, 109]);
  } finally { source.close(); }
});

test("compact compressed strips retain actual final-strip geometry", async () => {
  const first = new Uint8Array(deflateSync(Uint8Array.from([1, 2, 3, 4])));
  const last = new Uint8Array(deflateSync(Uint8Array.from([5, 6])));
  const bytes = new Uint8Array(first.length + last.length);
  bytes.set(first); bytes.set(last, first.length);
  const summary = { image: {}, width: 2, height: 3, samplesPerPixel: 1, planarConfiguration: 1,
    compression: 8, rowsPerStrip: 2, tileOffsets: [], stripOffsets: [0, first.length], stripByteCounts: [first.length, last.length],
    fileDirectory: { Compression: 8, Predictor: 1, BitsPerSample: [8], SamplesPerPixel: 1,
      PlanarConfiguration: 1, ImageWidth: 2, ImageLength: 3, RowsPerStrip: 2 } };
  const meta = imageMeta(2, 3);
  const specs = buildRawBandSpecs(summary, { dataTypeInfo: meta.dataTypeInfo });
  const source = sourceFor(bytes, meta, specs, { rangeSource: rangeSource(bytes) });
  try {
    expect(Array.from(await source.readBandWindow(meta, 0, 0, 0, 2, 3, 1))).toEqual([1, 2, 3, 4, 5, 6]);
  } finally { source.close(); }
});

function overview(scale, marker, samples = 1) {
  return { image: { readRasters: vi.fn(async () => new Uint8Array([marker])) }, width: 1, height: 1,
    scale, scaleX: scale, scaleY: scale, samplesPerPixel: samples, planarConfiguration: 1,
    photometricInterpretation: 1, compression: 1, rowsPerStrip: 1, tileOffsets: [],
    stripOffsets: [0], stripByteCounts: [1], fileDirectory: { BitsPerSample: [8], SampleFormat: [1] } };
}

function baseSpecs(meta) {
  return Array.from({ length: meta.bands }, (_value, band) => ({ kind: "raw",
    table: { blockWidth: meta.samples, blockHeight: meta.lines, numBlocksX: 1, numBlocksY: 1, summary: { compression: 1 } },
    blocks: [{ key: `base${band}`, x0: 0, y0: 0, w: meta.samples, h: meta.lines, offset: band, byteCount: 1 }],
    bytesPerPixel: 1, bytesPerSample: 1, sampleByteOffset: 0, channel: band }));
}

test("binary overview selection preserves exact, intermediate and finest-fallback behavior", async () => {
  const meta = imageMeta(16, 16);
  const summaries = [overview(4, 40), overview(2, 20), overview(4, 41), overview(8, 80)];
  const source = sourceFor(new Uint8Array(1), meta, baseSpecs(meta), { overviewSummaries: summaries });
  try {
    for (const [step, expected] of [[1.5, 20], [3, 20], [4, 41], [7, 41], [8, 80], [16, 80]]) {
      expect(Array.from(await source.readBandWindow(meta, 0, 0, 0, 1, 1, step))).toEqual([expected]);
    }
  } finally { source.close(); }
});

test("many overview levels are searched logarithmically", async () => {
  const meta = imageMeta(4096, 4096);
  const summaries = Array.from({ length: 1024 }, (_value, index) => overview(index + 2, index % 251));
  const source = sourceFor(new Uint8Array(1), meta, baseSpecs(meta), { overviewSummaries: summaries });
  let scaleReads = 0;
  for (const plan of source.overviews) {
    const scale = plan.scale;
    Object.defineProperty(plan, "scale", { get: () => { scaleReads += 1; return scale; } });
  }
  try {
    expect(Array.from(await source.readBandWindow(meta, 0, 0, 0, 1, 1, 513))).toEqual([511 % 251]);
    expect(scaleReads).toBeLessThanOrEqual(11);
  } finally { source.close(); }
});

test("grayscale page bands select independent overview families and sample zero", async () => {
  const meta = imageMeta(8, 8, 3);
  const summaries = [overview(2, 21), overview(2, 42), overview(2, 63)];
  const source = sourceFor(new Uint8Array(3), meta, baseSpecs(meta), { bandOverviewSummaries: summaries.map((summary) => [summary]) });
  try {
    expect(source.hasNativeOverviews()).toBe(true);
    expect(source.overviewCount).toBe(3);
    for (let band = 0; band < 3; band += 1) {
      expect(Array.from(await source.readBandWindow(meta, band, 0, 0, 1, 1, 2))).toEqual([(band + 1) * 21]);
      expect(summaries[band].image.readRasters).toHaveBeenCalledWith(expect.objectContaining({ samples: [0] }));
    }
  } finally { source.close(); }
});

test("a fmap overview resolves and leases a sampled block once for all its output pixels", async () => {
  const meta = imageMeta(64, 64);
  const bytes = Uint8Array.from({ length: 1025 }, (_value, index) => index % 251);
  const summary = { ...overview(2, 0), width: 32, height: 32, rowsPerStrip: 32,
    stripOffsets: [1], stripByteCounts: [1024],
    fileDirectory: { Compression: 1, Predictor: 1, BitsPerSample: [8], SampleFormat: [1], SamplesPerPixel: 1,
      PlanarConfiguration: 1, ImageWidth: 32, ImageLength: 32, RowsPerStrip: 32 } };
  const source = sourceFor(bytes, meta, baseSpecs(meta), { overviewSummaries: [summary], rangeSource: rangeSource(bytes) });
  const spec = source.overviews[0].fmapSpecs[0];
  const blocks = spec.blocks;
  const at = vi.fn((index) => blocks.at(index));
  spec.blocks = { length: blocks.length, at };
  try {
    const output = await source.readBandWindow(meta, 0, 0, 0, 32, 32, 2);
    expect(Array.from(output)).toEqual(Array.from(bytes.subarray(1)));
    expect(at).toHaveBeenCalledTimes(1);
    expect(source.stats.decodedCacheHits).toBe(0);
    expect(source.rawSource.stats.blockReads).toBe(1);
  } finally { source.close(); }
});

test("blockwise fmap overview reads preserve fractional scales, skipped samples and edge tiles", async () => {
  const meta = imageMeta(8, 8);
  const bytes = [], offsets = [];
  for (let by = 0; by < 3; by += 1) for (let bx = 0; bx < 3; bx += 1) {
    offsets.push(bytes.length);
    for (let y = 0; y < 2; y += 1) for (let x = 0; x < 2; x += 1) {
      const sx = bx * 2 + x, sy = by * 2 + y;
      bytes.push(sx < 5 && sy < 5 ? sy * 5 + sx + 1 : 0);
    }
  }
  const summary = { ...overview(1.6, 0), width: 5, height: 5, tileOffsets: offsets,
    fileDirectory: { Compression: 1, Predictor: 1, BitsPerSample: [8], SampleFormat: [1], SamplesPerPixel: 1,
      PlanarConfiguration: 1, ImageWidth: 5, ImageLength: 5, TileWidth: 2, TileLength: 2, TileByteCounts: new Uint32Array(9).fill(4) } };
  const data = Uint8Array.from(bytes);
  const source = sourceFor(data, meta, baseSpecs(meta), { overviewSummaries: [summary], rangeSource: rangeSource(data) });
  const spec = source.overviews[0].fmapSpecs[0];
  const blocks = spec.blocks;
  const at = vi.fn((index) => blocks.at(index));
  spec.blocks = { length: blocks.length, at };
  try {
    const expected = [];
    for (let row = 0; row < 4; row += 1) for (let col = 0; col < 4; col += 1) {
      expected.push(Math.floor((1 + row * 2) / 1.6) * 5 + Math.floor((1 + col * 2) / 1.6) + 1);
    }
    expect(Array.from(await source.readBandWindow(meta, 0, 1, 1, 4, 4, 2))).toEqual(expected);
    expect(at.mock.calls.map(([index]) => index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(source.stats.decodedCacheHits).toBe(0);
  } finally { source.close(); }
});

test("fmap grayscale page bands use their own compact overview plane zero", async () => {
  const meta = imageMeta(4, 4, 2);
  const bytes = Uint8Array.from([0, 11, 22]);
  const summaries = [1, 2].map((offset) => ({ ...overview(4, 0), stripOffsets: [offset],
    fileDirectory: { Compression: 1, Predictor: 1, BitsPerSample: [8], SampleFormat: [1], SamplesPerPixel: 1,
      PlanarConfiguration: 1, ImageWidth: 1, ImageLength: 1, RowsPerStrip: 1 } }));
  const source = sourceFor(bytes, meta, baseSpecs(meta), {
    bandOverviewSummaries: summaries.map((summary) => [summary]), rangeSource: rangeSource(bytes)
  });
  try {
    expect(Array.from(await source.readBandWindow(meta, 0, 0, 0, 1, 1, 4))).toEqual([11]);
    expect(Array.from(await source.readBandWindow(meta, 1, 0, 0, 1, 1, 4))).toEqual([22]);
  } finally { source.close(); }
});
