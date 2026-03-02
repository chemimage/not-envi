import { describe, expect, test } from "vitest";
import {
  applyHistogramDragSetting,
  histogramClientXToRaw,
  histogramHandleXs,
  histogramPlotRect,
  pickHistogramHandle,
  resolveHistogramDisplay
} from "../../src/render/histogram-math.js";

describe("histogram-math", () => {
  test("resolve display falls back to p1/p99", () => {
    const stats = { min: 0, max: 100, p1: 5, p99: 95 };
    const s = { min: null, max: null, gamma: undefined, gain: undefined, contrast: undefined };
    expect(resolveHistogramDisplay(stats, s)).toEqual({
      domMin: 0,
      domMax: 100,
      minVal: 5,
      maxVal: 95,
      gamma: 1,
      gain: 1,
      contrast: 1
    });
  });

  test("handle positions and pick logic", () => {
    const plot = histogramPlotRect(400, 200, 1);
    const { xMin, xMid, xMax } = histogramHandleXs(plot, 0, 100, 20, 80, 1);
    expect(xMin).toBeLessThan(xMid);
    expect(xMid).toBeLessThan(xMax);

    expect(pickHistogramHandle(plot, xMin + 1, plot.plotY0 + plot.plotH + 4, xMin, xMid, xMax, 1)).toBe("min");
    expect(pickHistogramHandle(plot, xMid + 1, plot.plotY0 + plot.plotH + 4, xMin, xMid, xMax, 1)).toBe("mid");
    expect(pickHistogramHandle(plot, xMax + 1, plot.plotY0 + plot.plotH + 4, xMin, xMid, xMax, 1)).toBe("max");
  });

  test("clientX maps to raw domain", () => {
    const stats = { min: 10, max: 30 };
    expect(histogramClientXToRaw(stats, 10, 10, 1, 200)).toBeCloseTo(10);
    expect(histogramClientXToRaw(stats, 200, 10, 1, 200)).toBeCloseTo(30);
  });

  test("drag setting computes min/max/gamma patch", () => {
    const stats = { min: 0, max: 100, p1: 10, p99: 90 };
    const settings = { min: null, max: null, gamma: 1 };

    const minPatch = applyHistogramDragSetting(stats, settings, "min", 20);
    expect(minPatch.min).toBe(20);

    const maxPatch = applyHistogramDragSetting(stats, settings, "max", 80);
    expect(maxPatch.max).toBe(80);

    const midPatch = applyHistogramDragSetting(stats, settings, "mid", 60);
    expect(midPatch.gamma).toBeGreaterThan(0.1);
    expect(midPatch.gamma).toBeLessThanOrEqual(5);
  });
});
