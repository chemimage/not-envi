import { describe, expect, test } from "vitest";
import {
  assertFmapEnviMeta,
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

  test("validates every supported ENVI layout and numeric type without allocating payloads", () => {
    const m = meta();
    expect(expectedEnviPayloadBytes(m)).toBe(112);
    expect(assertFmapBsqFloat32Meta(m, 112)).toBe(112);
    expect(() => assertFmapBsqFloat32Meta(m, 111)).toThrow(/Truncated ENVI data/);
    const types = [[1, 1], [2, 2], [3, 4], [4, 4], [5, 8], [12, 2], [13, 4], [14, 8], [15, 8]];
    for (const interleave of ["bsq", "bil", "bip"]) {
      for (const [dataType, bytes] of types) {
        const candidate = meta({ interleave, dataType, dataTypeInfo: { bytes } });
        expect(assertFmapEnviMeta(candidate, expectedEnviPayloadBytes(candidate))).toBe(expectedEnviPayloadBytes(candidate));
      }
    }
    expect(() => assertFmapEnviMeta(meta({ dataType: 6 }), 112)).toThrow(/data type/);
    expect(() => assertFmapEnviMeta(meta({ interleave: "bad" }), 112)).toThrow(/interleave/);
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
