import { describe, expect, test, vi } from "vitest";
import { createInteractionController } from "../../src/ui/events.js";

describe("interaction controller", () => {
  test("clearSelection resets selection and hides rectangle", () => {
    const state = {
      selection: { drawing: true, imgRect: { x0: 1, y0: 1, x1: 2, y1: 2 } },
      mouse: {}
    };
    const els = {
      selRect: { style: { display: "block" } },
      main: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
      zoom: { value: "1" }
    };
    const controller = createInteractionController({
      els,
      state,
      getActive: () => null,
      clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
      setStatus: () => {},
      updateHud: () => {},
      screenToImage: () => ({ x: 0, y: 0 }),
      clampView: () => {},
      render: () => {},
      minScaleFor: () => 1,
      scaleToSlider: () => 1,
      updateZoomLabel: () => {}
    });

    controller.clearSelection();
    expect(state.selection.drawing).toBe(false);
    expect(state.selection.imgRect).toBeNull();
    expect(els.selRect.style.display).toBe("none");
  });

  test("zoomAt updates scale and re-renders", () => {
    const render = vi.fn();
    const clampView = vi.fn();
    const updateZoomLabel = vi.fn();
    const ds = { view: { scale: 2, x: 10, y: 20 }, meta: { samples: 1000, lines: 1000 } };
    const els = {
      selRect: { style: {} },
      main: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
      zoom: { value: "0" }
    };
    const state = { selection: { drawing: false, imgRect: null }, mouse: {} };

    const controller = createInteractionController({
      els,
      state,
      getActive: () => ds,
      clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
      setStatus: () => {},
      updateHud: () => {},
      screenToImage: (sx, sy) => ({ x: ds.view.x + sx / ds.view.scale, y: ds.view.y + sy / ds.view.scale }),
      clampView,
      render,
      minScaleFor: () => 1,
      scaleToSlider: (s) => s,
      updateZoomLabel
    });

    controller.zoomAt(1.25, 100, 100);
    expect(ds.view.scale).toBe(2.5);
    expect(clampView).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(1);
    expect(updateZoomLabel).toHaveBeenCalledTimes(1);
  });

  test("touch handlers prevent browser defaults and clear touch pointers on up", () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout").mockImplementation(() => 1);
    const ds = { view: { scale: 1, x: 0, y: 0 }, meta: { samples: 1000, lines: 1000 } };
    const state = {
      selection: { enabled: false, drawing: false, imgRect: null },
      mouse: {}
    };
    const els = {
      selRect: { style: { display: "none" } },
      main: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
      zoom: { value: "0" }
    };

    const controller = createInteractionController({
      els,
      state,
      getActive: () => ds,
      clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
      setStatus: () => {},
      updateHud: () => {},
      screenToImage: (sx, sy) => ({ x: sx, y: sy }),
      clampView: () => {},
      render: () => {},
      minScaleFor: () => 1,
      scaleToSlider: (s) => s,
      updateZoomLabel: () => {}
    });

    const down1 = { pointerType: "touch", pointerId: 1, clientX: 10, clientY: 10, preventDefault: vi.fn() };
    controller.onPointerDown(down1);
    expect(down1.preventDefault).toHaveBeenCalledTimes(1);

    const move1 = { pointerType: "touch", pointerId: 1, clientX: 11, clientY: 12, preventDefault: vi.fn() };
    controller.onPointerMove(move1);
    expect(move1.preventDefault).toHaveBeenCalledTimes(1);

    const up1 = { pointerType: "touch", pointerId: 1, preventDefault: vi.fn() };
    controller.onPointerUp(up1);
    expect(up1.preventDefault).toHaveBeenCalledTimes(1);

    const down2 = { pointerType: "touch", pointerId: 2, clientX: 20, clientY: 20, preventDefault: vi.fn() };
    controller.onPointerDown(down2);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);

    setTimeoutSpy.mockRestore();
  });
});
