import { describe, expect, test } from "vitest";
import { layoutExportBars } from "../../src/export/export-bar-layout.js";

const metrics = { pad: 10, boxW: 110, fontPx: 12, colorBarH: 10, colorGap: 6, tick: 6 };
const corners = ["top-left", "top-right", "bottom-left", "bottom-right"];

describe("export bar placement", () => {
  test.each(corners)("stacks color above scale at %s inside and outside", (corner) => {
    for (const inside of [true, false]) {
      const layout = layoutExportBars(400, 300, metrics, {
        includeColorBar: true, includeScaleBar: true,
        colorBarCorner: corner, scaleBarCorner: corner,
        colorBarInside: inside, scaleBarInside: inside
      });
      expect(layout.groups).toHaveLength(1);
      const group = layout.groups[0];
      expect(group.bars).toEqual(["color", "scale"]);
      expect(group.x).toBe(corner.endsWith("left") ? 10 : 280);
      if (inside) {
        expect(layout.height).toBe(300);
        expect(group.y).toBe(corner.startsWith("top") ? 10 : 212);
      } else {
        expect(layout.height).toBe(398);
        if (corner.startsWith("top")) expect(group.y + group.height).toBeLessThan(layout.imageY);
        else expect(group.y).toBeGreaterThan(layout.imageY + 300);
      }
    }
  });

  test("independent placement preserves image size and keeps outside rows apart", () => {
    const layout = layoutExportBars(100, 80, metrics, {
      includeColorBar: true, includeScaleBar: true,
      colorBarCorner: "top-left", scaleBarCorner: "top-right",
      colorBarInside: false, scaleBarInside: false
    });
    const [color, scale] = layout.groups;
    expect(color.x + color.width).toBeLessThan(scale.x);
    expect(color.y + color.height).toBeLessThan(layout.imageY);
    expect(scale.y + scale.height).toBeLessThan(layout.imageY);
    expect(layout.width).toBe(250);
    expect(layout.height - layout.imageY).toBe(80);
  });

  test("same corner with different inside choices creates separate groups", () => {
    const layout = layoutExportBars(400, 300, metrics, {
      includeColorBar: true, includeScaleBar: true, colorBarInside: false
    });
    expect(layout.groups).toHaveLength(2);
    expect(layout.groups[0].y).toBeGreaterThan(layout.imageY + 300);
    expect(layout.groups[1].y + layout.groups[1].height).toBeLessThan(layout.imageY + 300);
  });
});
