import { readFileSync } from "node:fs";
import { Blob as NodeBlob } from "node:buffer";
import { describe, expect, test } from "vitest";
import { openNativeTiffBackend } from "../../src/io/tiff/backend/native-backend.js";
import { decodeBoundedTiffBlock } from "../../src/io/fmap/tiff-codecs.js";
import { coalesceRawStrips } from "../../src/io/tiff/libtiff/raw-layout.js";

describe("libtiff application integration", () => {
  test("parses and decodes a standard-writer Float32 predictor-3 tile", async () => {
    const bytes = readFileSync("tests/fixtures/libtiff/float32-predictor3.tif");
    const backend = await openNativeTiffBackend(new NodeBlob([bytes]));
    try {
      const image = await backend.getImage(0), directory = image.getFileDirectory();
      expect(directory.Predictor).toBe(3);
      expect(directory.SampleFormat).toBe(3);
      const offset = directory.TileOffsets[0], count = directory.TileByteCounts[0];
      const output = new Float32Array(await decodeBoundedTiffBlock(directory, bytes.subarray(offset, offset + count), 128 * 128 * 4, { littleEndian: backend.littleEndian }));
      for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) expect(output[y * 128 + x]).toBe(x / 1024 + y / 2048);
    } finally { backend.close(); }
  });

  test("preserves exact BigTIFF block addresses above 4 GiB", async () => {
    const tags = [[256, 4, 1], [257, 4, 1], [258, 3, 8], [259, 3, 1], [262, 3, 1],
      [273, 16, 2 ** 32 + 4096], [277, 3, 1], [278, 4, 1], [279, 16, 1], [284, 3, 1]];
    const bytes = new Uint8Array(16 + 8 + tags.length * 20 + 8), view = new DataView(bytes.buffer);
    bytes.set([73, 73]); view.setUint16(2, 43, true); view.setUint16(4, 8, true); view.setBigUint64(8, 16n, true);
    view.setBigUint64(16, BigInt(tags.length), true);
    tags.forEach(([tag, type, value], i) => {
      const at = 24 + i * 20;
      view.setUint16(at, tag, true); view.setUint16(at + 2, type, true); view.setBigUint64(at + 4, 1n, true);
      view.setBigUint64(at + 12, BigInt(value), true);
    });
    const reads = [];
    const backend = await openNativeTiffBackend({ size: 2 ** 32 + 4097 }, { tiffFmapRangeSource: {
      read: async (offset, count) => { reads.push({ offset, count }); return bytes.slice(offset, offset + count); }
    } });
    try {
      expect(backend.bigTiff).toBe(true);
      expect((await backend.getImage(0)).getFileDirectory().StripOffsets[0]).toBe(2 ** 32 + 4096);
      expect(reads.every(({ offset, count }) => offset + count <= bytes.length)).toBe(true);
    } finally { backend.close(); }
  });

  test("opens a >2 GiB raw strip without reading pixels and preserves its linear range", async () => {
    const width = 37136, height = 26626, payload = width * height * 3;
    const tags = [[256, 4, width], [257, 4, height], [258, 3, 8], [259, 3, 1], [262, 3, 2],
      [273, 4, 65536], [277, 3, 3], [278, 4, height], [279, 4, payload], [284, 3, 1]];
    const bytes = new Uint8Array(8 + 2 + tags.length * 12 + 4), view = new DataView(bytes.buffer);
    bytes.set([73, 73]); view.setUint16(2, 42, true); view.setUint32(4, 8, true); view.setUint16(8, tags.length, true);
    tags.forEach(([tag, type, value], i) => {
      const at = 10 + i * 12;
      view.setUint16(at, tag, true); view.setUint16(at + 2, type, true); view.setUint32(at + 4, 1, true); view.setUint32(at + 8, value, true);
    });
    const reads = [];
    const backend = await openNativeTiffBackend({ size: 65536 + payload }, { tiffFmapRangeSource: {
      read: async (offset, count) => { reads.push({ offset, count }); return bytes.slice(offset, offset + count); }
    } });
    try {
      const directory = (await backend.getImage()).getFileDirectory();
      expect(Array.from(directory.StripOffsets)).toEqual([65536]);
      expect(Array.from(directory.StripByteCounts)).toEqual([payload]);
      expect(directory.RowsPerStrip).toBe(height);
      expect(reads.every(({ offset, count }) => offset + count <= bytes.length)).toBe(true);
    } finally { backend.close(); }
  });

  test.each(["gap", "padding", "separate-planes"])("does not coalesce raw %s layouts", (kind) => {
    const directory = { ImageWidth: 2, ImageLength: 2, BitsPerSample: 8, SamplesPerPixel: 1,
      Compression: 1, RowsPerStrip: 1, StripOffsets: [100, 102], StripByteCounts: [2, 2] };
    if (kind === "gap") directory.StripOffsets[1]++;
    if (kind === "padding") directory.StripByteCounts[0]++;
    if (kind === "separate-planes") { directory.PlanarConfiguration = 2; directory.SamplesPerPixel = 2; }
    coalesceRawStrips(directory, 1000);
    expect(directory.StripOffsets.length).toBe(2);
    expect(directory.RowsPerStrip).toBe(1);
  });
});
