import { describe, expect, test, vi } from "vitest";
import { createSpectrumAreaController } from "../../src/app/spectrum-area-controller.js";

describe("spectrum-area-controller", () => {
  test.each(["single", "group"])("%s mode calculates separate color spectra with the same grouping rules as histograms", async mode => {
    const items = [
      { id: 1, tool: "rect", color: "red", points: [{ x: 0, y: 0 }, { x: 0, y: 0 }] },
      { id: 2, tool: "rect", color: "red", points: [{ x: 1, y: 0 }, { x: 1, y: 0 }] },
      { id: 3, tool: "rect", color: "blue", points: [{ x: 2, y: 0 }, { x: 2, y: 0 }] }
    ];
    const ds = { id: 1, selectedAreaId: 3, meta: { samples: 3, lines: 1, bands: 2, interleave: "bsq" }, ds: {} };
    const open = vi.fn(), work = { update: vi.fn(), done: vi.fn() };
    const ctrl = createSpectrumAreaController({ spectrum: { openSpectrumAt: open },
      getAreaSelectionMode: () => mode, getHistogramSelectionItems: () => mode === "single" ? [items[2]] : items,
      listHistogramSelectionItems: () => items, isHistogramSelectionTool: () => true,
      resolveSelectionBoundsForSpectrum: (_ds, item) => ({ x0: item.points[0].x, y0: 0, width: 1, height: 1 }),
      resolveEffectiveSelectionBounds: () => ({}), resolveSelectionBoundsList: () => [],
      readBandWindow: async (_meta, _source, band, x0) => new Float32Array([10 + x0 + band * 100]),
      toFloat32: data => data, wavelengthArrayOrNull: () => null, fmtNoGroup: String,
      beginAnnotationWork: () => work
    });
    await ctrl.openSpectrumAt(ds, 0, 0, { forceArea: true });
    expect(open).toHaveBeenCalledTimes(2);
    const results = open.mock.calls.map(call => call[3]);
    expect(results.map(result => result.sourceColor)).toEqual(["red", "blue"]);
    expect(results.map(result => result.plotItems.map(item => item.id))).toEqual([mode === "single" ? [2] : [1, 2], [3]]);
    expect([...results[0].yVals]).toEqual(mode === "single" ? [11, 111] : [10.5, 110.5]);
    expect([...results[1].yVals]).toEqual([12, 112]);
    expect(work.update).toHaveBeenLastCalledWith(2, 2);
    expect(work.done).toHaveBeenCalledTimes(1);
  });

  test("failed point reads release annotation work and allow a successful retry", async () => {
    const handles = [];
    const open = vi.fn().mockRejectedValueOnce(new Error("source read failed")).mockResolvedValueOnce(undefined);
    const ctrl = createSpectrumAreaController({
      getHistogramSelectionItems: () => [],
      spectrum: { openSpectrumAt: open },
      beginAnnotationWork: () => {
        const handle = { done: vi.fn() };
        handles.push(handle);
        return handle;
      }
    });
    await expect(ctrl.openSpectrumAt({ id: 1 }, 2, 3)).rejects.toThrow("source read failed");
    expect(handles[0].done).toHaveBeenCalledTimes(1);
    await ctrl.openSpectrumAt({ id: 1 }, 2, 3);
    expect(handles[1].done).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(2);
  });

  test("closing area work discards a delayed result and releases its progress lease", async () => {
    const selection = { id: 1, tool: "rect", points: [{ x: 0, y: 0 }, { x: 0, y: 0 }] };
    const ds = { id: "slide", meta: { bands: 1, samples: 1, lines: 1, interleave: "bsq" }, ds: {} };
    let release;
    const delayed = new Promise((resolve) => { release = resolve; });
    const publish = vi.fn();
    const work = { done: vi.fn(), update: vi.fn() };
    const ctrl = createSpectrumAreaController({
      spectrum: { openSpectrumAt: publish },
      getHistogramSelectionItems: () => [selection],
      isHistogramSelectionTool: () => true,
      resolveSelectionBoundsForSpectrum: () => ({ x0: 0, y0: 0, width: 1, height: 1 }),
      resolveEffectiveSelectionBounds: () => ({ x0: 0, y0: 0, x1: 0, y1: 0 }),
      resolveSelectionBoundsList: () => [], listHistogramSelectionItems: () => [selection],
      readBandWindow: async () => { await delayed; return new Float32Array([7]); },
      toFloat32: (data) => data, fmtNoGroup: String,
      beginAnnotationWork: () => work
    });
    const pending = ctrl.openSpectrumAt(ds, 0, 0);
    await Promise.resolve();
    ctrl.cancel();
    release();
    await pending;
    expect(publish).not.toHaveBeenCalled();
    expect(work.done).toHaveBeenCalledTimes(1);
  });

  test("explicit point selection bypasses existing region averages", async () => {
    const ds = { id: 7 };
    const openSpy = vi.fn(async () => {});
    const readBandWindow = vi.fn();
    const ctrl = createSpectrumAreaController({
      spectrum: { openSpectrumAt: openSpy },
      getHistogramSelectionItems: () => [{ id: 1, tool: "rect" }],
      readBandWindow
    });
    await ctrl.openSpectrumAt(ds, 12, 34, { forcePoint: true });
    expect(openSpy).toHaveBeenCalledWith(ds, 12, 34, { forcePoint: true, plotSlot: 1 });
    expect(readBandWindow).not.toHaveBeenCalled();
  });

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
    let firstReadOptions = null;
    const handles = [];

    const ctrl = createSpectrumAreaController({
      beginAnnotationWork: () => {
        const handle = { done: vi.fn(), update: vi.fn() };
        handles.push(handle);
        return handle;
      },
      getActive: () => ds,
      spectrum: { openSpectrumAt: openSpy },
      isHistogramSelectionTool: (item) => item?.tool === "rect" || item?.tool === "shape",
      getHistogramSelectionItems: () => [selection],
      resolveSelectionBoundsForSpectrum: () => ({ x0: 0, y0: 0, x1: 0, y1: 0, width: 1, height: 1 }),
      resolveEffectiveSelectionBounds: () => ({ x0: 0, y0: 0, x1: 0, y1: 0 }),
      resolveSelectionBoundsList: () => [{ id: 2, x0: 0, y0: 0, x1: 0, y1: 0 }],
      listHistogramSelectionItems: () => [selection],
      readBandWindow: async (...args) => {
        readCount += 1;
        if (readCount === 1) {
          firstReadOptions = args[9];
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
    await vi.waitFor(() => expect(firstReadOptions).toBeTruthy());
    const p2 = ctrl.openSpectrumAt(ds, 0, 0, { forceArea: true });
    expect(firstReadOptions?.cancelled()).toBe(true);
    expect(handles.every((handle) => handle.done.mock.calls.length === 0)).toBe(true);
    releaseFirst();
    await Promise.all([p1, p2]);

    expect(openSpy).toHaveBeenCalledTimes(1);
    const opts = openSpy.mock.calls[0][3];
    expect(opts.yVals[0]).toBeCloseTo(9);
    expect(handles).toHaveLength(2);
    expect(handles.every((handle) => handle.done.mock.calls.length === 1)).toBe(true);
    expect(handles[1].update).toHaveBeenLastCalledWith(1, 1);
  });

  test("new area request aborts older long-running average before all bands finish", async () => {
    const selection = { id: 21, tool: "rect", points: [{ x: 0, y: 0 }, { x: 0, y: 0 }] };
    const ds = {
      id: 22,
      meta: { bands: 4, interleave: "bsq", samples: 1, lines: 1 },
      ds: {}
    };
    const openSpy = vi.fn(async () => {});
    let readCount = 0;
    let releaseFirstBand = null;
    const firstBand = new Promise((resolve) => { releaseFirstBand = resolve; });

    const ctrl = createSpectrumAreaController({
      getActive: () => ds,
      spectrum: { openSpectrumAt: openSpy },
      isHistogramSelectionTool: (item) => item?.tool === "rect" || item?.tool === "shape",
      getHistogramSelectionItems: () => [selection],
      resolveSelectionBoundsForSpectrum: () => ({ x0: 0, y0: 0, x1: 0, y1: 0, width: 1, height: 1 }),
      resolveEffectiveSelectionBounds: () => ({ x0: 0, y0: 0, x1: 0, y1: 0 }),
      resolveSelectionBoundsList: () => [{ id: 21, x0: 0, y0: 0, x1: 0, y1: 0 }],
      listHistogramSelectionItems: () => [selection],
      readBandWindow: async () => {
        readCount += 1;
        if (readCount === 1) {
          await firstBand;
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
    await vi.waitFor(() => expect(readCount).toBe(1));
    const p2 = ctrl.openSpectrumAt(ds, 0, 0, { forceArea: true });
    releaseFirstBand();
    await Promise.all([p1, p2]);

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(readCount).toBeGreaterThanOrEqual(4);
    expect(readCount).toBeLessThan(8);
    const opts = openSpy.mock.calls[0][3];
    expect(Array.from(opts.yVals)).toEqual([9, 9, 9, 9]);
  });

  test("shape selection membership is preserved across bounded per-band masks", async () => {
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
    expect(pointInPolygon).toHaveBeenCalled();
    expect(Array.from(openSpy.mock.calls[0][3].yVals)).toEqual([5, 5, 5]);
  });

  test("uses source-side moments without transporting per-band rasters", async () => {
    const selection = { id: 4, tool: "rect", points: [{ x: 0, y: 0 }, { x: 0, y: 0 }] };
    const ds = {
      id: 10,
      meta: { bands: 2, interleave: "bsq", samples: 2, lines: 2 },
      ds: {}
    };
    const openSpy = vi.fn(async () => {});
    let readCall = 0;
    ds.ds.reduceStatisticsWindow = vi.fn(async (_meta, band) => {
      const value = band ? 5 : 3;
      return { min: value, max: value, sum: value, sumSq: value * value, count: 1 };
    });

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
      pointInPolygon: () => true,
      wavelengthArrayOrNull: () => null,
      fmtNoGroup: (n) => String(n)
    });

    await ctrl.openSpectrumAt(ds, 0, 0, { forceArea: true });

    expect(ds.ds.reduceStatisticsWindow).toHaveBeenCalledTimes(2);
    expect(readCall).toBe(0);
    expect(openSpy).toHaveBeenCalledTimes(1);
    const opts = openSpy.mock.calls[0][3];
    expect(opts.yVals[0]).toBeCloseTo(3);
    expect(opts.yVals[1]).toBeCloseTo(5);
  });

  test("area average ignores non-finite sampled values instead of blanking the spectrum", async () => {
    const selection = { id: 5, tool: "rect", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
    const ds = {
      id: 11,
      meta: { bands: 1, interleave: "bsq", samples: 2, lines: 2 },
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
      resolveSelectionBoundsList: () => [{ id: 5, x0: 0, y0: 0, x1: 1, y1: 1 }],
      listHistogramSelectionItems: () => [selection],
      readBandWindow: async () => new Float32Array([1, Number.NaN, 3, 5]),
      readBandWindowBIP: async () => new Float32Array([1, Number.NaN, 3, 5]),
      toFloat32: (arr) => arr,
      pointInPolygon: () => true,
      wavelengthArrayOrNull: () => null,
      fmtNoGroup: (n) => String(n)
    });

    await ctrl.openSpectrumAt(ds, 0, 0, { forceArea: true });

    expect(openSpy).toHaveBeenCalledTimes(1);
    const opts = openSpy.mock.calls[0][3];
    expect(opts.sourceMeta.sampleCount).toBe(4);
    expect(opts.yVals[0]).toBeCloseTo(3);
    expect(Number.isFinite(opts.stdVals[0])).toBe(true);
  });

  test("area average uses reducer-returned finite counts for normalization", async () => {
    const selection = { id: 6, tool: "rect", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] };
    const ds = {
      id: 12,
      meta: { bands: 1, interleave: "bsq", samples: 2, lines: 1 },
      ds: {}
    };
    const openSpy = vi.fn(async () => {});
    ds.ds.reduceStatisticsWindow = vi.fn(async () => ({ min: 5, max: 5, sum: 5, sumSq: 25, count: 1 }));

    const ctrl = createSpectrumAreaController({
      getActive: () => ds,
      spectrum: { openSpectrumAt: openSpy },
      isHistogramSelectionTool: (item) => item?.tool === "rect" || item?.tool === "shape",
      getHistogramSelectionItems: () => [selection],
      resolveSelectionBoundsForSpectrum: () => ({ x0: 0, y0: 0, x1: 1, y1: 0, width: 2, height: 1 }),
      resolveEffectiveSelectionBounds: () => ({ x0: 0, y0: 0, x1: 1, y1: 0 }),
      resolveSelectionBoundsList: () => [{ id: 6, x0: 0, y0: 0, x1: 1, y1: 0 }],
      listHistogramSelectionItems: () => [selection],
      readBandWindow: async () => new Float32Array([5, Number.NaN]),
      readBandWindowBIP: async () => new Float32Array([5, Number.NaN]),
      toFloat32: (arr) => arr,
      pointInPolygon: () => true,
      wavelengthArrayOrNull: () => null,
      fmtNoGroup: (n) => String(n)
    });

    await ctrl.openSpectrumAt(ds, 0, 0, { forceArea: true });

    expect(ds.ds.reduceStatisticsWindow).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledTimes(1);
    const opts = openSpy.mock.calls[0][3];
    expect(opts.sourceMeta.sampleCount).toBe(2);
    expect(opts.yVals[0]).toBeCloseTo(5);
    expect(opts.stdVals[0]).toBeCloseTo(0);
  });

  test("area average reads bands into a caller-owned Float32Array scratch buffer", async () => {
    const selection = { id: 8, tool: "rect", points: [{ x: 0, y: 0 }, { x: 0, y: 0 }] };
    const ds = {
      id: 14,
      meta: { bands: 1, interleave: "bsq", samples: 1, lines: 1 },
      ds: {}
    };
    const openSpy = vi.fn(async () => {});
    let capturedOut = null;
    let capturedOptions = null;

    const ctrl = createSpectrumAreaController({
      getActive: () => ds,
      spectrum: { openSpectrumAt: openSpy },
      isHistogramSelectionTool: (item) => item?.tool === "rect" || item?.tool === "shape",
      getHistogramSelectionItems: () => [selection],
      resolveSelectionBoundsForSpectrum: () => ({ x0: 0, y0: 0, x1: 0, y1: 0, width: 1, height: 1 }),
      resolveEffectiveSelectionBounds: () => ({ x0: 0, y0: 0, x1: 0, y1: 0 }),
      resolveSelectionBoundsList: () => [{ id: 8, x0: 0, y0: 0, x1: 0, y1: 0 }],
      listHistogramSelectionItems: () => [selection],
      readBandWindow: async (...args) => {
        capturedOut = args[8];
        capturedOptions = args[9];
        capturedOut[0] = 7;
        return capturedOut;
      },
      readBandWindowBIP: async () => new Float32Array([0]),
      toFloat32: (arr, out = null) => out || arr,
      pointInPolygon: () => true,
      wavelengthArrayOrNull: () => null,
      fmtNoGroup: (n) => String(n)
    });

    await ctrl.openSpectrumAt(ds, 0, 0, { forceArea: true });

    expect(capturedOut).toBeInstanceOf(Float32Array);
    expect(capturedOptions?.priority).toBe("background");
    expect(capturedOptions?.cancelled()).toBe(false);
    expect(openSpy).toHaveBeenCalledTimes(1);
    const opts = openSpy.mock.calls[0][3];
    expect(opts.yVals[0]).toBeCloseTo(7);
  });
});
