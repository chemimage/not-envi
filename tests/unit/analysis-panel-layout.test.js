import { describe, test, expect } from "vitest";
import { chooseAnalysisPanelLayout } from "../../src/app/analysis-panel-layout.js";

const panels = [
  { id: "spectrum", width: 380, height: 330 },
  { id: "histogram", width: 380, height: 340 }
];
function verify(layout, bounds) {
  const [a, b] = layout;
  expect(a.x + a.width <= b.x || b.x + b.width <= a.x
    || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
  for (const panel of layout) {
    expect(panel.x).toBeGreaterThanOrEqual(8);
    expect(panel.y).toBeGreaterThanOrEqual(8);
    expect(panel.x + panel.width).toBeLessThanOrEqual(bounds.width - 8);
    expect(panel.y + panel.height).toBeLessThanOrEqual(bounds.height - 8);
  }
}
describe("analysis panel layout", () => {
  test.each([{ width: 1200, height: 800 }, { width: 900, height: 600 }])("packs panels inside %j without overlap", (bounds) => {
    const layout = chooseAnalysisPanelLayout({ bounds, panels,
      anchor: { x: 624, y: 290, width: 36, height: 76 } });
    verify(layout, bounds);
  });
  test("places an automatic panel beside a manually positioned panel", () => {
    const bounds = { width: 1200, height: 800 };
    const fixed = { ...panels[0], x: 400, y: 300, fixed: true };
    const layout = chooseAnalysisPanelLayout({ bounds, panels: [fixed, panels[1]] });
    expect(layout.find((panel) => panel.id === fixed.id)).toEqual(fixed);
    verify(layout, bounds);
  });
});
