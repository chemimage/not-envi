import { describe, expect, test } from "vitest";
import { encodeTIFF_MultiPage_GrayRaw, encodeTIFF_RGBA8 } from "../../src/core/tiff-encoder.js";

describe("tiff encoder", () => {
  test("encodeTIFF_RGBA8 creates tiff header", async () => {
    const imageData = {
      width: 2,
      height: 1,
      data: Uint8ClampedArray.from([255, 0, 0, 255, 0, 255, 0, 255])
    };
    const blob = encodeTIFF_RGBA8(imageData);
    const u8 = new Uint8Array(await blob.arrayBuffer());
    expect(u8[0]).toBe(0x49);
    expect(u8[1]).toBe(0x49);
    expect(u8[2]).toBe(42);
    expect(u8.length).toBeGreaterThan(8);
  });

  test("encodeTIFF_MultiPage_GrayRaw returns non-empty blob", async () => {
    const meta = { dataType: 4, dataTypeInfo: { bytes: 4 } };
    const pages = [new Float32Array([1, 2, 3, 4]), new Float32Array([5, 6, 7, 8])];
    const blob = encodeTIFF_MultiPage_GrayRaw(meta, 2, 2, pages);
    const u8 = new Uint8Array(await blob.arrayBuffer());
    expect(u8[0]).toBe(0x49);
    expect(u8[1]).toBe(0x49);
    expect(u8.length).toBeGreaterThan(32);
  });
});
