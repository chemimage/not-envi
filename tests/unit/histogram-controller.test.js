import { describe, expect, test, vi } from "vitest";
import { createHistogramController } from "../../src/render/histogram.js";

describe("histogram controller", () => {
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
});
