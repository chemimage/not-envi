import { describe, expect, test, vi } from "vitest";
import { createViewControls } from "../../src/app/view-controls.js";

describe("view controls", () => {
  test("slider and scale mapping are consistent", () => {
    const state = { zoomExpMin: -6, zoomExpMax: 4 };
    const ds = { meta: { samples: 1000, lines: 500 }, view: { x: 0, y: 0, scale: 1 } };
    const els = {
      main: { getBoundingClientRect: () => ({ width: 500, height: 250 }) },
      cpuCanvas: { width: 500, height: 250 },
      zoom: { value: "" },
      zoomLabel: { textContent: "" }
    };
    const vc = createViewControls({
      state,
      els,
      clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
      getActive: () => ds,
      onRender: () => {}
    });

    const s = vc.sliderToScale(50);
    const v = vc.scaleToSlider(s);
    expect(v).toBeGreaterThanOrEqual(49);
    expect(v).toBeLessThanOrEqual(51);
  });

  test("fitToScreen updates scale and zoom label", () => {
    const onRender = vi.fn();
    const state = { zoomExpMin: -6, zoomExpMax: 4 };
    const ds = { meta: { samples: 1000, lines: 500 }, view: { x: 10, y: 10, scale: 2 } };
    const els = {
      main: { getBoundingClientRect: () => ({ width: 500, height: 250 }) },
      cpuCanvas: { width: 500, height: 250 },
      zoom: { value: "" },
      zoomLabel: { textContent: "" }
    };
    const vc = createViewControls({
      state,
      els,
      clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
      getActive: () => ds,
      onRender
    });

    vc.fitToScreen();
    expect(ds.view.scale).toBeCloseTo(0.5);
    expect(ds.view.x).toBe(0);
    expect(ds.view.y).toBe(0);
    expect(els.zoomLabel.textContent).toContain("%");
    expect(onRender).toHaveBeenCalledTimes(1);
  });
});
