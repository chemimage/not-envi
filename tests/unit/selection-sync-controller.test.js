import { afterEach, describe, expect, test, vi } from "vitest";
import { createSelectionSyncController } from "../../src/app/selection-sync-controller.js";

afterEach(() => vi.restoreAllMocks());

describe("selection-sync-controller", () => {
  test("starts the marquee timer only when enabled and stops it when disabled", () => {
    const ds = { id: "ds1" };
    let animate = false;
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
    expect(setIntervalSpy).not.toHaveBeenCalled();

    animate = true;
    ctrl.ensureMarqueeTicker();
    animate = false;
    ctrl.ensureMarqueeTicker();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledWith(123);
  });
});
