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
      rulerMove: null,
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

  test("rect tool allows dragging an area from interior", () => {
    const { ds, deps } = makeBase();
    const ann = createAnnotationController(deps);
    ann.setDrawTool("rect");

    const down = { pointerId: 11, pointerType: "mouse", clientX: 4, clientY: 4 };
    expect(ann.beginAreaMoveAtPointer(down)).toBe(true);
    expect(ann.isAreaMovePointer(11)).toBe(true);

    ann.updateAreaMoveAtPointer({ pointerId: 11, pointerType: "mouse", clientX: 6, clientY: 7 });
    expect(ds.drawings[0].points[0]).toEqual({ x: 4, y: 5 });
    expect(ds.drawings[0].points[1]).toEqual({ x: 10, y: 11 });

    ann.finishAreaMoveAtPointer({ pointerId: 11, pointerType: "mouse", clientX: 6, clientY: 7 });
    expect(ann.isAreaMovePointer(11)).toBe(false);
  });

  test("rect tool corner hit resizes rectangle", () => {
    const { ds, deps } = makeBase();
    const ann = createAnnotationController(deps);
    ann.setDrawTool("rect");

    const down = { pointerId: 12, pointerType: "mouse", clientX: 2.1, clientY: 2.1 };
    expect(ann.beginAreaMoveAtPointer(down)).toBe(true);

    ann.updateAreaMoveAtPointer({ pointerId: 12, pointerType: "mouse", clientX: 1, clientY: 1 });
    expect(ds.drawings[0].points[0]).toEqual({ x: 1, y: 1 });
    expect(ds.drawings[0].points[1]).toEqual({ x: 8, y: 8 });
  });

  test("ruler tool allows dragging ruler body", () => {
    const { ds, deps } = makeBase();
    ds.drawings.push({ id: 9, tool: "ruler", color: "#fff", points: [{ x: 2, y: 2 }, { x: 42, y: 42 }] });
    const ann = createAnnotationController(deps);
    ann.setDrawTool("ruler");

    expect(ann.beginDrawingAtPointer({ pointerId: 13, pointerType: "mouse", clientX: 20, clientY: 19.8 })).toBe(true);
    ann.updateDrawingAtPointer({ pointerId: 13, pointerType: "mouse", clientX: 22, clientY: 20.8 });
    const ruler = ds.drawings.find((item) => item.id === 9);
    expect(ruler.points[0]).toEqual({ x: 4, y: 3 });
    expect(ruler.points[1]).toEqual({ x: 44, y: 43 });
    ann.finishDrawingAtPointer({ pointerId: 13, pointerType: "mouse", clientX: 22, clientY: 20.8 });
  });

  test("cursor resolves to grab for handles and move for movable regions", () => {
    const { ds, deps } = makeBase();
    ds.drawings.push({ id: 9, tool: "ruler", color: "#fff", points: [{ x: 2, y: 2 }, { x: 42, y: 42 }] });
    const ann = createAnnotationController(deps);

    ann.setDrawTool("ruler");
    expect(ann.resolvePointerCursor({ pointerType: "mouse", clientX: 2.2, clientY: 2.1 })).toBe("grab");
    expect(ann.resolvePointerCursor({ pointerType: "mouse", clientX: 20, clientY: 20.1 })).toBe("move");

    ann.setDrawTool("rect");
    expect(ann.resolvePointerCursor({ pointerType: "mouse", clientX: 2.1, clientY: 2.1 })).toBe("grab");
    expect(ann.resolvePointerCursor({ pointerType: "mouse", clientX: 5, clientY: 5 })).toBe("move");
  });
});
