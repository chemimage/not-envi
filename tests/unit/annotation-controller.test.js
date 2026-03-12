import { describe, expect, test, vi } from "vitest";
import { createAnnotationController } from "../../src/app/annotation-controller.js";

function makeBase() {
  const state = {
    activeId: 1,
    spectrumPickEnabled: false,
    areaSelectionMode: "single",
    analysisHist: { open: false },
    draw: {
      tool: "none",
      color: "#22c55e",
      activePointerId: null,
      draft: null,
      rulerDrag: null,
      rulerHover: null,
      areaMove: null,
      nextItemId: 10
    }
  };
  const ds = {
    id: 1,
    selectedAreaId: null,
    view: { scale: 1 },
    meta: { samples: 100, lines: 80 },
    drawings: [
      { id: 1, tool: "rect", color: "#fff", points: [{ x: 2, y: 2 }, { x: 8, y: 8 }] },
      { id: 2, tool: "shape", color: "#fff", points: [{ x: 20, y: 20 }, { x: 26, y: 20 }, { x: 23, y: 26 }] }
    ]
  };
  const els = {
    main: {
      getBoundingClientRect: () => ({ left: 0, top: 0 })
    }
  };
  const render = vi.fn();
  const deps = {
    state,
    els,
    clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
    getActive: () => ds,
    screenToImage: (sx, sy) => ({ x: sx, y: sy }),
    render,
    getSpectrumOpenForDatasetId: () => false,
    openSpectrumAt: async () => {},
    positionAnalysisHistogramPanel: () => {},
    updateSelectionHistogramForDataset: vi.fn(),
    ensureMarqueeTicker: vi.fn(),
    refreshAnalysisHistogram: async () => {},
    isAnalysisHistogramOpen: () => false,
    isDatasetActive: (target) => target?.id === state.activeId
  };
  return { state, ds, deps, render };
}

describe("annotation-controller", () => {
  test("single mode defaults to latest selection and group mode returns all", () => {
    const { ds, deps } = makeBase();
    const ann = createAnnotationController(deps);

    const single = ann.getHistogramSelectionItems(ds);
    expect(single).toHaveLength(1);
    expect(single[0].id).toBe(2);

    ann.setAreaSelectionMode("group");
    const grouped = ann.getHistogramSelectionItems(ds);
    expect(grouped).toHaveLength(2);
    expect(grouped.map((v) => v.id)).toEqual([1, 2]);
  });

  test("setting a draw tool disables spectral pick and toggles tool selection", () => {
    const { state, deps } = makeBase();
    const ann = createAnnotationController(deps);

    ann.setSpectrumPickEnabled(true);
    expect(state.spectrumPickEnabled).toBe(true);

    ann.setDrawTool("rect");
    expect(state.spectrumPickEnabled).toBe(false);
    expect(ann.getDrawTool()).toBe("rect");

    ann.setDrawTool("rect");
    expect(ann.getDrawTool()).toBe("none");
  });
});
