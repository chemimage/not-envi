import { deflateSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { decodeBoundedTiffBlock, estimateBoundedTiffScratchBytes } from "../../src/io/fmap/tiff-codecs.js";

const bytes = (buffer) => Array.from(new Uint8Array(buffer));

describe("libtiff bounded codec bridge", () => {
  test("decodes PackBits through the production asynchronous API", async () => {
    expect(bytes(await decodeBoundedTiffBlock({ Compression: 32773 }, Uint8Array.from([3, 2, 4, 6, 8]), 4))).toEqual([2, 4, 6, 8]);
  });

  test("decodes Deflate into its exact caller-owned reservation", async () => {
    const source = Uint8Array.from({ length: 70000 }, (_, index) => index & 255);
    expect(new Uint8Array(await decodeBoundedTiffBlock({ Compression: 8 }, deflateSync(source), source.length))).toEqual(source);
  });

  test("preserves big-endian file byte order after predictor restoration", async () => {
    const encoded = deflateSync(Uint8Array.from([1, 2, 2, 3, 1, 4]));
    expect(bytes(await decodeBoundedTiffBlock({ Compression: 8, Predictor: 2, BitsPerSample: [16],
      SamplesPerPixel: 1, ImageWidth: 3 }, encoded, 6, { littleEndian: false })))
      .toEqual([1, 2, 3, 5, 4, 9]);
  });

  test("rejects truncated compressed input", async () => {
    await expect(decodeBoundedTiffBlock({ Compression: 8 }, Uint8Array.from([1, 2, 3]), 4)).rejects.toThrow();
  });

  test.each([true, false])("restores Float32 predictor-3 output in file byte order (LE=%s)", async (littleEndian) => {
    const planes = [0x3f, 0x40, 0x80, 0, 0, 0, 0, 0];
    const delta = Uint8Array.from(planes, (value, i) => i ? (value - planes[i - 1]) & 255 : value);
    const output = await decodeBoundedTiffBlock({ Compression: 8, Predictor: 3, BitsPerSample: [32],
      SamplesPerPixel: 1, SampleFormat: [3], ImageWidth: 2 }, deflateSync(delta), 8, { littleEndian });
    const view = new DataView(output);
    expect([view.getFloat32(0, littleEndian), view.getFloat32(4, littleEndian)]).toEqual([1, 2]);
  });

  test("rejects oversized blocks and cancellation before allocating WASM", async () => {
    await expect(decodeBoundedTiffBlock({}, new Uint8Array(1), 33 * 1024 * 1024)).rejects.toThrow(/32 MiB/);
    await expect(decodeBoundedTiffBlock({}, new Uint8Array(1), 1, { cancelled: () => true })).rejects.toMatchObject({ name: "AbortError" });
  });

  test("charges WASM private buffers to decoder admission", () => {
    expect(estimateBoundedTiffScratchBytes({ Compression: 8 }, 1024, 256)).toBe(4 * 1024 * 1024 + 2048 + 256);
  });
});
