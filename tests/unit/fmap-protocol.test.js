import { describe, expect, test } from "vitest";
import {
  assertFmapBsqFloat32Meta,
  assertSafeFileInteger,
  checkedAdd,
  expectedEnviPayloadBytes,
  normalizeFmapWindow
} from "../../src/io/fmap/protocol.js";

function meta(overrides = {}) {
  return {
    samples: 4,
    lines: 3,
    bands: 2,
    headerOffset: 16,
    interleave: "bsq",
    dataType: 4,
    littleEndian: true,
    dataTypeInfo: { bytes: 4 },
    ...overrides
  };
}

describe("fmap protocol", () => {
  test("preserves exact browser file offsets beyond 4 GiB", () => {
    const offset = (5 * 1024 * 1024 * 1024) + 37;
    expect(assertSafeFileInteger(offset)).toBe(offset);
    expect(checkedAdd(offset, 4096)).toBe(offset + 4096);
    expect(() => checkedAdd(Number.MAX_SAFE_INTEGER, 1)).toThrow(/exact integer range/);
    expect(() => assertSafeFileInteger(1.5)).toThrow(/safe integer/);
  });

  test("validates BSQ Float32 payload length without allocating it", () => {
    const m = meta();
    expect(expectedEnviPayloadBytes(m)).toBe(112);
    expect(assertFmapBsqFloat32Meta(m, 112)).toBe(112);
    expect(() => assertFmapBsqFloat32Meta(m, 111)).toThrow(/Truncated ENVI data/);
    expect(() => assertFmapBsqFloat32Meta(meta({ interleave: "bip" }), 112)).toThrow(/BSQ Float32/);
  });

  test("normalizes a strided window at the dataset boundary", () => {
    expect(normalizeFmapWindow(meta(), 1, 1, 4, 4, 2)).toEqual({
      x0: 1,
      y0: 1,
      outW: 2,
      outH: 1,
      requestedW: 4,
      requestedH: 4,
      step: 2
    });
  });

  test("rejects zero dimensions and non-finite or overflowing result requests", () => {
    expect(() => assertFmapBsqFloat32Meta(meta({ samples: 0 }), 112)).toThrow(/positive/);
    expect(() => normalizeFmapWindow(meta(), 0, 0, Infinity, 1, 1)).toThrow(/safe integer/);
    expect(() => normalizeFmapWindow(meta(), 0, 0, 1, 1, Infinity)).toThrow(/safe integer/);
    expect(() => normalizeFmapWindow(meta(), 0, 0, Number.MAX_SAFE_INTEGER, 4, 1)).toThrow(/exact integer/);
  });
});
