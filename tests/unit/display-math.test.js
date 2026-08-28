import { describe, expect, test } from "vitest";
import {
  computeHistogram,
  percentileFromHist,
  quickStatsFromArray,
  resolveDisplayRange,
  tone01,
  typeDefaultRange
} from "../../src/render/display-math.js";

describe("display-math", () => {
  test("quickStatsFromArray ignores non-finite values", () => {
    const s = quickStatsFromArray([1, 2, Number.NaN, Number.POSITIVE_INFINITY, -1]);
    expect(s).toEqual({ min: -1, max: 2, count: 3 });
  });

  test("computeHistogram returns percentiles and bins", () => {
    const h = computeHistogram([0, 1, 2, 3, 4], 5);
    expect(h.count).toBe(5);
    expect(Array.from(h.bins)).toEqual([1, 1, 1, 1, 1]);
    expect(h.p1).toBeGreaterThanOrEqual(0);
    expect(h.p99).toBeLessThanOrEqual(4);
    expect(h.rms).toBeCloseTo(Math.sqrt(6));
  });

  test("percentileFromHist handles empty total", () => {
    expect(percentileFromHist(new Uint32Array([0, 0]), 10, 20, 0.5, 0)).toBe(10);
  });

  test("tone01 clamps and applies brightness/gain/contrast", () => {
    const t = tone01(0.5, 0, 1, 0, 1, 1);
    expect(t).toBeCloseTo(0.5);
    expect(tone01(-10, 0, 1, 0, 1, 1)).toBe(0);
    expect(tone01(10, 0, 1, 0, 1, 1)).toBe(1);
  });

  test("typeDefaultRange maps known ENVI types", () => {
    expect(typeDefaultRange({ dataType: 1 })).toEqual({ min: 0, max: 255 });
    expect(typeDefaultRange({ dataType: 2 })).toEqual({ min: -32768, max: 32767 });
    expect(typeDefaultRange({ dataType: 4 })).toEqual({ min: null, max: null });
  });

  test("resolveDisplayRange prefers explicit settings, then stats/fallbacks", () => {
    const ds = {
      meta: { dataType: 1 },
      bandStatsWhole: new Map([[0, { p1: 11, p99: 22 }]]),
      bandStatsView: null
    };
    const getBandSettings = () => ({ min: null, max: null });
    const r = resolveDisplayRange(ds, 0, null, getBandSettings);
    expect(r).toEqual({ minVal: 11, maxVal: 22 });
  });
});
