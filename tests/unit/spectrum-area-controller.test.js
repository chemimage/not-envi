import { describe, expect, test, vi } from "vitest";
import { createSpectrumAreaController } from "../../src/app/spectrum-area-controller.js";

describe("spectrum-area-controller", () => {
  test("openSpectrumAt uses area-averaged spectrum when selection is present", async () => {
    const selection = { id: 1, tool: "rect", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
    const ds = {
      id: 7,
      meta: { bands: 1, interleave: "bsq", samples: 4, lines: 4 },
      ds: {}
    };
    const openSpy = vi.fn(async () => {});

    const ctrl = createSpectrumAreaController({
      getActive: () => ds,
      spectrum: { openSpectrumAt: openSpy },
      isHistogramSelectionTool: (item) => item?.tool === "rect" || item?.tool === "shape",
      getHistogramSelectionItems: () => [selection],
      resolveSelectionBoundsForSpectrum: () => ({ x0: 0, y0: 0, x1: 1, y1: 1, width: 2, height: 2 }),
      resolveEffectiveSelectionBounds: () => ({ x0: 0, y0: 0, x1: 1, y1: 1 }),
      resolveSelectionBoundsList: () => [{ id: 1, x0: 0, y0: 0, x1: 1, y1: 1 }],
      listHistogramSelectionItems: () => [selection],
      readBandWindow: async () => new Float32Array([1, 2, 3, 4]),
      readBandWindowBIP: async () => new Float32Array([1, 2, 3, 4]),
      toFloat32: (arr) => arr,
      pointInPolygon: () => true,
      wavelengthArrayOrNull: () => null,
      fmtNoGroup: (n) => String(n)
    });

    await ctrl.openSpectrumAt(ds, 0, 0, { forceArea: true });

    expect(openSpy).toHaveBeenCalledTimes(1);
    const args = openSpy.mock.calls[0];
    const opts = args[3];
    expect(opts.sourceType).toBe("area");
    expect(opts.sourceMeta.sampleCount).toBe(4);
    expect(opts.yVals[0]).toBeCloseTo(2.5);
  });

  test("area spectrum cancels stale request and keeps latest result", async () => {
    const selection = { id: 2, tool: "rect", points: [{ x: 0, y: 0 }, { x: 0, y: 0 }] };
    const ds = {
      id: 8,
      meta: { bands: 1, interleave: "bsq", samples: 2, lines: 2 },
      ds: {}
    };
    const openSpy = vi.fn(async () => {});
    let releaseFirst = null;
    const firstRead = new Promise((resolve) => { releaseFirst = resolve; });
    let readCount = 0;

    const ctrl = createSpectrumAreaController({
      getActive: () => ds,
      spectrum: { openSpectrumAt: openSpy },
      isHistogramSelectionTool: (item) => item?.tool === "rect" || item?.tool === "shape",
      getHistogramSelectionItems: () => [selection],
      resolveSelectionBoundsForSpectrum: () => ({ x0: 0, y0: 0, x1: 0, y1: 0, width: 1, height: 1 }),
      resolveEffectiveSelectionBounds: () => ({ x0: 0, y0: 0, x1: 0, y1: 0 }),
      resolveSelectionBoundsList: () => [{ id: 2, x0: 0, y0: 0, x1: 0, y1: 0 }],
      listHistogramSelectionItems: () => [selection],
      readBandWindow: async () => {
        readCount += 1;
        if (readCount === 1) {
          await firstRead;
          return new Float32Array([1]);
        }
        return new Float32Array([9]);
      },
      readBandWindowBIP: async () => new Float32Array([9]),
      toFloat32: (arr) => arr,
      pointInPolygon: () => true,
      wavelengthArrayOrNull: () => null,
      fmtNoGroup: (n) => String(n)
    });

    const p1 = ctrl.openSpectrumAt(ds, 0, 0, { forceArea: true });
    await Promise.resolve();
    const p2 = ctrl.openSpectrumAt(ds, 0, 0, { forceArea: true });
    releaseFirst();
    await Promise.all([p1, p2]);

    expect(openSpy).toHaveBeenCalledTimes(1);
    const opts = openSpy.mock.calls[0][3];
    expect(opts.yVals[0]).toBeCloseTo(9);
  });

  test("shape selection membership is computed once and reused across bands", async () => {
    const selection = {
      id: 3,
      tool: "shape",
      points: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }, { x: 0, y: 3 }]
    };
    const ds = {
      id: 9,
      meta: { bands: 3, interleave: "bsq", samples: 4, lines: 4 },
      ds: {}
    };
    const openSpy = vi.fn(async () => {});
    const pointInPolygon = vi.fn(() => true);

    const ctrl = createSpectrumAreaController({
      getActive: () => ds,
      spectrum: { openSpectrumAt: openSpy },
      isHistogramSelectionTool: (item) => item?.tool === "rect" || item?.tool === "shape",
      getHistogramSelectionItems: () => [selection],
      resolveSelectionBoundsForSpectrum: () => ({ x0: 0, y0: 0, x1: 3, y1: 3, width: 4, height: 4 }),
      resolveEffectiveSelectionBounds: () => ({ x0: 0, y0: 0, x1: 3, y1: 3 }),
      resolveSelectionBoundsList: () => [{ id: 3, x0: 0, y0: 0, x1: 3, y1: 3 }],
      listHistogramSelectionItems: () => [selection],
      readBandWindow: async () => new Float32Array(16).fill(5),
      readBandWindowBIP: async () => new Float32Array(16).fill(5),
      toFloat32: (arr) => arr,
      pointInPolygon,
      wavelengthArrayOrNull: () => null,
      fmtNoGroup: (n) => String(n)
    });

    await ctrl.openSpectrumAt(ds, 0, 0, { forceArea: true });

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(pointInPolygon).toHaveBeenCalledTimes(16);
  });

  test("uses injected area reducer for per-band reduction", async () => {
    const selection = { id: 4, tool: "rect", points: [{ x: 0, y: 0 }, { x: 0, y: 0 }] };
    const ds = {
      id: 10,
      meta: { bands: 2, interleave: "bsq", samples: 2, lines: 2 },
      ds: {}
    };
    const openSpy = vi.fn(async () => {});
    let readCall = 0;
    const areaReducer = {
      reduce: vi.fn(async (values, indices) => {
        const v = values[indices[0]];
        return { sum: v, sumSq: v * v, count: indices.length };
      })
    };

    const ctrl = createSpectrumAreaController({
      getActive: () => ds,
      spectrum: { openSpectrumAt: openSpy },
      isHistogramSelectionTool: (item) => item?.tool === "rect" || item?.tool === "shape",
      getHistogramSelectionItems: () => [selection],
      resolveSelectionBoundsForSpectrum: () => ({ x0: 0, y0: 0, x1: 0, y1: 0, width: 1, height: 1 }),
      resolveEffectiveSelectionBounds: () => ({ x0: 0, y0: 0, x1: 0, y1: 0 }),
      resolveSelectionBoundsList: () => [{ id: 4, x0: 0, y0: 0, x1: 0, y1: 0 }],
      listHistogramSelectionItems: () => [selection],
      readBandWindow: async () => {
        readCall += 1;
        return new Float32Array([readCall === 1 ? 3 : 5]);
      },
      readBandWindowBIP: async () => new Float32Array([0]),
      toFloat32: (arr) => arr,
      areaReducer,
      pointInPolygon: () => true,
      wavelengthArrayOrNull: () => null,
      fmtNoGroup: (n) => String(n)
    });

    await ctrl.openSpectrumAt(ds, 0, 0, { forceArea: true });

    expect(areaReducer.reduce).toHaveBeenCalledTimes(2);
    expect(openSpy).toHaveBeenCalledTimes(1);
    const opts = openSpy.mock.calls[0][3];
    expect(opts.yVals[0]).toBeCloseTo(3);
    expect(opts.yVals[1]).toBeCloseTo(5);
  });
});
