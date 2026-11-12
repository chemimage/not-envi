import { describe, expect, test, vi } from "vitest";
import { createHistogramController } from "../../src/render/histogram.js";

describe("histogram controller", () => {
  test.each(["whole", "rect"])("large uint8 %s analysis uses compact reductions without a raster read", async (kind) => {
    const read = vi.fn(() => { throw new Error("Unexpected full raster read"); });
    const reduceBandWindow = vi.fn(async (_meta, _band, _x, _y, width, height, _step, options) => {
      const count = options.mask ? options.mask.reduce((sum, v) => sum + v, 0) : width * height;
      const bins = new Uint32Array(256); bins[0] = count;
      return { min: 7, max: 7 + 1e-6, count, sum: count * 7, sumSq: count * 49, bins };
    });
    const ctrl = createHistogramController({
      state: { activeId: "other", histMode: "whole" }, els: {},
      setStatus() {}, readBandWindow: read, readBandWindowBIP: read,
      computeHistogram: read, syncRangeInputsFromSettings() {}, render() {}
    });
    const ds = { id: "sample", activeBand: 0, bandStatsWhole: new Map(),
      meta: { samples: 512, lines: 512, dataType: 1, interleave: "bsq" }, ds: { reduceBandWindow } };
    if (kind === "whole") await ctrl.buildBandStatsWhole(ds, 0);
    else await ctrl.updateSelectionHistogram(ds, [{ id: 1, tool: kind,
      points: [{ x: 0, y: 0 }, { x: 511, y: 511 }] }]);
    expect(reduceBandWindow).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    const stats = kind === "whole" ? ds.bandStatsWhole.get(0) : ds.bandStatsSelection.stats;
    expect(stats.mean).toBe(7);
    expect(stats.trueRawSamples).toBe(true);
    expect(stats.count).toBe(262144);
  });

  test("ensureViewHistogram updates view stats only for matching lastRaster band", () => {
    const fakeCtx = {
      save: () => {},
      setTransform: () => {},
      clearRect: () => {},
      fillRect: () => {},
      fillText: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
      arc: () => {},
      fill: () => {},
      strokeRect: () => {},
      restore: () => {},
      lineWidth: 1,
      fillStyle: "",
      strokeStyle: "",
      font: ""
    };
    const sync = vi.fn();
    const computeHistogram = vi.fn(() => ({ bins: new Uint32Array([1]), min: 0, max: 1, p1: 0, p99: 1 }));
    const ctrl = createHistogramController({
      state: { activeId: 1, histMode: "view" },
      els: {
        hist: {
          width: 100,
          height: 40,
          getBoundingClientRect: () => ({ width: 100, height: 40 }),
          getContext: () => fakeCtx
        }
      },
      setStatus: () => {},
      readBandWindow: async () => new Float32Array(0),
      readBandWindowBIP: async () => new Float32Array(0),
      toFloat32: (x) => x,
      computeHistogram,
      tone01: () => 0,
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      resolveStats: (ds) => ds.bandStatsView,
      syncRangeInputsFromSettings: sync,
      render: () => {},
    });

    const ds = {
      activeBand: 2,
      lastRaster: { band: 2, dataF32: new Float32Array([1, 2, 3]) },
      bandStatsView: null,
    };

    ctrl.ensureViewHistogram(ds);
    expect(computeHistogram).toHaveBeenCalledTimes(1);
    expect(ds.bandStatsView).toBeTruthy();
    expect(sync).toHaveBeenCalled();

    computeHistogram.mockClear();
    ds.lastRaster.band = 1;
    ctrl.ensureViewHistogram(ds);
    expect(computeHistogram).not.toHaveBeenCalled();
  });

  test("ensureViewHistogram can use an estimated visible raster and labels it", () => {
    const labels = [];
    const fakeCtx = {
      save: () => {},
      setTransform: () => {},
      clearRect: () => {},
      fillRect: () => {},
      fillText: (text) => { labels.push(text); },
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
      arc: () => {},
      fill: () => {},
      strokeRect: () => {},
      restore: () => {},
      lineWidth: 1,
      fillStyle: "",
      strokeStyle: "",
      font: ""
    };
    const stats = { bins: new Uint32Array([1, 2, 1]), min: 0, max: 2, p1: 0, p99: 2 };
    const ctrl = createHistogramController({
      state: { activeId: 1, histMode: "view" },
      els: {
        hist: {
          width: 100,
          height: 40,
          getBoundingClientRect: () => ({ width: 100, height: 40 }),
          getContext: () => fakeCtx
        }
      },
      setStatus: () => {},
      readBandWindow: async () => new Float32Array(0),
      readBandWindowBIP: async () => new Float32Array(0),
      toFloat32: (x) => x,
      computeHistogram: vi.fn(() => stats),
      tone01: () => 0,
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      getDisplayBand: () => 2,
      resolveStats: (ds) => ds.bandStatsView,
      syncRangeInputsFromSettings: () => {},
      render: () => {}
    });
    const ds = {
      activeBand: 2,
      lastRaster: null,
      bandStatsView: null
    };

    ctrl.ensureViewHistogram(ds, {
      band: 2,
      dataF32: new Float32Array([0, 1, 2]),
      step: 4,
      approximate: true
    });

    expect(ds.bandStatsView?.samplingMode).toBe("view-estimated");
    expect(ds.bandStatsView?.trueRawSamples).toBe(false);
    expect(labels).toContain("Estimated");
  });

  test("buildEstimatedViewHistogram reads a capped visible window and keeps pending state unestimated", async () => {
    let releaseRead = null;
    const labels = [];
    const fakeCtx = {
      save: () => {},
      setTransform: () => {},
      clearRect: () => {},
      fillRect: () => {},
      fillText: (text) => { labels.push(text); },
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
      arc: () => {},
      fill: () => {},
      strokeRect: () => {},
      restore: () => {},
      lineWidth: 1,
      fillStyle: "",
      strokeStyle: "",
      font: ""
    };
    let readOptions = null;
    const readBandWindow = vi.fn((_meta, _source, _band, _x0, _y0, outW, outH, _step, scratch, options) => new Promise((resolve) => {
      readOptions = options;
      if (releaseRead) { scratch.fill(2); resolve(scratch); return; }
      releaseRead = () => {
        scratch.set(new Float32Array(outW * outH).fill(2));
        resolve(scratch);
      };
    }));
    const ctrl = createHistogramController({
      state: { activeId: "ds1", histMode: "view" },
      els: {
        hist: {
          width: 100,
          height: 40,
          getBoundingClientRect: () => ({ width: 100, height: 40 }),
          getContext: () => fakeCtx
        }
      },
      setStatus: () => {},
      readBandWindow,
      readBandWindowBIP: async () => new Float32Array(0),
      toFloat32: (x) => x,
      computeHistogram: vi.fn(() => ({ bins: new Uint32Array([1, 2]), min: 0, max: 2, p1: 0, p99: 2 })),
      tone01: () => 0,
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      getDisplayBand: () => 0,
      resolveStats: (ds) => ds.bandStatsView,
      syncRangeInputsFromSettings: () => {},
      render: () => {},
      getActiveViewportDevice: () => ({ width: 800, height: 600 }),
      getDevicePixelRatio: () => 1
    });
    const ds = {
      id: "ds1",
      activeBand: 0,
      view: { x: 100, y: 50, scale: 1 },
      meta: { samples: 2000, lines: 1600, interleave: "bsq" },
      ds: {},
      bandStatsWhole: new Map(),
      bandStatsView: null
    };

    const pending = ctrl.buildEstimatedViewHistogram(ds);
    ctrl.drawHistogram(ds);
    expect(labels).toContain("Histogram not ready");
    expect(labels).not.toContain("Estimated");
    await vi.waitFor(() => expect(readBandWindow).toHaveBeenCalled());
    expect(readOptions?.priority).toBe("background");
    expect(readOptions?.cancelled()).toBe(false);
    ds.view.x += 1;
    expect(readOptions?.cancelled()).toBe(true);
    ds.view.x -= 1;
    releaseRead();
    await pending;

    expect(ds.bandStatsView?.samplingMode).toBe("view-subsampled");
    expect(ds.bandStatsView?.trueRawSamples).toBe(false);
  });

  test("drawHistogram colors bars for rgb channel mode and restores grayscale bars otherwise", () => {
    const fillStyles = [];
    let currentFillStyle = "";
    const fakeCtx = {
      save: () => {},
      setTransform: () => {},
      clearRect: () => {},
      fillRect: (_x, _y, _w, _h) => { fillStyles.push(currentFillStyle); },
      fillText: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
      arc: () => {},
      fill: () => {},
      strokeRect: () => {},
      restore: () => {},
      lineWidth: 1,
      strokeStyle: "",
      font: "",
      get fillStyle() { return currentFillStyle; },
      set fillStyle(value) { currentFillStyle = value; }
    };
    const canvas = {
      width: 100,
      height: 40,
      getBoundingClientRect: () => ({ width: 100, height: 40 }),
      getContext: () => fakeCtx
    };
    const stats = { bins: new Uint32Array([1, 2, 3]), min: 0, max: 3, p1: 0.1, p99: 2.9 };
    const ctrl = createHistogramController({
      state: { activeId: 1, histMode: "whole" },
      els: { hist: canvas },
      setStatus: () => {},
      readBandWindow: async () => new Float32Array(0),
      readBandWindowBIP: async () => new Float32Array(0),
      toFloat32: (x) => x,
      computeHistogram: () => stats,
      tone01: () => 0,
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      getDisplayBand: () => 0,
      getDisplayColor: () => "red",
      resolveStats: () => stats,
      syncRangeInputsFromSettings: () => {},
      render: () => {}
    });

    ctrl.drawHistogram({ activeBand: 0 });
    expect(fillStyles).toContain("rgb(252 165 165 / 0.96)");

    fillStyles.length = 0;
    const grayCtrl = createHistogramController({
      state: { activeId: 1, histMode: "whole" },
      els: { hist: canvas },
      setStatus: () => {},
      readBandWindow: async () => new Float32Array(0),
      readBandWindowBIP: async () => new Float32Array(0),
      toFloat32: (x) => x,
      computeHistogram: () => stats,
      tone01: () => 0,
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      getDisplayBand: () => 0,
      getDisplayColor: () => null,
      resolveStats: () => stats,
      syncRangeInputsFromSettings: () => {},
      render: () => {}
    });

    grayCtrl.drawHistogram({ activeBand: 0 });
    expect(fillStyles).toContain("rgba(156,163,175,0.35)");
  });

  test("buildBandStatsWhole reuses a caller-owned Float32Array scratch buffer", async () => {
    let capturedOut = null;
    let capturedOptions = null;
    const computeHistogram = vi.fn(() => ({ bins: new Uint32Array([1]), min: 0, max: 1, p1: 0, p99: 1 }));
    const ctrl = createHistogramController({
      state: { activeId: "other", histMode: "whole" },
      els: { hist: { getBoundingClientRect: () => ({ width: 100, height: 40 }) } },
      setStatus: () => {},
      readBandWindow: async (...args) => {
        capturedOut = args[8];
        capturedOptions = args[9];
        capturedOut.set([1, 2, 3, 4], 0);
        return capturedOut;
      },
      readBandWindowBIP: async () => new Float32Array(0),
      toFloat32: (arr, out = null) => out || arr,
      computeHistogram,
      tone01: () => 0,
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      resolveStats: () => null,
      syncRangeInputsFromSettings: () => {},
      render: () => {}
    });
    const ds = {
      id: "ds-1",
      activeBand: 0,
      bandStatsWhole: new Map(),
      meta: { samples: 2, lines: 2, interleave: "bsq" },
      ds: {}
    };

    await ctrl.buildBandStatsWhole(ds, 0);

    expect(capturedOut).toBeInstanceOf(Float32Array);
    expect(capturedOptions?.priority).toBe("background");
    expect(ds.bandStatsWhole.get(0).count).toBe(4);
    expect(ds.bandStatsWhole.get(0).mean).toBeCloseTo(2.5);
    expect(ds.bandStatsWhole.has(0)).toBe(true);
  });
});
