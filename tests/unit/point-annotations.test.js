import { describe, expect, test } from "vitest";
import { savePointAnnotation, removePointAnnotation } from "../../src/app/point-annotations.js";
import { createComparisonSources } from "../../src/app/comparison-sources.js";

describe("point annotation ownership", () => {
  test("colors keep independent anchors; moving a point preserves its identity and invalidates its result", () => {
    const state = { draw: { color: "#ff2d2d", nextItemId: 1 } };
    const ds = { id: 1, drawings: [], meta: {}, ds: {} };
    const panel = { slot: 1, datasetId: 1, annotations: { drawings: ds.drawings } };
    const red = savePointAnnotation(state, ds, panel, { x: 3, y: 4 });
    let entry;
    const sources = createComparisonSources({ comparisons: { publish: result => { entry = result; } },
      getPanel: () => panel, getDataset: () => ds, getSelection: () => ({ dsId: 1, slot: 1, point: red }) });
    sources.spectrum({ ds, ix: 3, iy: 4, yVals: [1, 2], opts: { plotSlot: 1, plotPoint: red }, source: { type: "pixel", color: red.color } });
    expect(entry.check()).toBe("ready");
    state.draw.color = "#22c55e";
    const green = savePointAnnotation(state, ds, panel, { x: 3, y: 4 });
    expect(green.id).not.toBe(red.id);
    expect(entry.check()).toBe("ready");
    expect(ds.drawings).toHaveLength(2);
    state.draw.color = "#FF2D2D";
    const moved = savePointAnnotation(state, ds, panel, { x: 8, y: 9 });
    expect(moved.id).toBe(red.id);
    expect(red).toMatchObject({ x: 3, y: 4, color: "#ff2d2d" });
    expect(ds.drawings.find(item => item.id === green.id).points).toEqual([{ x: 3, y: 4 }]);
    expect(entry.check()).toBe("changed");
    removePointAnnotation(ds.drawings, red);
    expect(entry.check()).toBe("deleted");
    expect(ds.drawings.map(item => item.id)).toEqual([green.id]);
  });
});
