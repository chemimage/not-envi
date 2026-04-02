import { describe, expect, test, vi } from "vitest";
import { createSelectionSyncController } from "../../src/app/selection-sync-controller.js";

describe("selection-sync-controller", () => {
  test("does not start the marquee timer when animation is disabled", () => {
    const ds = { id: "ds1" };
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    const ctrl = createSelectionSyncController({
      state: { analysisHist: { open: false }, spectrumPickEnabled: false, activeId: "ds1" },
      getActive: () => ds,
      getHistogramSelectionItems: () => [{ id: 1 }],
      clearSelectionHistogram: vi.fn(),
      refreshAnalysisHistogram: vi.fn(async () => {}),
      updateSelectionHistogram: vi.fn(async () => {}),
      getSpectrumOpenForDatasetId: () => false,
      openSpectrumForEffectiveArea: vi.fn(async () => {}),
      refreshAreaSpectrumIfOpen: vi.fn(),
      drawOverlays: vi.fn(),
      shouldAnimateMarquee: () => false
    });

    ctrl.ensureMarqueeTicker();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  test("stops an existing marquee timer when animation becomes disabled", () => {
    const ds = { id: "ds1" };
    let animate = true;
    const setIntervalSpy = vi.spyOn(window, "setInterval").mockImplementation(() => 123);
    const clearIntervalSpy = vi.spyOn(window, "clearInterval").mockImplementation(() => {});
    const ctrl = createSelectionSyncController({
      state: { analysisHist: { open: false }, spectrumPickEnabled: false, activeId: "ds1" },
      getActive: () => ds,
      getHistogramSelectionItems: () => [{ id: 1 }],
      clearSelectionHistogram: vi.fn(),
      refreshAnalysisHistogram: vi.fn(async () => {}),
      updateSelectionHistogram: vi.fn(async () => {}),
      getSpectrumOpenForDatasetId: () => false,
      openSpectrumForEffectiveArea: vi.fn(async () => {}),
      refreshAreaSpectrumIfOpen: vi.fn(),
      drawOverlays: vi.fn(),
      shouldAnimateMarquee: () => animate
    });

    ctrl.ensureMarqueeTicker();
    animate = false;
    ctrl.ensureMarqueeTicker();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledWith(123);
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
