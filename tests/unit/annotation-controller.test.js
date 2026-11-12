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
      shapeMode: "rect",
      activePointerId: null,
      draft: null,
      rulerDrag: null,
      rulerMove: null,
      rulerProfileDrag: null,
      rulerProfileHover: null,
      rulerHover: null,
      areaMove: null,
      nextItemId: 10
    }
  };
  const ds = {
    id: 1,
    selectedAreaId: null,
    view: { x: 0, y: 0, scale: 1 },
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
  const drawOverlays = vi.fn();
  const deps = {
    state,
    els,
    clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
    getActive: () => ds,
    screenToImage: (sx, sy) => ({ x: sx, y: sy }),
    render,
    drawOverlays,
    getSpectrumOpenForDatasetId: () => false,
    openSpectrumAt: async () => {},
    positionAnalysisHistogramPanel: () => {},
    updateSelectionHistogramForDataset: vi.fn(),
    ensureMarqueeTicker: vi.fn(),
    shouldAnimateMarquee: () => true,
    refreshAnalysisHistogram: async () => {},
    isAnalysisHistogramOpen: () => false,
    isDatasetActive: (target) => target?.id === state.activeId
  };
  return { state, ds, deps, render, drawOverlays };
}

describe("annotation-controller", () => {
  test("removing targeted areas preserves other areas and rulers", () => {
    const { ds, deps } = makeBase();
    ds.drawings.push({ id: 3, tool: "ruler", points: [{ x: 0, y: 0 }, { x: 9, y: 9 }] });
    ds.selectedAreaId = 2;
    const ann = createAnnotationController(deps);
    expect(ann.removeAreaAnnotations([2, 3])).toBe(true);
    expect(ds.drawings.map((item) => item.id)).toEqual([1, 3]);
    expect(ds.selectedAreaId).toBe(1);
    expect(deps.updateSelectionHistogramForDataset).toHaveBeenCalledWith(ds);
    expect(ann.removeAreaAnnotations([999])).toBe(false);
  });

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

  test("getDrawData disables marquee animation when the current layout should stay static", () => {
    const { ds, deps } = makeBase();
    deps.shouldAnimateMarquee = () => false;
    const ann = createAnnotationController(deps);

    const drawData = ann.getDrawData(ds);

    expect(drawData.selectionIds).toEqual([2]);
    expect(drawData.marqueeOffset).toBe(0);
  });

  test("changing shape mode updates active shape tool between rect and polygon", () => {
    const { deps } = makeBase();
    const ann = createAnnotationController(deps);

    ann.setDrawTool("rect");
    expect(ann.getDrawTool()).toBe("rect");
    expect(ann.getDrawShapeMode()).toBe("rect");

    ann.setDrawShapeMode("polygon");
    expect(ann.getDrawShapeMode()).toBe("polygon");
    expect(ann.getDrawTool()).toBe("shape");

    ann.setDrawShapeMode("3:4");
    expect(ann.getDrawShapeMode()).toBe("3:4");
    expect(ann.getDrawTool()).toBe("rect");
  });

  test("shape mode constrains rectangle drafts to the selected ratio", () => {
    const { ds, deps } = makeBase();
    const ann = createAnnotationController(deps);

    ann.setDrawShapeMode("3:4");
    ann.setDrawTool("rect");
    expect(ann.beginDrawingAtPointer({ pointerId: 19, pointerType: "mouse", clientX: 10, clientY: 10 })).toBe(true);
    ann.updateDrawingAtPointer({ pointerId: 19, pointerType: "mouse", clientX: 40, clientY: 20 });
    ann.finishDrawingAtPointer({ pointerId: 19, pointerType: "mouse", clientX: 40, clientY: 20 });

    const created = ds.drawings[ds.drawings.length - 1];
    expect(created.tool).toBe("rect");
    expect(created.shapeMode).toBe("3:4");
    const w = Math.abs(created.points[1].x - created.points[0].x);
    const h = Math.abs(created.points[1].y - created.points[0].y);
    expect(w / h).toBeCloseTo(4 / 3, 3);
  });

  test("ratio-locked rectangle corner resize preserves aspect ratio", () => {
    const { ds, deps } = makeBase();
    ds.drawings = [
      { id: 50, tool: "rect", shapeMode: "3:4", color: "#fff", points: [{ x: 10, y: 10 }, { x: 50, y: 40 }] }
    ];
    const ann = createAnnotationController(deps);
    ann.setDrawTool("rect");

    expect(ann.beginAreaMoveAtPointer({ pointerId: 60, pointerType: "mouse", clientX: 50, clientY: 40 })).toBe(true);
    ann.updateAreaMoveAtPointer({ pointerId: 60, pointerType: "mouse", clientX: 70, clientY: 55 });

    const resized = ds.drawings[0];
    const w = Math.abs(resized.points[1].x - resized.points[0].x);
    const h = Math.abs(resized.points[1].y - resized.points[0].y);
    expect(w / h).toBeCloseTo(4 / 3, 3);
  });

  test("ratio-locked rectangle edge resize preserves aspect ratio", () => {
    const { ds, deps } = makeBase();
    ds.drawings = [
      { id: 51, tool: "rect", shapeMode: "1:1", color: "#fff", points: [{ x: 20, y: 20 }, { x: 50, y: 50 }] }
    ];
    const ann = createAnnotationController(deps);
    ann.setDrawTool("rect");

    expect(ann.beginAreaMoveAtPointer({ pointerId: 61, pointerType: "mouse", clientX: 50, clientY: 35 })).toBe(true);
    ann.updateAreaMoveAtPointer({ pointerId: 61, pointerType: "mouse", clientX: 70, clientY: 35 });

    const resized = ds.drawings[0];
    const w = Math.abs(resized.points[1].x - resized.points[0].x);
    const h = Math.abs(resized.points[1].y - resized.points[0].y);
    expect(w / h).toBeCloseTo(1, 3);
  });

  test("bidirectional ratio resize allows 3:4 rectangles to become 4:3 on horizontal drag", () => {
    const { ds, deps } = makeBase();
    ds.drawings = [
      { id: 52, tool: "rect", shapeMode: "3:4", color: "#fff", points: [{ x: 30, y: 20 }, { x: 60, y: 60 }] }
    ];
    const ann = createAnnotationController(deps);
    ann.setDrawTool("rect");

    expect(ann.beginAreaMoveAtPointer({ pointerId: 62, pointerType: "mouse", clientX: 60, clientY: 40 })).toBe(true);
    ann.updateAreaMoveAtPointer({ pointerId: 62, pointerType: "mouse", clientX: 90, clientY: 40 });

    const resized = ds.drawings[0];
    const w = Math.abs(resized.points[1].x - resized.points[0].x);
    const h = Math.abs(resized.points[1].y - resized.points[0].y);
    expect(w / h).toBeCloseTo(4 / 3, 3);
  });

  test("polygon shape mode creates polygon selections", () => {
    const { ds, deps } = makeBase();
    const ann = createAnnotationController(deps);

    ann.setDrawShapeMode("polygon");
    ann.setDrawTool("shape");
    expect(ann.beginDrawingAtPointer({ pointerId: 20, pointerType: "mouse", clientX: 10, clientY: 10 })).toBe(true);
    ann.updateDrawingAtPointer({ pointerId: 20, pointerType: "mouse", clientX: 20, clientY: 10 });
    ann.updateDrawingAtPointer({ pointerId: 20, pointerType: "mouse", clientX: 20, clientY: 20 });
    ann.finishDrawingAtPointer({ pointerId: 20, pointerType: "mouse", clientX: 20, clientY: 20 });

    const created = ds.drawings[ds.drawings.length - 1];
    expect(created.tool).toBe("shape");
    expect(created.points.length).toBeGreaterThanOrEqual(3);
  });

  test("draft drawing repaints overlays immediately before final commit", () => {
    const { deps, render, drawOverlays } = makeBase();
    const ann = createAnnotationController(deps);

    ann.setDrawTool("rect");
    expect(ann.beginDrawingAtPointer({ pointerId: 88, pointerType: "mouse", clientX: 10, clientY: 10 })).toBe(true);
    ann.updateDrawingAtPointer({ pointerId: 88, pointerType: "mouse", clientX: 30, clientY: 24 });

    expect(drawOverlays).toHaveBeenCalledTimes(2);
    expect(render).not.toHaveBeenCalled();

    ann.finishDrawingAtPointer({ pointerId: 88, pointerType: "mouse", clientX: 30, clientY: 24 });
    expect(render).not.toHaveBeenCalled();
    expect(drawOverlays).toHaveBeenCalledTimes(4);
  });

  test("region moves paint overlays but defer analysis and raster work until release", () => {
    const { state, ds, deps, render, drawOverlays } = makeBase();
    state.spectrumPickEnabled = true;
    ds.selectedAreaId = 1;
    deps.getSpectrumOpenForDatasetId = () => true;
    deps.isAnalysisHistogramOpen = () => true;
    deps.openSpectrumAt = vi.fn(async () => {});
    const ann = createAnnotationController(deps);
    ann.beginAreaMoveAtPointer({ pointerId: 11, pointerType: "mouse", clientX: 4, clientY: 4 });
    for (let i = 1; i <= 60; i++) {
      ann.updateAreaMoveAtPointer({ pointerId: 11, pointerType: "mouse", clientX: 4 + i / 10, clientY: 4 });
    }
    expect(deps.updateSelectionHistogramForDataset).not.toHaveBeenCalled();
    expect(deps.openSpectrumAt).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(drawOverlays).toHaveBeenCalled();
    ann.finishAreaMoveAtPointer({ pointerId: 11, pointerType: "mouse", clientX: 11, clientY: 4 });
    expect(deps.updateSelectionHistogramForDataset).toHaveBeenCalledTimes(1);
    expect(ds.drawings[0].points[0]).toEqual({ x: 9, y: 2 });
    expect(render).not.toHaveBeenCalled();
  });

  test("cancelling a region move restores the geometry retained by its statistics", () => {
    const { state, ds, deps } = makeBase();
    state.spectrumPickEnabled = true;
    ds.selectedAreaId = 1;
    const original = structuredClone(ds.drawings[0].points);
    const ann = createAnnotationController(deps);
    ann.beginAreaMoveAtPointer({ pointerId: 22, pointerType: "mouse", clientX: 4, clientY: 4 });
    ann.updateAreaMoveAtPointer({ pointerId: 22, pointerType: "mouse", clientX: 9, clientY: 8 });
    ann.cancelAreaMove(22);
    expect(ds.drawings[0].points).toEqual(original);
    expect(deps.updateSelectionHistogramForDataset).not.toHaveBeenCalled();
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

  test("spectral mode allows dragging selected area with no draw tool", () => {
    const { state, ds, deps } = makeBase();
    state.spectrumPickEnabled = true;
    const ann = createAnnotationController(deps);

    const down = { pointerId: 77, pointerType: "mouse", clientX: 4, clientY: 4 };
    expect(ann.beginAreaMoveAtPointer(down)).toBe(true);
    expect(ann.isAreaMovePointer(77)).toBe(true);
    expect(ann.resolvePointerCursor({ pointerType: "mouse", clientX: 5, clientY: 5 })).toBe("move");

    ann.updateAreaMoveAtPointer({ pointerId: 77, pointerType: "mouse", clientX: 7, clientY: 6 });
    expect(ds.drawings[0].points[0]).toEqual({ x: 5, y: 4 });
    expect(ds.drawings[0].points[1]).toEqual({ x: 11, y: 10 });
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

  test("touch eraser removes large rectangles when tapped inside", () => {
    const { ds, deps } = makeBase();
    ds.drawings = [
      { id: 1, tool: "rect", color: "#fff", points: [{ x: 2, y: 2 }, { x: 80, y: 70 }] }
    ];
    const ann = createAnnotationController(deps);
    ann.setDrawTool("eraser");

    expect(ann.eraseDrawingAtPointer({ pointerType: "touch", clientX: 40, clientY: 35 })).toBe(true);
    expect(ds.drawings).toHaveLength(0);
  });

  test("ruler profile hover/drag uses stretch cursor and updates scale", () => {
    const { ds, deps } = makeBase();
    ds.drawings = [{ id: 21, tool: "ruler", color: "#fff", points: [{ x: 10, y: 20 }, { x: 50, y: 20 }] }];
    ds.activeBand = 0;
    ds.lastRaster = {
      band: 0,
      dataF32: new Float32Array(ds.meta.samples * ds.meta.lines).fill(3),
      w: ds.meta.samples,
      h: ds.meta.lines,
      step: 1,
      x0: 0,
      y0: 0
    };
    const ann = createAnnotationController(deps);
    ann.setDrawTool("ruler");

    expect(ann.resolvePointerCursor({ pointerType: "mouse", clientX: 30, clientY: 10 })).toBe("ns-resize");
    expect(ann.beginDrawingAtPointer({ pointerId: 31, pointerType: "mouse", clientX: 30, clientY: 10 })).toBe(true);
    ann.updateDrawingAtPointer({ pointerId: 31, pointerType: "mouse", clientX: 30, clientY: 0 });
    expect(ds.drawings[0].profileScale).toBeGreaterThan(1);
    ann.finishDrawingAtPointer({ pointerId: 31, pointerType: "mouse", clientX: 30, clientY: 0 });
  });

  test("ruler profile scale drag follows ruler-normal direction", () => {
    const { ds, deps } = makeBase();
    ds.drawings = [{ id: 22, tool: "ruler", color: "#fff", points: [{ x: 20, y: 10 }, { x: 20, y: 50 }] }];
    ds.activeBand = 0;
    ds.lastRaster = {
      band: 0,
      dataF32: new Float32Array(ds.meta.samples * ds.meta.lines).fill(3),
      w: ds.meta.samples,
      h: ds.meta.lines,
      step: 1,
      x0: 0,
      y0: 0
    };
    const ann = createAnnotationController(deps);
    ann.setDrawTool("ruler");

    expect(ann.beginDrawingAtPointer({ pointerId: 32, pointerType: "mouse", clientX: 10, clientY: 30 })).toBe(true);
    ann.updateDrawingAtPointer({ pointerId: 32, pointerType: "mouse", clientX: 10, clientY: 40 });
    expect(ds.drawings[0].profileScale || 1).toBeCloseTo(1, 3);
    ann.updateDrawingAtPointer({ pointerId: 32, pointerType: "mouse", clientX: 0, clientY: 40 });
    expect(ds.drawings[0].profileScale).toBeGreaterThan(1);
    ann.finishDrawingAtPointer({ pointerId: 32, pointerType: "mouse", clientX: 0, clientY: 40 });
  });

  test("new profile line preserves existing lines, including the same color", () => {
    const { ds, deps } = makeBase();
    ds.drawings = [
      { id: 30, tool: "ruler", color: "#ff2d2d", points: [{ x: 3, y: 3 }, { x: 9, y: 9 }] },
      { id: 31, tool: "ruler", color: "#22c55e", points: [{ x: 4, y: 12 }, { x: 10, y: 12 }] }
    ];
    const ann = createAnnotationController(deps);
    ann.setDrawTool("ruler");
    ann.setDrawColor("#ff2d2d");
    expect(ann.beginDrawingAtPointer({ pointerId: 41, pointerType: "mouse", clientX: 60, clientY: 60 })).toBe(true);
    ann.updateDrawingAtPointer({ pointerId: 41, pointerType: "mouse", clientX: 70, clientY: 70 });
    ann.finishDrawingAtPointer({ pointerId: 41, pointerType: "mouse", clientX: 70, clientY: 70 });

    const rulers = ds.drawings.filter((d) => d.tool === "ruler");
    expect(rulers).toHaveLength(3);
    expect(rulers.map((item) => item.id)).toContain(30);
    expect(rulers.some((r) => r.color.toLowerCase() === "#22c55e")).toBe(true);
    expect(rulers.some((r) => r.color.toLowerCase() === "#ff2d2d")).toBe(true);
  });
});
