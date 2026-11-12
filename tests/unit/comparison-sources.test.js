import { describe, expect, test, vi } from "vitest";
import { createComparisonSources } from "../../src/app/comparison-sources.js";

describe("comparison result provenance", () => {
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
      opts: { plotSlot: 1 }, source: { type: "pixel" } });
    const entry = publish.mock.calls[0][0];
    expect(entry.check()).toBe("ready");
    sources.clearPoints(ds.id);
    expect(entry.check()).toBe("deleted");
    entry.deleteSource();
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ dsId: 1, point: { x: 3, y: 4 } }));
  });
});
