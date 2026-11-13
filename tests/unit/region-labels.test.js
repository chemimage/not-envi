import { describe, expect, test } from "vitest";
import { nextRegionIndex, regionIndices, regionSourceLabel } from "../../src/app/region-labels.js";

describe("region numbering within colors", () => {
  const red = { id: 7, tool: "rect", color: "#ff2d2d", regionIndex: 1 };
  const red2 = { id: 11, tool: "shape", color: "#FF2D2D", regionIndex: 2 };
  const yellow = { id: 13, tool: "rect", color: "#ffff00", regionIndex: 1 };

  test("colors count independently and deletion does not renumber stored indices", () => {
    expect([...regionIndices([red, yellow, red2]).values()]).toEqual([1, 1, 2]);
    expect(nextRegionIndex([red, yellow, red2], red.color)).toBe(3);
    expect(nextRegionIndex([yellow, red2], red.color)).toBe(3);
    expect(regionIndices([yellow, red2]).get(red2.id)).toBe(2);
    expect(nextRegionIndex([red, yellow, red2], yellow.color)).toBe(2);
    expect(nextRegionIndex([red, yellow, red2], "blue")).toBe(1);
  });

  test("unnumbered regions get per-color fallbacks without counting lines and points", () => {
    const items = [{ id: 2, tool: "point", color: red.color }, { ...red, regionIndex: undefined },
      { id: 8, tool: "ruler", color: red.color }, { ...red2, regionIndex: undefined }, yellow];
    expect([...regionIndices(items)]).toEqual([[yellow.id, 1], [red.id, 1], [red2.id, 2]]);
    expect(items[1].regionIndex).toBeUndefined();
    expect(items.map(item => item.id)).toEqual([2, 7, 8, 11, 13]);
  });

  test("plot labels use the displayed indices while source IDs remain distinct", () => {
    expect(regionSourceLabel([red, red2])).toBe("Region 1 + 2");
    expect(regionSourceLabel([yellow])).toBe("Region 1");
    expect(regionSourceLabel([])).toBe("Whole image");
    expect(regionSourceLabel([{ ...red2, regionIndex: undefined }], [red, red2, yellow])).toBe("Region 2");
    expect(red.id).not.toBe(red.regionIndex);
  });
});
