import { describe, expect, test } from "vitest";
import { resolveRasterSampling } from "../../src/render/raster-geometry.js";

describe("raster geometry", () => {
  test("uses native sampling at zoom-in", () => {
    const ds = {
      view: { x: 0, y: 0, scale: 2 },
      meta: { samples: 100, lines: 80 }
    };
    const g = resolveRasterSampling(ds, 400, 200, 2);
    expect(g.step).toBe(1);
    expect(g.rasterW).toBe(200);
    expect(g.rasterH).toBe(100);
    expect(g.validW).toBe(100);
    expect(g.validH).toBe(80);
    expect(g.displayRect).toEqual({ x: 0, y: 0, w: 200, h: 160 });
  });

  test("keeps centered zoom-out footprint aligned", () => {
    const ds = {
      view: { x: -150, y: -62.5, scale: 0.8 },
      meta: { samples: 100, lines: 100 }
    };
    const g = resolveRasterSampling(ds, 320, 180, 0.8);
    expect(g.step).toBe(2);
    expect(g.rasterW).toBe(200);
    expect(g.rasterH).toBe(113);
    expect(g.displayRect).toEqual({ x: 120, y: 50.97345132743363, w: 80, h: 78.05309734513274 });
    const cx = g.displayRect.x + (g.displayRect.w * 0.5);
    const cy = g.displayRect.y + (g.displayRect.h * 0.5);
    expect(cx).toBeCloseTo(160, 9);
    expect(cy).toBeCloseTo(90, 9);
  });

  test("returns null displayRect when view is fully outside data", () => {
    const ds = {
      view: { x: 2000, y: 2000, scale: 1 },
      meta: { samples: 100, lines: 100 }
    };
    const g = resolveRasterSampling(ds, 320, 180, 1);
    expect(g.validW).toBe(0);
    expect(g.validH).toBe(0);
    expect(g.displayRect).toBeNull();
  });
});
