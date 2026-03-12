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
});
