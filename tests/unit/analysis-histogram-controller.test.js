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
    expect(panel.style.display).toBe("block");
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
});
