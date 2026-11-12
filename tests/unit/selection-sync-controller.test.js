import { afterEach, describe, expect, test, vi } from "vitest";
import { createSelectionSyncController } from "../../src/app/selection-sync-controller.js";

afterEach(() => vi.restoreAllMocks());

describe("selection-sync-controller", () => {
  test("selection invalidates old results and prioritizes data without calculating", () => {
    const ds = { id: "slide" }, items = [{ id: 1 }];
    const clear = vi.fn(), invalidate = vi.fn(), prioritize = vi.fn(), calculate = vi.fn();
    const controller = createSelectionSyncController({
      getActive: () => ds, getHistogramSelectionItems: () => items,
      clearSelectionHistogram: clear, invalidateAnalysis: invalidate,
      prioritizeSelection: prioritize, shouldAnimateMarquee: () => false,
      updateSelectionHistogram: calculate, refreshAnalysisHistogram: calculate,
      openSpectrumForEffectiveArea: calculate
    });
    controller.updateSelectionHistogramForDataset(ds);
    expect(clear).toHaveBeenCalledWith(ds);
    expect(invalidate).toHaveBeenCalledWith(ds);
    expect(prioritize).toHaveBeenCalledWith(ds, items);
    expect(calculate).not.toHaveBeenCalled();
  });
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
