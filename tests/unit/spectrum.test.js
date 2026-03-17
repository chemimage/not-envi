import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createSpectrumController,
  hasApproximatelyUniformBandIntervals,
  isCmInverseUnit,
  medianBandInterval,
  shouldUseBarSpectrumPlot
} from "../../src/render/spectrum.js";

describe("spectrum controller", () => {
  const originalRAF = globalThis.requestAnimationFrame;

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRAF;
  });

  test("open/close lifecycle updates panel state", async () => {
    globalThis.requestAnimationFrame = (cb) => {
      cb();
      return 1;
    };

    const specCtx = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      setLineDash: vi.fn(),
      fillText: vi.fn(),
      textAlign: "",
      textBaseline: "",
      lineWidth: 1,
      strokeStyle: "",
      fillStyle: "",
      font: ""
    };
    const els = {
      specPanel: { style: { display: "none" } },
      specCanvas: {
        width: 0,
        height: 0,
        getBoundingClientRect: () => ({ width: 300, height: 180 })
      },
      specSub: { textContent: "" },
      specWarn: { textContent: "", style: { display: "none" } },
      specFoot: { textContent: "" }
    };
    const ds = {
      id: 7,
      name: "demo",
      activeBand: 1,
      meta: { bands: 3, wlUnits: "nm", scale: null, bandNames: ["a", "b", "c"] }
    };

    const ctrl = createSpectrumController({
      els,
      specCtx,
      getActive: () => ds,
      bandLabel: (_ds, b) => `B${b}`,
      updatePerf: vi.fn(),
      sanitizeFilePart: (s) => s,
      downloadBlob: vi.fn(),
      readSpectrumAtPixel: async () => new Float32Array([1, 2, 3]),
      wavelengthArrayOrNull: () => [500, 600, 700]
    });

    await ctrl.openSpectrumAt(ds, 10, 20);
    expect(ctrl.isOpenForDatasetId(7)).toBe(true);
    expect(els.specPanel.style.display).toBe("block");

    ctrl.closeSpectrum();
    expect(ctrl.isOpenForDatasetId(7)).toBe(false);
    expect(els.specPanel.style.display).toBe("none");
  });

  test("bar-plot mode keeps the cm-1 unit gate and treats irregular spacing as discrete", () => {
    expect(isCmInverseUnit("cm-1")).toBe(true);
    expect(isCmInverseUnit("cm^-1")).toBe(true);
    expect(isCmInverseUnit("Wavenumber")).toBe(true);
    expect(isCmInverseUnit("nm")).toBe(false);

    expect(medianBandInterval([1000, 1010, 1020, 1030])).toBe(10);
    expect(medianBandInterval([1000, 1004, 1020])).toBe(10);

    expect(hasApproximatelyUniformBandIntervals([4000, 3990, 3980, 3970], {})).toBe(true);
    expect(hasApproximatelyUniformBandIntervals([4000, 3990.2, 3980.1, 3970.3], {})).toBe(true);
    expect(hasApproximatelyUniformBandIntervals([4000, 3988, 3979, 3960], {})).toBe(false);

    expect(shouldUseBarSpectrumPlot([4000, 3990, 3980, 3970], "cm-1")).toBe(false);
    expect(shouldUseBarSpectrumPlot([4000, 3990.2, 3980.1, 3970.3], "cm^-1")).toBe(false);
    expect(shouldUseBarSpectrumPlot([4000, 3988, 3979, 3960], "cm-1")).toBe(true);
    expect(shouldUseBarSpectrumPlot([500, 509, 518], "nm")).toBe(false);
  });

  test("spectrum header can render with only coordinates", async () => {
    globalThis.requestAnimationFrame = (cb) => {
      cb();
      return 1;
    };

    const specCtx = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      setLineDash: vi.fn(),
      fillText: vi.fn(),
      textAlign: "",
      textBaseline: "",
      lineWidth: 1,
      strokeStyle: "",
      fillStyle: "",
      font: ""
    };
    const els = {
      specPanel: { style: { display: "none" } },
      specCanvas: {
        width: 0,
        height: 0,
        getBoundingClientRect: () => ({ width: 300, height: 180 })
      },
      specSub: { textContent: "" },
      specWarn: { textContent: "", style: { display: "none" } },
      specFoot: { textContent: "" }
    };
    const ds = {
      id: 7,
      name: "demo-dataset",
      activeBand: 1,
      meta: { bands: 3, wlUnits: "nm", scale: null, bandNames: ["a", "b", "c"] }
    };

    const ctrl = createSpectrumController({
      els,
      specCtx,
      getActive: () => ds,
      bandLabel: (_ds, b) => `B${b}`,
      updatePerf: vi.fn(),
      sanitizeFilePart: (s) => s,
      downloadBlob: vi.fn(),
      readSpectrumAtPixel: async () => new Float32Array([1, 2, 3]),
      wavelengthArrayOrNull: () => [500, 600, 700]
    });

    await ctrl.openSpectrumAt(ds, 1, 1);
    expect(els.specSub.textContent).toContain("px 1, 1");
  });

  test("discrete bar plots use a uniform non-overlapping bar width", async () => {
    globalThis.requestAnimationFrame = (cb) => {
      cb();
      return 1;
    };

    const specCtx = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      setLineDash: vi.fn(),
      fillText: vi.fn(),
      textAlign: "",
      textBaseline: "",
      lineWidth: 1,
      strokeStyle: "",
      fillStyle: "",
      font: ""
    };
    const els = {
      specPanel: { style: { display: "none" } },
      specCanvas: {
        width: 0,
        height: 0,
        getBoundingClientRect: () => ({ width: 300, height: 180 })
      },
      specSub: { textContent: "" },
      specWarn: { textContent: "", style: { display: "none" } },
      specFoot: { textContent: "" }
    };
    const ds = {
      id: 18,
      name: "discrete-demo",
      activeBand: 1,
      meta: { bands: 4, wlUnits: "Wavenumber", scale: null, bandNames: ["a", "b", "c", "d"] }
    };

    const ctrl = createSpectrumController({
      els,
      specCtx,
      getActive: () => ds,
      bandLabel: (_ds, b) => `B${b}`,
      updatePerf: vi.fn(),
      sanitizeFilePart: (s) => s,
      downloadBlob: vi.fn(),
      readSpectrumAtPixel: async () => new Float32Array([2, 3, 1.5, 2.5]),
      wavelengthArrayOrNull: () => [1081, 1140, 1237, 1275]
    });

    await ctrl.openSpectrumAt(ds, 0, 0);

    const barCalls = specCtx.fillRect.mock.calls.filter(([, , w]) => w < 300);
    expect(barCalls).toHaveLength(4);

    const widths = barCalls.map(([, , w]) => w);
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i]).toBeCloseTo(widths[0], 6);
    }

    const slots = barCalls
      .map(([x, , w]) => ({ left: x, right: x + w }))
      .sort((a, b) => a.left - b.left);
    for (let i = 1; i < slots.length; i += 1) {
      expect(slots[i - 1].right).toBeLessThanOrEqual(slots[i].left);
    }
  });

  test("pending spectrum state renders placeholder without reading data", async () => {
    globalThis.requestAnimationFrame = (cb) => {
      cb();
      return 1;
    };

    const readSpectrumAtPixel = vi.fn(async () => new Float32Array([1, 2, 3]));
    const specCtx = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      setLineDash: vi.fn(),
      fillText: vi.fn(),
      textAlign: "",
      textBaseline: "",
      lineWidth: 1,
      strokeStyle: "",
      fillStyle: "",
      font: ""
    };
    const els = {
      specPanel: { style: { display: "none" } },
      specCanvas: {
        width: 0,
        height: 0,
        getBoundingClientRect: () => ({ width: 300, height: 180 })
      },
      specSub: { textContent: "" },
      specWarn: { textContent: "", style: { display: "none" } },
      specFoot: { textContent: "" }
    };
    const ds = {
      id: 12,
      name: "pending-demo",
      activeBand: 0,
      meta: { bands: 3, wlUnits: "nm", scale: null, bandNames: ["a", "b", "c"] }
    };

    const ctrl = createSpectrumController({
      els,
      specCtx,
      getActive: () => ds,
      bandLabel: (_ds, b) => `B${b}`,
      updatePerf: vi.fn(),
      sanitizeFilePart: (s) => s,
      downloadBlob: vi.fn(),
      readSpectrumAtPixel,
      wavelengthArrayOrNull: () => [500, 600, 700]
    });

    await ctrl.showPendingSpectrum(ds, 0, 0, {
      subLabel: "Area average (computing...)",
      footLabel: "Computing 0/3 bands",
      placeholderText: "Computing area average..."
    });

    expect(readSpectrumAtPixel).not.toHaveBeenCalled();
    expect(els.specPanel.style.display).toBe("block");
    expect(els.specSub.textContent).toBe("Area average (computing...)");
    expect(els.specFoot.textContent).toBe("Computing 0/3 bands");
    expect(specCtx.fillText).toHaveBeenCalledWith("Computing area average...", 150, 90);
  });

  test("subsampled area average shows a warning", async () => {
    globalThis.requestAnimationFrame = (cb) => {
      cb();
      return 1;
    };

    const specCtx = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      setLineDash: vi.fn(),
      fillText: vi.fn(),
      textAlign: "",
      textBaseline: "",
      lineWidth: 1,
      strokeStyle: "",
      fillStyle: "",
      font: ""
    };
    const els = {
      specPanel: { style: { display: "none" } },
      specCanvas: {
        width: 0,
        height: 0,
        getBoundingClientRect: () => ({ width: 300, height: 180 })
      },
      specSub: { textContent: "" },
      specWarn: { textContent: "", style: { display: "none" } },
      specFoot: { textContent: "" }
    };
    const ds = {
      id: 13,
      name: "area-demo",
      activeBand: 0,
      meta: { bands: 3, wlUnits: "nm", scale: null, bandNames: ["a", "b", "c"] }
    };

    const ctrl = createSpectrumController({
      els,
      specCtx,
      getActive: () => ds,
      bandLabel: (_ds, b) => `B${b}`,
      updatePerf: vi.fn(),
      sanitizeFilePart: (s) => s,
      downloadBlob: vi.fn(),
      readSpectrumAtPixel: async () => new Float32Array([1, 2, 3]),
      wavelengthArrayOrNull: () => [500, 600, 700]
    });

    await ctrl.openSpectrumAt(ds, 0, 0, {
      sourceType: "area",
      sourceMeta: { sampleCount: 1000, selectionCount: 2, sampleStep: 4 },
      yVals: new Float32Array([1, 2, 3]),
      xVals: [500, 600, 700]
    });

    expect(els.specWarn.style.display).toBe("block");
    expect(els.specWarn.textContent).toContain("Approximate:");
    expect(els.specWarn.textContent).toContain("4");
  });

  test("area spectrum waits for the canvas layout to become non-zero before drawing", async () => {
    globalThis.requestAnimationFrame = (cb) => {
      cb();
      return 1;
    };

    const specCtx = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      setLineDash: vi.fn(),
      fillText: vi.fn(),
      textAlign: "",
      textBaseline: "",
      lineWidth: 1,
      strokeStyle: "",
      fillStyle: "",
      font: ""
    };
    let rectReadCount = 0;
    const els = {
      specPanel: { style: { display: "none" } },
      specCanvas: {
        width: 0,
        height: 0,
        getBoundingClientRect: () => {
          rectReadCount += 1;
          if (rectReadCount === 1) return { width: 0, height: 0 };
          return { width: 300, height: 180 };
        }
      },
      specSub: { textContent: "" },
      specWarn: { textContent: "", style: { display: "none" } },
      specFoot: { textContent: "" }
    };
    const ds = {
      id: 14,
      name: "area-layout-demo",
      activeBand: 0,
      meta: { bands: 3, wlUnits: "nm", scale: null, bandNames: ["a", "b", "c"] }
    };

    const ctrl = createSpectrumController({
      els,
      specCtx,
      getActive: () => ds,
      bandLabel: (_ds, b) => `B${b}`,
      updatePerf: vi.fn(),
      sanitizeFilePart: (s) => s,
      downloadBlob: vi.fn(),
      readSpectrumAtPixel: async () => new Float32Array([1, 2, 3]),
      wavelengthArrayOrNull: () => [500, 600, 700]
    });

    await ctrl.openSpectrumAt(ds, 0, 0, {
      sourceType: "area",
      sourceMeta: { sampleCount: 4, selectionCount: 1, sampleStep: 1 },
      yVals: new Float32Array([1, 2, 3]),
      xVals: [500, 600, 700]
    });

    expect(els.specCanvas.width).toBe(300);
    expect(els.specCanvas.height).toBe(180);
  });
});
