import { describe, expect, test } from "vitest";
import { computeDisplayPanelLayout } from "../../src/app/display-panels.js";

function makePanels(count) {
  return Array.from({ length: count }, (_unused, index) => ({
    slot: index + 1,
    datasetId: `ds${index + 1}`
  }));
}

describe("display panel layout", () => {
  test("uses 1x2 for two panels in a wide window", () => {
    const layout = computeDisplayPanelLayout(makePanels(2), 1200, 600);
    expect(layout).toHaveLength(2);
    expect(layout[0]).toMatchObject({ slot: 1, x: 0, y: 0, w: 600, h: 600 });
    expect(layout[1]).toMatchObject({ slot: 2, x: 600, y: 0, w: 600, h: 600 });
  });

  test("uses 2x1 for two panels in a tall window", () => {
    const layout = computeDisplayPanelLayout(makePanels(2), 600, 1200);
    expect(layout).toHaveLength(2);
    expect(layout[0]).toMatchObject({ slot: 1, x: 0, y: 0, w: 600, h: 600 });
    expect(layout[1]).toMatchObject({ slot: 2, x: 0, y: 600, w: 600, h: 600 });
  });

  test("uses 1x3 for three panels in a wide window", () => {
    const layout = computeDisplayPanelLayout(makePanels(3), 1500, 600);
    expect(layout).toHaveLength(3);
    expect(layout[0]).toMatchObject({ slot: 1, x: 0, y: 0, w: 500, h: 600 });
    expect(layout[1]).toMatchObject({ slot: 2, x: 500, y: 0, w: 500, h: 600 });
    expect(layout[2]).toMatchObject({ slot: 3, x: 1000, y: 0, w: 500, h: 600 });
  });

  test("uses 3x1 for three panels in a tall window", () => {
    const layout = computeDisplayPanelLayout(makePanels(3), 600, 1500);
    expect(layout).toHaveLength(3);
    expect(layout[0]).toMatchObject({ slot: 1, x: 0, y: 0, w: 600, h: 500 });
    expect(layout[1]).toMatchObject({ slot: 2, x: 0, y: 500, w: 600, h: 500 });
    expect(layout[2]).toMatchObject({ slot: 3, x: 0, y: 1000, w: 600, h: 500 });
  });

  test("uses a 2x2 layout for three panels in a near-square window", () => {
    const layout = computeDisplayPanelLayout(makePanels(3), 1200, 1000);
    expect(layout).toHaveLength(3);
    expect(layout[0]).toMatchObject({ slot: 1, x: 0, y: 0, w: 600, h: 500 });
    expect(layout[1]).toMatchObject({ slot: 2, x: 600, y: 0, w: 600, h: 500 });
    expect(layout[2]).toMatchObject({ slot: 3, x: 0, y: 500, w: 600, h: 500 });
  });

  test("keeps four panels in a 2x2 grid", () => {
    const layout = computeDisplayPanelLayout(makePanels(4), 1200, 800);
    expect(layout).toHaveLength(4);
    expect(layout[0]).toMatchObject({ slot: 1, x: 0, y: 0, w: 600, h: 400 });
    expect(layout[1]).toMatchObject({ slot: 2, x: 600, y: 0, w: 600, h: 400 });
    expect(layout[2]).toMatchObject({ slot: 3, x: 0, y: 400, w: 600, h: 400 });
    expect(layout[3]).toMatchObject({ slot: 4, x: 600, y: 400, w: 600, h: 400 });
  });
});
