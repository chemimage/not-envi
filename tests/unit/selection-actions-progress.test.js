import { describe, expect, test } from "vitest";
import { createAnnotationWorkTracker } from "../../src/app/annotation-work.js";
import { createSelectionActionsController } from "../../src/app/selection-actions.js";

describe("annotation edge progress", () => {
  test("tracks each region, follows its edge, and clears only settled or removed work", () => {
    const root = document.createElement("div");
    const toolbar = document.createElement("div");
    root.append(toolbar);
    Object.defineProperties(toolbar, { offsetWidth: { value: 116 }, offsetHeight: { value: 36 } });
    const a = { id: 1, points: [{ x: 100, y: 200 }, { x: 300, y: 280 }] };
    const b = { id: 2, points: [{ x: 400, y: 100 }, { x: 450, y: 400 }] };
    const ds = { id: "slide", view: { x: 0, y: 0, scale: 1 }, drawings: [a, b] };
    const panel = { slot: 1, view: ds.view, annotations: { drawings: ds.drawings } };
    let dataFraction = 1;
    let controller;
    const tracker = createAnnotationWorkTracker(() => controller?.refresh());
    controller = createSelectionActionsController({
      state: { draw: { tool: "none" }, analysisHist: { open: false } },
      els: { selectionActions: toolbar, cpuCanvas: { width: 1200, height: 800 },
        btnToolHistogram: document.createElement("button"), btnToolSpectral: document.createElement("button") },
      getActive: () => ds, getActivePanel: () => panel,
      getPanelRectDevice: () => ({ x: 0, y: 0, w: 1200, h: 800 }),
      getHistogramSelectionItems: () => ds.drawings.slice(0, 1),
      getDataProgress: () => dataFraction,
      annotationWork: tracker
    });
    dataFraction = 0.5;
    controller.refresh();
    let dataBar = root.querySelector(".annotation-progress");
    expect(dataBar.title).toBe("");
    expect(dataBar.firstChild.style.transform).toBe("scaleX(0.5)");
    expect(dataBar.lastChild.style.transform).toBe("scaleX(0)");
    const first = tracker.begin(ds, { items: [a], label: "Histogram" });
    const second = tracker.begin(ds, { items: [b], label: "Spectrum" });
    let bars = root.querySelectorAll("[role='progressbar']");
    expect(bars).toHaveLength(2);
    expect(bars[0].style.left).toBe("100px");
    expect(bars[0].style.top).toBe("198px");
    expect(bars[0].style.width).toBe("200px");
    expect(bars[1].dataset.orientation).toBe("vertical");
    expect(bars[1].style.left).toBe("448px");
    expect(bars[0].hasAttribute("aria-valuenow")).toBe(false);
    second.update(1, 4);
    expect(bars[1].getAttribute("aria-valuenow")).toBe("25");
    ds.view.x = 20;
    controller.refresh();
    expect(bars[0].style.left).toBe("80px");
    dataFraction = 1;
    first.done();
    bars = root.querySelectorAll("[role='progressbar']");
    expect(bars).toHaveLength(1);
    expect(bars[0].getAttribute("aria-label")).toBe("Spectrum");
    ds.drawings.splice(1, 1);
    controller.refresh();
    expect(root.querySelectorAll("[role='progressbar']")).toHaveLength(0);
    second.done();
  });

  test("refresh is safe before a dataset is opened", () => {
    const toolbar = document.createElement("div");
    const parent = document.createElement("div");
    parent.append(toolbar);
    const controller = createSelectionActionsController({
      state: { draw: { tool: "none" }, contextPoint: null },
      els: { selectionActions: toolbar, cpuCanvas: { width: 100, height: 100 } },
      getActive: () => null, getActivePanel: () => null, getPanelRectDevice: () => null,
      annotationWork: createAnnotationWorkTracker()
    });
    expect(() => controller.refresh()).not.toThrow();
    expect(toolbar.hidden).toBe(true);
  });
});
