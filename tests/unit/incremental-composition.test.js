import { describe, expect, test, vi } from "vitest";
import { CompositionCache, CompositionPlane } from "../../src/render/incremental-composition.js";
import { computeHistogram, histogramFromUint8Counts, tone01 } from "../../src/render/display-math.js";
import { createRgbCompositor } from "../../src/render/rgb-composition.js";

function apply(plane, tile, key, rect, factor = 1, x = 0, y = 0) {
  plane.begin(); plane.apply(tile, key, rect, factor, 0, 0, x, y); return plane.finish(plane.w * plane.h);
}

describe("incremental composition", () => {
  test("only changed tiles update pixels and exact uint8 histogram contributions", () => {
    const plane = new CompositionPlane("view", { w: 4, h: 4, idealLevel: 0 }, true);
    const coarse = { level: 1, w: 2, data: Float32Array.of(10, 20, 30, 40) };
    const initial = apply(plane, coarse, "coarse", { x: 0, y: 0, w: 4, h: 4 }, 2);
    expect(initial.histogramStats).toEqual(computeHistogram(plane.data));
    expect(plane.changedPixels).toBe(16);
    const frozenRange = initial.displayRangeStats;
    const fine = { level: 0, w: 2, data: Float32Array.of(1, 2, 3, 4) };
    const changed = apply(plane, fine, "fine", { x: 1, y: 1, w: 2, h: 2 }, 1, 1, 1);
    expect(plane.changedPixels).toBe(4);
    expect(changed.dirtyRects).toEqual([{ x: 1, y: 1, w: 2, h: 2 }]);
    expect(changed.previousRevision).toBe(initial.revision);
    expect(changed.histogramStats).toEqual(computeHistogram(plane.data));
    expect(changed.displayRangeStats).toBe(frozenRange);
    expect(plane.fineCount).toBe(4);
    const duplicate = apply(plane, fine, "fine", { x: 1, y: 1, w: 2, h: 2 }, 1, 1, 1);
    expect(duplicate.revision).toBe(changed.revision);
    expect(duplicate.dirtyRects).toEqual([]);
    expect(duplicate.histogramStats).toBe(changed.histogramStats);
    expect(plane.changedPixels).toBe(0);

    apply(plane, { level: 1, w: 2, data: new Float32Array(4).fill(99) }, "late-coarse",
      { x: 0, y: 0, w: 4, h: 4 }, 2);
    expect([plane.data[5], plane.data[6], plane.data[9], plane.data[10]]).toEqual([1, 2, 3, 4]);
    expect(plane.changedPixels).toBe(12);
    expect(plane.histogramStats).toEqual(computeHistogram(plane.data));
    const final = apply(plane, { level: 0, w: 4, data: Float32Array.from({ length: 16 }, (_, i) => i) }, "complete",
      { x: 0, y: 0, w: 4, h: 4 });
    expect(plane.fineCount).toBe(16);
    expect(final.displayRangeStats).toEqual(computeHistogram(plane.data));
  });

  test("uint8 frequency histograms match ordinary scans across observed ranges and missing data", () => {
    for (const values of [[], [7, 7, 7], [120, 122, 157, 191, 240, NaN],
      Array.from({ length: 20000 }, (_, i) => (Math.imul(i, 797) >>> 3) % 256)]) {
      const counts = new Uint32Array(256);
      for (const value of values) if (Number.isFinite(value)) counts[value] += 1;
      expect(histogramFromUint8Counts(counts)).toEqual(computeHistogram(values));
    }
  });

  test("floating-point previews use bounded estimates, then exact final statistics once", () => {
    const plane = new CompositionPlane("float", { w: 100, h: 100, idealLevel: 0 });
    const coarse = { level: 1, w: 50, data: Float32Array.from({ length: 2500 }, (_, i) => i / 7) };
    const preview = apply(plane, coarse, "coarse", { x: 0, y: 0, w: 100, h: 100 }, 2);
    expect(preview.histogramStats.count).toBeLessThanOrEqual(4096);
    const data = Float32Array.from({ length: 10000 }, (_, i) => i / 3);
    data[0] = NaN;
    const tile = { level: 0, w: 100, data };
    const final = apply(plane, tile, "final", { x: 0, y: 0, w: 100, h: 100 });
    expect(final.histogramStats).toEqual(computeHistogram(data));
    expect(final.displayRangeStats).toBe(final.histogramStats);
    expect(apply(plane, tile, "final", { x: 0, y: 0, w: 100, h: 100 }).histogramStats).toBe(final.histogramStats);
  });

  test("view identity, LRU budgets and clear release retained planes", () => {
    const cache = new CompositionCache(160);
    const geometry = { w: 4, h: 4, idealLevel: 0 };
    const first = cache.get("panel1:0", "viewA", geometry, false);
    expect(cache.get("panel1:0", "viewA", geometry, false)).toBe(first);
    const moved = cache.get("panel1:0", "viewB", geometry, false);
    expect(moved.id).not.toBe(first.id);
    expect(moved.data.every(Number.isNaN)).toBe(true);
    cache.get("panel2:0", "viewB", geometry, false);
    cache.get("panel2:1", "viewB", geometry, false);
    expect(cache.peek("panel1:0", "viewB")).toBeNull();
    expect(cache.bytes).toBe(160);
    cache.setLimit(0);
    expect(cache.bytes).toBe(0);
    expect(cache.entries.size).toBe(0);
    cache.get("oversized", "view", geometry, false);
    expect(cache.bytes).toBe(0);
    cache.clear();
  });
});

describe("incremental RGB", () => {
  test("patches dirty pixels, skips unchanged frames, and fully refreshes missed revisions/settings", () => {
    const puts = [];
    const compositor = createRgbCompositor({ tone01,
      createCanvas: () => ({ getContext: () => ({ putImageData: (...args) => puts.push(args) }) }),
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) });
    const rasters = [20, 40, 60].map((value, channel) => ({ compositionId: channel + 1, revision: 1,
      previousRevision: 0, w: 4, h: 4, dataF32: new Float32Array(16).fill(value),
      dirtyRects: [{ x: 0, y: 0, w: 4, h: 4 }] }));
    const params = [0, 1, 2].map(() => ({ minVal: 0, maxVal: 255, brightness: 0, gain: 1, contrast: 1 }));
    const first = compositor.compose(rasters, params);
    expect(Array.from(puts[0][0].data.slice(0, 4))).toEqual([20, 40, 60, 255]);
    expect(compositor.stats.pixelsColored).toBe(16);
    rasters[0].dataF32[5] = 100; rasters[0].previousRevision = 1; rasters[0].revision = 2;
    rasters[0].dirtyRects = [{ x: 1, y: 1, w: 1, h: 1 }];
    expect(compositor.compose(rasters, params)).toBe(first);
    expect(compositor.stats.pixelsColored).toBe(17);
    expect(puts[1].slice(3)).toEqual([1, 1, 1, 1]);
    expect(Array.from(puts[1][0].data.slice(20, 24))).toEqual([100, 40, 60, 255]);
    compositor.compose(rasters, params);
    expect(puts).toHaveLength(2);
    rasters[0].previousRevision = 3; rasters[0].revision = 4;
    compositor.compose(rasters, params);
    expect(compositor.stats.pixelsColored).toBe(33);
    params[1].brightness = 0.2;
    compositor.compose(rasters, params);
    expect(compositor.stats.pixelsColored).toBe(49);
    expect(compositor.stats.fullUpdates).toBe(3);
    expect(Array.from({ length: 16 }, (_, i) => puts.at(-1)[0].data[i * 4 + 1])).toEqual(Array(16).fill(91));
    compositor.compose([rasters[2], rasters[1], rasters[0]], params);
    expect(Array.from(puts.at(-1)[0].data.slice(0, 4))).toEqual([60, 91, 20, 255]);
    rasters[0].dataF32[0] = NaN;
    compositor.compose(rasters, params, { transparentNoData: true });
    expect(Array.from(puts.at(-1)[0].data.slice(0, 4))).toEqual([0, 0, 0, 0]);
    compositor.clear(); expect(compositor.stats.bytes).toBe(0);
  });

  test("untracked rasters never reuse stale RGBA and oversized entries are not retained", () => {
    const factory = vi.fn(() => ({ getContext: () => ({ putImageData: () => {} }) }));
    const compositor = createRgbCompositor({ tone01, createCanvas: factory, maxBytes: 4,
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) });
    const rasters = [0, 1, 2].map(() => ({ w: 2, h: 2, dataF32: new Float32Array(4) }));
    const params = [0, 1, 2].map(() => ({ minVal: 0, maxVal: 1, brightness: 0, gain: 1, contrast: 1 }));
    compositor.compose(rasters, params); compositor.compose(rasters, params);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(compositor.stats.bytes).toBe(0);
    expect(compositor.stats.pixelsColored).toBe(8);
  });
});
