import { describe, expect, test, vi } from "vitest";
import { createInteractionController } from "../../src/ui/events.js";

describe("interaction controller", () => {
  test("window dragging does not update image hover or pan state", () => {
    const updateHud = vi.fn();
    const controller = createInteractionController({
      isUiInteractionActive: () => true,
      updateHud,
      getActive: vi.fn(() => { throw new Error("Image interactions must stay idle"); })
    });
    controller.onPointerMove({ clientX: 200, clientY: 100 });
    expect(updateHud).not.toHaveBeenCalled();
  });

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

  test("zoomAt prefers scheduled renders when available", () => {
    const render = vi.fn();
    const scheduleRender = vi.fn();
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
      clampView: () => {},
      scheduleRender,
      render,
      minScaleFor: () => 1,
      scaleToSlider: (s) => s,
      updateZoomLabel: () => {}
    });

    controller.zoomAt(1.25, 100, 100);
    expect(scheduleRender).toHaveBeenCalledTimes(1);
    expect(render).not.toHaveBeenCalled();
  });

  test("touch pinch uses preview during motion and schedules full render on release", () => {
    vi.useFakeTimers();
    const render = vi.fn();
    const scheduleRender = vi.fn();
    const schedulePreviewRender = vi.fn();
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
      screenToImage: (sx, sy) => ({ x: ds.view.x + sx / ds.view.scale, y: ds.view.y + sy / ds.view.scale }),
      clampView: () => {},
      schedulePreviewRender,
      scheduleRender,
      render,
      minScaleFor: () => 1,
      scaleToSlider: (s) => s,
      updateZoomLabel: () => {}
    });

    controller.onPointerDown({ pointerType: "touch", pointerId: 1, clientX: 20, clientY: 20, preventDefault: vi.fn() });
    controller.onPointerDown({ pointerType: "touch", pointerId: 2, clientX: 80, clientY: 20, preventDefault: vi.fn() });
    controller.onPointerMove({ pointerType: "touch", pointerId: 2, clientX: 100, clientY: 20, preventDefault: vi.fn() });

    expect(schedulePreviewRender).toHaveBeenCalledTimes(1);
    expect(scheduleRender).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();

    controller.onPointerUp({ pointerType: "touch", pointerId: 1, preventDefault: vi.fn() });
    expect(scheduleRender).not.toHaveBeenCalled();

    controller.onPointerUp({ pointerType: "touch", pointerId: 2, preventDefault: vi.fn() });
    expect(scheduleRender).toHaveBeenCalledTimes(1);

    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  test("touch pinch does not trigger settled full renders while the gesture is still active", () => {
    vi.useFakeTimers();
    const render = vi.fn();
    const scheduleRender = vi.fn();
    const schedulePreviewRender = vi.fn();
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
      screenToImage: (sx, sy) => ({ x: ds.view.x + sx / ds.view.scale, y: ds.view.y + sy / ds.view.scale }),
      clampView: () => {},
      schedulePreviewRender,
      scheduleRender,
      render,
      minScaleFor: () => 0.25,
      scaleToSlider: (s) => s,
      updateZoomLabel: () => {}
    });

    controller.onPointerDown({ pointerType: "touch", pointerId: 1, clientX: 20, clientY: 20, preventDefault: vi.fn() });
    controller.onPointerDown({ pointerType: "touch", pointerId: 2, clientX: 100, clientY: 20, preventDefault: vi.fn() });
    controller.onPointerMove({ pointerType: "touch", pointerId: 2, clientX: 60, clientY: 20, preventDefault: vi.fn() });

    vi.advanceTimersByTime(120);
    expect(schedulePreviewRender).toHaveBeenCalledTimes(1);
    expect(scheduleRender).not.toHaveBeenCalled();

    controller.onPointerUp({ pointerType: "touch", pointerId: 1, preventDefault: vi.fn() });
    vi.advanceTimersByTime(95);
    expect(scheduleRender).toHaveBeenCalledTimes(1);

    controller.onPointerUp({ pointerType: "touch", pointerId: 2, preventDefault: vi.fn() });
    expect(scheduleRender).toHaveBeenCalledTimes(2);

    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  test("mouse wheel uses preview first and schedules a settled render", () => {
    vi.useFakeTimers();
    const render = vi.fn();
    const scheduleRender = vi.fn();
    const schedulePreviewRender = vi.fn();
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
      screenToImage: (sx, sy) => ({ x: ds.view.x + sx / ds.view.scale, y: ds.view.y + sy / ds.view.scale }),
      clampView: () => {},
      schedulePreviewRender,
      scheduleRender,
      render,
      minScaleFor: () => 1,
      scaleToSlider: (s) => s,
      updateZoomLabel: () => {}
    });

    controller.onWheel({
      clientX: 100,
      clientY: 120,
      deltaY: -1,
      preventDefault: vi.fn(),
      target: { closest: () => null }
    });

    expect(ds.view.scale).toBe(1.25);
    expect(schedulePreviewRender).toHaveBeenCalledTimes(1);
    expect(scheduleRender).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();

    vi.advanceTimersByTime(95);
    expect(scheduleRender).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  test("touch handlers prevent browser defaults and clear touch pointers on up", () => {
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
    expect(down2.preventDefault).toHaveBeenCalledTimes(1);
  });

  test("pointerdown on a UI target does not start canvas dragging", () => {
    const render = vi.fn();
    const ds = { view: { scale: 1, x: 0, y: 0 }, meta: { samples: 1000, lines: 1000 } };
    const state = {
      selection: { enabled: false, drawing: false, imgRect: null },
      mouse: { dragging: false }
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
      render,
      minScaleFor: () => 1,
      scaleToSlider: (s) => s,
      updateZoomLabel: () => {}
    });

    controller.onPointerDown({
      pointerType: "mouse",
      clientX: 10,
      clientY: 20,
      target: { closest: () => ({ id: "displayDock" }) }
    });
    controller.onPointerMove({
      pointerType: "mouse",
      clientX: 40,
      clientY: 60,
      target: { closest: () => ({ id: "displayDock" }) }
    });

    expect(state.mouse.dragging).toBe(false);
    expect(render).not.toHaveBeenCalled();
  });

  test("dragging the wavenumber dock does not pan the canvas", () => {
    const render = vi.fn();
    const panByPixels = vi.fn();
    const ds = { view: { scale: 1, x: 0, y: 0 }, meta: { samples: 1000, lines: 1000 } };
    const state = {
      selection: { enabled: false, drawing: false, imgRect: null },
      mouse: { dragging: false }
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
      render,
      minScaleFor: () => 1,
      scaleToSlider: (s) => s,
      updateZoomLabel: () => {},
      panByPixels
    });
    const target = {
      closest: (selector) => selector === "[data-ui-surface]" ? { id: "bandDock" } : null
    };

    controller.onPointerDown({ pointerType: "mouse", clientX: 10, clientY: 20, target });
    controller.onPointerMove({ pointerType: "mouse", clientX: 80, clientY: 20, target });

    expect(state.mouse.dragging).toBe(false);
    expect(panByPixels).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  test("zoomAt delegates linked scaling when a scale helper is provided", () => {
    const render = vi.fn();
    const clampView = vi.fn();
    const screenToImage = vi.fn(() => ({ x: 0, y: 0 }));
    const setScaleAt = vi.fn(() => 3);
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
      screenToImage,
      clampView,
      render,
      minScaleFor: () => 1,
      scaleToSlider: (s) => s,
      updateZoomLabel: () => {},
      setScaleAt
    });

    controller.zoomAt(1.25, 100, 100);
    expect(setScaleAt).toHaveBeenCalledWith(2.5, 100, 100);
    expect(screenToImage).not.toHaveBeenCalled();
    expect(clampView).not.toHaveBeenCalled();
    expect(els.zoom.value).toBe("3");
    expect(render).toHaveBeenCalledTimes(1);
  });

  test("pointer drag delegates linked panning when a pan helper is provided", () => {
    const render = vi.fn();
    const clampView = vi.fn();
    const panByPixels = vi.fn(() => true);
    const ds = { view: { scale: 2, x: 10, y: 20 }, meta: { samples: 1000, lines: 1000 } };
    const state = {
      selection: { enabled: false, drawing: false, imgRect: null },
      mouse: { dragging: true, lastX: 10, lastY: 20 }
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
      clampView,
      render,
      minScaleFor: () => 1,
      scaleToSlider: (s) => s,
      updateZoomLabel: () => {},
      panByPixels
    });

    controller.onPointerMove({ pointerType: "mouse", clientX: 40, clientY: 65 });
    expect(panByPixels).toHaveBeenCalledWith(30, 45);
    expect(clampView).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledTimes(1);
  });
});
