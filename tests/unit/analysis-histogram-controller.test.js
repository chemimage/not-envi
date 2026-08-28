import { describe, expect, test, vi } from "vitest";
import { createAnalysisHistogramController } from "../../src/app/analysis-histogram-controller.js";

function makeButton() {
  const btn = document.createElement("button");
  btn.className = "draw-tool-btn";
  return btn;
}

describe("analysis-histogram-controller", () => {
  test("setOpen toggles panel visibility and button pressed state", async () => {
    const panel = document.createElement("div");
    panel.style.display = "none";
    panel.setAttribute("aria-hidden", "true");
    panel.getBoundingClientRect = () => ({ width: 380, height: 260 });

    const btn = makeButton();
    btn.getBoundingClientRect = () => ({ right: 120, top: 60 });

    const state = { analysisHist: { open: false, hoverBin: -1, stats: null } };
    const ctrl = createAnalysisHistogramController({
      state,
      els: {
        analysisHistPanel: panel,
        btnToolHistogram: btn,
        main: { getBoundingClientRect: () => ({ width: 800, height: 600 }) }
      },
      clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
      fmtNoGroup: (n) => String(n),
      formatNumber: (n) => String(n),
      getActive: () => null,
      getHistogramSelectionItems: () => [],
      histogramSelectionKeyFromItems: () => "",
      updateSelectionHistogram: async () => {},
      buildBandStatsWhole: async () => {},
      computeHistogram: () => null,
      resolveEffectiveSelectionBounds: () => null,
      resolveSelectionBoundsList: () => [],
      listHistogramSelectionItems: () => [],
      setStatus: vi.fn()
    });

    ctrl.setOpen(true);
    await Promise.resolve();
    expect(state.analysisHist.open).toBe(true);
    expect(panel.style.display).toBe("flex");
    expect(panel.getAttribute("aria-hidden")).toBe("false");
    expect(btn.classList.contains("active")).toBe(true);
    expect(btn.getAttribute("aria-pressed")).toBe("true");

    ctrl.setOpen(false);
    expect(state.analysisHist.open).toBe(false);
    expect(panel.style.display).toBe("none");
    expect(panel.getAttribute("aria-hidden")).toBe("true");
    expect(btn.classList.contains("active")).toBe(false);
    expect(btn.getAttribute("aria-pressed")).toBe("false");
  });

  test("refresh shows an approximation warning for subsampled stats", async () => {
    const panel = document.createElement("div");
    panel.style.display = "block";
    panel.setAttribute("aria-hidden", "false");
    panel.getBoundingClientRect = () => ({ width: 380, height: 260 });

    const drawnText = [];
    const canvasCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(function recordText(text) {
        drawnText.push({ text, font: this.font, textAlign: this.textAlign });
      }),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      strokeRect: vi.fn(),
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      font: ""
    };
    const canvas = document.createElement("canvas");
    canvas.getBoundingClientRect = () => ({ width: 320, height: 180, left: 0, top: 0 });
    canvas.getContext = () => canvasCtx;

    const warning = document.createElement("div");
    warning.style.display = "none";
    const hover = document.createElement("div");
    const btn = makeButton();
    btn.getBoundingClientRect = () => ({ right: 120, top: 60 });

    const stats = {
      bins: [1, 2, 3],
      count: 6,
      min: 0,
      max: 3,
      mean: 1.5,
      stdDev: 0.5,
      rms: 2.25,
      mode: 2,
      binWidth: 1,
      sampleStep: 3,
      trueRawSamples: false,
      samplingMode: "selection-subsampled"
    };
    const ds = {
      id: "ds1",
      activeBand: 0,
      bandStatsWhole: new Map(),
      bandStatsSelection: { band: 0, selectionKey: "1", stats }
    };
    const state = { analysisHist: { open: true, hoverBin: -1, stats: null } };
    const ctrl = createAnalysisHistogramController({
      state,
      els: {
        analysisHistPanel: panel,
        analysisHistCanvas: canvas,
        analysisHistHover: hover,
        analysisHistWarning: warning,
        btnToolHistogram: btn,
        main: { getBoundingClientRect: () => ({ width: 800, height: 600 }) }
      },
      clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
      fmtNoGroup: (n) => String(n),
      formatNumber: (n) => String(n),
      getActive: () => ds,
      getHistogramSelectionItems: () => [{ id: 1 }],
      histogramSelectionKeyFromItems: () => "1",
      updateSelectionHistogram: async () => {},
      buildBandStatsWhole: async () => {},
      computeHistogram: () => null,
      resolveEffectiveSelectionBounds: () => null,
      resolveSelectionBoundsList: () => [],
      listHistogramSelectionItems: () => [],
      setStatus: vi.fn()
    });

    await ctrl.refresh();

    expect(warning.style.display).toBe("block");
    expect(warning.textContent).toContain("Approximate:");
    expect(warning.textContent).toContain("3");
    expect(canvasCtx.fillText).toHaveBeenCalledWith("bins", expect.any(Number), expect.any(Number));
    expect(canvasCtx.fillText).toHaveBeenCalledWith("bin width", expect.any(Number), expect.any(Number));
    expect(canvasCtx.fillText).toHaveBeenCalledWith("=", expect.any(Number), expect.any(Number));
    expect(canvasCtx.fillText).toHaveBeenCalledWith("mean = 1.5", expect.any(Number), expect.any(Number));
    expect(canvasCtx.fillText).toHaveBeenCalledWith("std = 0.5", expect.any(Number), expect.any(Number));
    expect(canvasCtx.fillText).toHaveBeenCalledWith("rms = 2.25", expect.any(Number), expect.any(Number));
    expect(canvasCtx.fillText).toHaveBeenCalledWith("N = 6", expect.any(Number), expect.any(Number));
    expect(canvasCtx.fillText).toHaveBeenCalledWith("mode = 2", expect.any(Number), expect.any(Number));
    expect(canvasCtx.fillText).toHaveBeenCalledWith("0", expect.any(Number), expect.any(Number));
    expect(canvasCtx.fillText).toHaveBeenCalledWith("3", expect.any(Number), expect.any(Number));
    expect(drawnText.find(({ text }) => text === "rms = 2.25")?.font).toContain("14px");
    expect(drawnText.find(({ text }) => text === "N = 6")?.font).toContain("14px");
    const binsLabelIndex = drawnText.findIndex(({ text }) => text === "bins");
    expect(drawnText[binsLabelIndex]).toMatchObject({ font: expect.stringContaining("12px"), textAlign: "right" });
    expect(drawnText[binsLabelIndex + 2]).toMatchObject({ text: "3", textAlign: "left" });
    expect(canvasCtx.fillRect).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), 140, 40);
  });
});
