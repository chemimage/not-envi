import { describe, expect, test, vi } from "vitest";
import { createComparisonSources } from "../../src/app/comparison-sources.js";

describe("comparison result provenance", () => {
  test("histogram recalculation replaces the same color's result and keeps selection scoped to its region", () => {
    const publish = vi.fn(), ds = { id: 1, meta: {}, ds: {} };
    const red = { id: 1, color: "#ff2d2d", points: [{ x: 0, y: 0 }] };
    const blue = { ...red, id: 2, color: "#0ea5e9" }, red2 = { ...red, id: 3 };
    const selection = { dsId: 1, slot: 1, items: [red, blue, red2], selectedAreaId: 2, band: 0 };
    const sources = createComparisonSources({ comparisons: { publish }, getDataset: () => ds,
      getPanel: () => ({ datasetId: 1, annotations: { drawings: selection.items } }), getSelection: () => selection });
    const stats = { bins: [1, 2], min: 0, max: 2, count: 3 };
    sources.histogram({ ds, slot: 1, items: [red], stats, band: 0, color: red.color });
    sources.histogram({ ds, slot: 1, items: [red, red2], stats, band: 0, color: red.color });
    const original = publish.mock.calls[0][0], updated = publish.mock.calls[1][0];
    expect(updated.id).toBe(original.id);
    expect(updated.isSelected()).toBe(false);
    selection.selectedAreaId = 3;
    expect(updated.isSelected()).toBe(true);
    sources.histogram({ ds, slot: 1, items: [blue], stats, band: 0, color: blue.color });
    expect(publish.mock.calls[2][0].id).not.toBe(original.id);
  });
  test("selected source follows current regions, histogram band and point coordinates", () => {
    const publish = vi.fn(), ds = { id: 1, meta: {}, ds: {} };
    const item = { id: 7, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] };
    let selection = { dsId: 1, slot: 1, items: [item], band: 0, point: null };
    const sources = createComparisonSources({ comparisons: { publish }, getDataset: () => ds,
      getPanel: () => ({ datasetId: 1, annotations: { drawings: [item] } }), getSelection: () => selection, deleteSources() {} });
    sources.histogram({ ds, slot: 1, items: [item], stats: { bins: [1, 2], min: 0, max: 2, count: 3 }, band: 0 });
    const hist = publish.mock.calls[0][0];
    expect(hist.isSelected()).toBe(true);
    selection.band = 1; expect(hist.isSelected()).toBe(false);
    selection = { dsId: 1, slot: 1, items: [], point: { x: 3, y: 4 }, band: 0 };
    sources.spectrum({ ds, ix: 3, iy: 4, xVals: null, yVals: [1, 2], opts: { plotSlot: 1 }, source: { type: "pixel" } });
    const point = publish.mock.calls[1][0];
    expect(point.isSelected()).toBe(true);
    selection.point.x = 4; expect(point.isSelected()).toBe(false);
    expect(hist.isSelected()).toBe(false);
  });

  test("geometry and calibration changes invalidate results; recalculation replaces the same trace", () => {
    const publish = vi.fn(), remove = vi.fn();
    const ds = { id: 1, name: "Image", meta: { scale: { umPerPixelX: 2, umPerPixelY: 3 } }, ds: {} };
    const item = { id: 7, color: "#ff2d2d", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] };
    const panel = { datasetId: 1, annotations: { drawings: [item] } };
    let loaded = true;
    const sources = createComparisonSources({ comparisons: { publish }, getPanel: () => panel,
      getDataset: () => loaded ? ds : null, deleteSources: remove });
    const args = { anchor: { slot: 1 }, target: { ds, item, band: 0 },
      result: { values: new Float32Array([1, 2]), lengthPx: 10 } };
    sources.line(args);
    const original = publish.mock.calls[0][0];
    expect(original.check()).toBe("ready");
    item.points[1].x = 20;
    expect(original.check()).toBe("changed");
    sources.line(args);
    const updated = publish.mock.calls[1][0];
    expect(updated.id).toBe(original.id);
    expect(updated.check()).toBe("ready");
    ds.meta.scale.umPerPixelX = 4;
    expect(updated.check()).toBe("changed");
    panel.annotations.drawings = [];
    expect(original.check()).toBe("deleted");
    loaded = false;
    expect(updated.check()).toBe("deleted");
  });

  test("retained point plots are cleared without treating a moved point as a deleted annotation", () => {
    const publish = vi.fn(), remove = vi.fn();
    const ds = { id: 1, meta: {}, ds: {} };
    const sources = createComparisonSources({ comparisons: { publish }, getDataset: () => ds,
      getPanel: () => null, deleteSources: remove });
    sources.spectrum({ ds, ix: 3, iy: 4, yVals: [1, 2], xVals: null,
      opts: { plotSlot: 1 }, plotStyle: "bar", source: { type: "pixel" } });
    const entry = publish.mock.calls[0][0];
    expect(entry.plotStyle).toBe("bar");
    expect(entry.check()).toBe("ready");
    sources.clearPoints(ds.id);
    expect(entry.check()).toBe("deleted");
    entry.deleteSource();
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ dsId: 1, point: { x: 3, y: 4 } }));
  });
});
