import { Blob as NodeBlob } from "node:buffer";
import { describe, expect, test, vi } from "vitest";
import { openTiffBackend } from "../../src/io/tiff/backend/index.js";

describe("native TIFF metadata bounds", () => {
  test("rejects a forged BigTIFF directory count before allocating its table", async () => {
    const bytes = new Uint8Array(24);
    const view = new DataView(bytes.buffer);
    bytes.set([0x49, 0x49]);
    view.setUint16(2, 43, true);
    view.setUint16(4, 8, true);
    view.setBigUint64(8, 16n, true);
    view.setBigUint64(16, 1_000_000n, true);
    const file = new NodeBlob([bytes], { type: "image/tiff" });
    await expect(openTiffBackend(file)).rejects.toThrow(/directory|metadata|limit/i);
  });

  test("rejects an oversized known tag value before reading its payload", async () => {
    const blocks = 5_000_000;
    const tags = [[256, 4, 1, 1], [257, 4, 1, blocks], [258, 3, 1, 8], [259, 3, 1, 1],
      [262, 3, 1, 1], [273, 4, blocks, 256], [277, 3, 1, 1], [278, 4, 1, 1],
      [279, 4, blocks, 256 + blocks * 4], [284, 3, 1, 1]];
    const bytes = new Uint8Array(256);
    const view = new DataView(bytes.buffer);
    bytes.set([0x49, 0x49]);
    view.setUint16(2, 42, true);
    view.setUint32(4, 8, true);
    view.setUint16(8, tags.length, true);
    tags.forEach(([tag, type, count, value], i) => {
      const at = 10 + i * 12;
      view.setUint16(at, tag, true); view.setUint16(at + 2, type, true);
      view.setUint32(at + 4, count, true); view.setUint32(at + 8, value, true);
    });
    const read = vi.fn(async (offset, count) => bytes.slice(offset, offset + count));
    await expect(openTiffBackend({ size: 256 + blocks * 8 }, { tiffFmapRangeSource: { read } }))
      .rejects.toThrow(/alloc|memory|limit|StripOffsets|directory/i);
    expect(read.mock.calls.every(([offset, count]) => offset + count <= bytes.length)).toBe(true);
  });

  test("rejects a forged scalar SamplesPerPixel before expanding sample arrays", async () => {
    const bytes = new Uint8Array(26);
    const view = new DataView(bytes.buffer);
    bytes.set([0x49, 0x49]);
    view.setUint16(2, 42, true);
    view.setUint32(4, 8, true);
    view.setUint16(8, 1, true);
    view.setUint16(10, 277, true);
    view.setUint16(12, 4, true);
    view.setUint32(14, 1, true);
    view.setUint32(18, 1_000_000, true);
    view.setUint32(22, 0, true);
    const file = new NodeBlob([bytes], { type: "image/tiff" });
    await expect(openTiffBackend(file)).rejects.toThrow(/SamplesPerPixel/i);
  });
});
