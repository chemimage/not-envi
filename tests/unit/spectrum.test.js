import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createSpectrumController,
  hasApproximatelyUniformBandIntervals,
  isCmInverseUnit,
  medianBandInterval,
  shouldUseBarSpectrumPlot
} from "../../src/render/spectrum.js";
import { APP_CONFIG } from "../../src/app/config.js";

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
      measureText: vi.fn((text) => ({ width: String(text).length * 6 })),
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
      discreteBarMaxBands: APP_CONFIG.spectrum.discreteBarMaxBands,
      readSpectrumAtPixel: async () => new Float32Array([1, 2, 3]),
      wavelengthArrayOrNull: () => [500, 600, 700]
    });

    await ctrl.openSpectrumAt(ds, 10, 20);
    expect(ctrl.isOpenForDatasetId(7)).toBe(true);
    expect(els.specPanel.style.display).toBe("flex");

    ctrl.closeSpectrum();
    expect(ctrl.isOpenForDatasetId(7)).toBe(false);
    expect(els.specPanel.style.display).toBe("none");
  });

  test("bar-plot mode depends only on the configured band-count threshold", () => {
    expect(isCmInverseUnit("cm-1")).toBe(true);
    expect(isCmInverseUnit("cm^-1")).toBe(true);
    expect(isCmInverseUnit("Wavenumber")).toBe(true);
    expect(isCmInverseUnit("nm")).toBe(false);

    expect(medianBandInterval([1000, 1010, 1020, 1030])).toBe(10);
    expect(medianBandInterval([1000, 1004, 1020])).toBe(10);

    expect(hasApproximatelyUniformBandIntervals([4000, 3990, 3980, 3970], {})).toBe(true);
    expect(hasApproximatelyUniformBandIntervals([4000, 3990.2, 3980.1, 3970.3], {})).toBe(true);
    expect(hasApproximatelyUniformBandIntervals([4000, 3988, 3979, 3960], {})).toBe(false);

    expect(shouldUseBarSpectrumPlot([500, 509, 518], "nm", {
      discreteBandCountThreshold: APP_CONFIG.spectrum.discreteBarMaxBands
    })).toBe(true);
    expect(shouldUseBarSpectrumPlot(
      Array.from({ length: 21 }, (_v, i) => 500 + i),
      "nm",
      { discreteBandCountThreshold: APP_CONFIG.spectrum.discreteBarMaxBands }
    )).toBe(false);
    expect(shouldUseBarSpectrumPlot([4000, 3988, 3979, 3960], "cm-1", {
      discreteBandCountThreshold: APP_CONFIG.spectrum.discreteBarMaxBands
    })).toBe(true);
    expect(shouldUseBarSpectrumPlot(Array.from({ length: 21 }, (_v, i) => 4000 - (i * (i % 2 === 0 ? 7 : 13))), "cm-1", {
      discreteBandCountThreshold: APP_CONFIG.spectrum.discreteBarMaxBands
    })).toBe(false);
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
      measureText: vi.fn((text) => ({ width: String(text).length * 6 })),
      textAlign: "",
      textBaseline: "",
      lineWidth: 1,
      strokeStyle: "",
      fillStyle: "",
      font: ""
    };
    const els = {
      specLocationUnits: document.createElement("div"),
      btnSpecUnitUm: document.createElement("button"),
      btnSpecUnitPx: document.createElement("button"),
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
      discreteBarMaxBands: APP_CONFIG.spectrum.discreteBarMaxBands,
      readSpectrumAtPixel: async () => new Float32Array([1, 2, 3]),
      wavelengthArrayOrNull: () => [500, 600, 700]
    });

    await ctrl.openSpectrumAt(ds, 1, 1);
    expect(els.specSub.textContent).toBe("(1, 1)");
    expect(els.btnSpecUnitUm.disabled).toBe(true);
    ds.meta.scale = { umPerPixelX: 2, umPerPixelY: 3 };
    await ctrl.openSpectrumAt(ds, 4, 5);
    expect(els.specSub.textContent).toBe("(4, 5)");
    els.btnSpecUnitUm.click();
    expect(els.specSub.textContent).toBe("(8, 15)");
    expect(els.btnSpecUnitUm.getAttribute("aria-pressed")).toBe("true");
    els.btnSpecUnitPx.click();
    expect(els.specSub.textContent).toBe("(4, 5)");
    await ctrl.openSpectrumAt(ds, 4, 5, { subLabel: "Area average" });
    expect(els.specLocationUnits.hidden).toBe(true);
    expect(els.specSub.textContent).toBe("Area average");
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
      measureText: vi.fn((text) => ({ width: String(text).length * 6 })),
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
      discreteBarMaxBands: APP_CONFIG.spectrum.discreteBarMaxBands,
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

  test("hovering the draggable band handle uses a drag cursor", async () => {
    globalThis.requestAnimationFrame = (cb) => {
      cb();
      return 1;
    };

    const handlers = new Map();
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
      measureText: vi.fn((text) => ({ width: String(text).length * 6 })),
      textAlign: "",
      textBaseline: "",
      lineWidth: 1,
      strokeStyle: "",
      fillStyle: "",
      font: ""
    };
    const specCanvas = {
      width: 0,
      height: 0,
      style: { cursor: "" },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 180 }),
      addEventListener: (type, handler) => { handlers.set(type, handler); },
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn()
    };
    const els = {
      specPanel: { style: { display: "none" } },
      specCanvas,
      specSub: { textContent: "" },
      specWarn: { textContent: "", style: { display: "none" } },
      specFoot: { textContent: "" }
    };
    const ds = {
      id: 21,
      name: "cursor-demo",
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
      discreteBarMaxBands: APP_CONFIG.spectrum.discreteBarMaxBands,
      readSpectrumAtPixel: async () => new Float32Array([1, 2, 3]),
      wavelengthArrayOrNull: () => [500, 600, 700]
    });

    await ctrl.openSpectrumAt(ds, 0, 0);

    handlers.get("pointermove")?.({
      clientX: 170,
      clientY: 80,
      pointerId: 1,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    });

    expect(specCanvas.style.cursor).toBe("grab");
  });

  test("spectrum hover draws a solid value guide that follows continuous cursor position", async () => {
    globalThis.requestAnimationFrame = (cb) => {
      cb();
      return 1;
    };

    const handlers = new Map();
    const textLabels = [];
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
      fillText: vi.fn((text) => textLabels.push(String(text))),
      measureText: vi.fn((text) => ({ width: String(text).length * 6 })),
      textAlign: "",
      textBaseline: "",
      lineWidth: 1,
      strokeStyle: "",
      fillStyle: "",
      font: ""
    };
    const specCanvas = {
      width: 0,
      height: 0,
      style: { cursor: "" },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 180 }),
      addEventListener: (type, handler) => { handlers.set(type, handler); },
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn()
    };
    const els = {
      specPanel: { style: { display: "none" } },
      specCanvas,
      specSub: { textContent: "" },
      specWarn: { textContent: "", style: { display: "none" } },
      specFoot: { textContent: "" }
    };
    const ds = {
      id: 23,
      name: "continuous-demo",
      activeBand: 1,
      meta: { bands: 25, wlUnits: "nm", scale: null, bandNames: [] }
    };

    const ctrl = createSpectrumController({
      els,
      specCtx,
      getActive: () => ds,
      bandLabel: (_ds, b) => `B${b}`,
      updatePerf: vi.fn(),
      sanitizeFilePart: (s) => s,
      downloadBlob: vi.fn(),
      discreteBarMaxBands: APP_CONFIG.spectrum.discreteBarMaxBands,
      readSpectrumAtPixel: async () => Float32Array.from({ length: 25 }, (_v, i) => i),
      wavelengthArrayOrNull: () => Array.from({ length: 25 }, (_v, i) => i)
    });

    await ctrl.openSpectrumAt(ds, 0, 0);
    specCtx.moveTo.mockClear();
    specCtx.lineTo.mockClear();
    specCtx.setLineDash.mockClear();
    textLabels.length = 0;

    handlers.get("pointermove")?.({
      clientX: 111,
      clientY: 80,
      pointerId: 1,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    });

    expect(specCtx.setLineDash).toHaveBeenCalledWith([]);
    expect(specCtx.moveTo).toHaveBeenCalledWith(111, 12);
    expect(specCtx.lineTo).toHaveBeenCalledWith(111, 146);
    expect(textLabels).toContain("value = 6.000");
  });

  test("spectrum hover snaps to the nearest discrete band", async () => {
    globalThis.requestAnimationFrame = (cb) => {
      cb();
      return 1;
    };

    const handlers = new Map();
    const textLabels = [];
    const drawnText = [];
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
      fillText: vi.fn(function recordText(text) {
        textLabels.push(String(text));
        drawnText.push({ text: String(text), font: this.font, fillStyle: this.fillStyle });
      }),
      measureText: vi.fn((text) => ({ width: String(text).length * 6 })),
      textAlign: "",
      textBaseline: "",
      lineWidth: 1,
      strokeStyle: "",
      fillStyle: "",
      font: ""
    };
    const specCanvas = {
      width: 0,
      height: 0,
      style: { cursor: "" },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 180 }),
      addEventListener: (type, handler) => { handlers.set(type, handler); },
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn()
    };
    const els = {
      specPanel: { style: { display: "none" } },
      specCanvas,
      specSub: { textContent: "" },
      specWarn: { textContent: "", style: { display: "none" } },
      specFoot: { textContent: "" }
    };
    const ds = {
      id: 24,
      name: "dfir-demo",
      activeBand: 0,
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
      discreteBarMaxBands: APP_CONFIG.spectrum.discreteBarMaxBands,
      readSpectrumAtPixel: async () => new Float32Array([1, 4, 2, 3]),
      wavelengthArrayOrNull: () => [1000, 1100, 1200, 1300]
    });

    await ctrl.openSpectrumAt(ds, 0, 0);
    specCtx.moveTo.mockClear();
    specCtx.lineTo.mockClear();
    textLabels.length = 0;
    drawnText.length = 0;

    handlers.get("pointermove")?.({
      clientX: 120,
      clientY: 80,
      pointerId: 1,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    });

    const snappedX = 52 + ((1100 - 1000) / (1300 - 1000)) * 236;
    expect(specCtx.moveTo).toHaveBeenCalledWith(snappedX, 12);
    expect(specCtx.lineTo).toHaveBeenCalledWith(snappedX, 146);
    expect(textLabels).toContain("value = 4.000");
    expect(textLabels).toContain("1100");
    expect(drawnText.find(({ text }) => text === "1100")?.font).toContain("14px");
    expect(drawnText.find(({ text }) => text === "1000")?.font).toContain("14px");
    expect(drawnText.find(({ text }) => text === "1000")?.fillStyle).toBe("rgba(229,231,235,0.34)");
  });

  test("terminal x and y axis labels edit inline and blank values reset to auto range", async () => {
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
      measureText: vi.fn((text) => ({ width: String(text).length * 6 })),
      textAlign: "",
      textBaseline: "",
      lineWidth: 1,
      strokeStyle: "",
      fillStyle: "",
      font: ""
    };
    const specPanel = document.createElement("div");
    specPanel.style.display = "none";
    specPanel.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 220 });
    const specCanvas = document.createElement("canvas");
    specCanvas.style.cursor = "";
    specCanvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 180 });
    specPanel.appendChild(specCanvas);
    const els = {
      specPanel,
      specCanvas,
      specSub: { textContent: "" },
      specWarn: { textContent: "", style: { display: "none" } },
      specFoot: { textContent: "" }
    };
    const ds = {
      id: 22,
      name: "axis-edit-demo",
      activeBand: 1,
      meta: { bands: 3, wlUnits: "nm", scale: null, bandNames: ["a", "b", "c"] }
    };
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});

    const ctrl = createSpectrumController({
      els,
      specCtx,
      getActive: () => ds,
      bandLabel: (_ds, b) => `B${b}`,
      updatePerf: vi.fn(),
      sanitizeFilePart: (s) => s,
      downloadBlob: vi.fn(),
      discreteBarMaxBands: APP_CONFIG.spectrum.discreteBarMaxBands,
      readSpectrumAtPixel: async () => new Float32Array([1, 2, 3]),
      wavelengthArrayOrNull: () => [500, 600, 700]
    });

    await ctrl.openSpectrumAt(ds, 0, 0);
    specCtx.fillText.mockClear();

    specCanvas.dispatchEvent(new MouseEvent("dblclick", { clientX: 53, clientY: 154, bubbles: true }));
    let input = specPanel.querySelector(".spec-axis-editor");
    expect(input).not.toBeNull();
    input.value = "550";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(specPanel.querySelector(".spec-axis-editor")).toBeNull();
    expect(specCtx.fillText).toHaveBeenCalledWith("550.0", 52, 152);

    specCtx.fillText.mockClear();
    specCanvas.dispatchEvent(new MouseEvent("dblclick", { clientX: 53, clientY: 154, bubbles: true }));
    input = specPanel.querySelector(".spec-axis-editor");
    input.value = "";
    input.dispatchEvent(new FocusEvent("blur"));
    expect(specCtx.fillText).toHaveBeenCalledWith("500.0", 52, 152);

    specCtx.fillText.mockClear();
    specCanvas.dispatchEvent(new MouseEvent("dblclick", { clientX: 40, clientY: 15, bubbles: true }));
    input = specPanel.querySelector(".spec-axis-editor");
    expect(input).not.toBeNull();
    input.value = "5";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(specCtx.fillText).toHaveBeenCalledWith("5.000", 44, 12);

    specCtx.fillText.mockClear();
    specCanvas.dispatchEvent(new MouseEvent("dblclick", { clientX: 40, clientY: 15, bubbles: true }));
    input = specPanel.querySelector(".spec-axis-editor");
    input.value = "";
    input.dispatchEvent(new FocusEvent("blur"));
    expect(specCtx.fillText).toHaveBeenCalledWith("3.120", 44, 12);
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
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
      measureText: vi.fn((text) => ({ width: String(text).length * 6 })),
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
      discreteBarMaxBands: APP_CONFIG.spectrum.discreteBarMaxBands,
      readSpectrumAtPixel,
      wavelengthArrayOrNull: () => [500, 600, 700]
    });

    await ctrl.showPendingSpectrum(ds, 0, 0, {
      subLabel: "Area average (computing...)",
      footLabel: "Computing 0/3 bands",
      placeholderText: "Computing area average..."
    });

    expect(readSpectrumAtPixel).not.toHaveBeenCalled();
    expect(els.specPanel.style.display).toBe("flex");
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
      measureText: vi.fn((text) => ({ width: String(text).length * 6 })),
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
      discreteBarMaxBands: APP_CONFIG.spectrum.discreteBarMaxBands,
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
      measureText: vi.fn((text) => ({ width: String(text).length * 6 })),
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
      discreteBarMaxBands: APP_CONFIG.spectrum.discreteBarMaxBands,
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
