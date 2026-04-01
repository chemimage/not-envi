import { describe, expect, test } from "vitest";
import {
  computeDisplayPanelLayout,
  DISPLAY_COMPOSITION_OVERLAY
} from "../../src/app/display-panels.js";

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

  test("uses full-frame overlapping rects in overlay mode", () => {
    const layout = computeDisplayPanelLayout(makePanels(2), 1200, 800, {
      composition: DISPLAY_COMPOSITION_OVERLAY
    });
    expect(layout).toHaveLength(2);
    expect(layout[0]).toMatchObject({ slot: 1, x: 0, y: 0, w: 1200, h: 800 });
    expect(layout[1]).toMatchObject({ slot: 2, x: 0, y: 0, w: 1200, h: 800 });
  });
});
