import { afterEach, describe, expect, test, vi } from "vitest";
import {
  FLOATING_LAYOUT_STORAGE_KEY,
  clampFloatingGeometry,
  createAnchoredFloatingPositioner,
  createFloatingWindowManager
} from "../../src/app/floating-windows.js";

afterEach(() => vi.restoreAllMocks());

describe("floating windows", () => {
  test("dragging batches transforms without rereading bounds or resizing the panel", () => {
    const frames = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const container = document.createElement("div");
    Object.defineProperties(container, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
    const bounds = vi.fn(() => ({ left: 0, top: 0, width: 800, height: 600 }));
    container.getBoundingClientRect = bounds;
    const element = document.createElement("section");
    element.getBoundingClientRect = () => ({ left: 10, top: 20, width: 300, height: 200 });
    let drag;
    const onInteractionEnd = vi.fn();
    const manager = createFloatingWindowManager({ container, storage: null, onInteractionEnd,
      interactFactory: () => ({ draggable: (config) => { drag = config; }, unset: vi.fn() }) });
    manager.register({ id: "spectrum", element, resizable: false });
    drag.listeners.start();
    const initialReads = bounds.mock.calls.length;
    for (let i = 0; i < 60; i++) drag.listeners.move({ dx: 1, dy: 0.5 });
    expect(manager.isInteracting()).toBe(true);
    expect(bounds).toHaveBeenCalledTimes(initialReads);
    expect(frames).toHaveLength(1);
    expect(element.style.left).toBe("10px");
    expect(element.style.top).toBe("20px");
    expect(element.style.width).toBe("300px");
    frames[0]();
    expect(element.style.transform).toBe("translate3d(60px, 30px, 0)");
    drag.listeners.end();
    expect(manager.isInteracting()).toBe(false);
    expect(element.style.transform).toBe("");
    expect(element.style.left).toBe("70px");
    expect(element.style.top).toBe("50px");
    expect(onInteractionEnd).toHaveBeenCalledOnce();
    manager.destroy();
  });

  test("clamps geometry and size inside the container", () => {
    expect(clampFloatingGeometry(
      { x: -20, y: 900, width: 900, height: 50 },
      { width: 800, height: 600 },
      { margin: 8, minWidth: 220, minHeight: 120 }
    )).toEqual({ x: 8, y: 472, width: 784, height: 120 });
  });

  test("persists user geometry and restores it", () => {
    const values = new Map();
    const storage = {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key)
    };
    const container = document.createElement("div");
    Object.defineProperties(container, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 }
    });
    container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
    const dragConfigs = [];
    const interactFactory = () => ({
      draggable: (config) => dragConfigs.push(config),
      resizable: vi.fn(),
      unset: vi.fn()
    });
    const element = document.createElement("section");
    element.getBoundingClientRect = () => ({ left: 10, top: 20, width: 300, height: 200 });
    const manager = createFloatingWindowManager({ container, storage, interactFactory });
    manager.register({ id: "spectrum", element, resizable: false });

    dragConfigs[0].listeners.start();
    dragConfigs[0].listeners.move({ dx: 40, dy: 50 });
    dragConfigs[0].listeners.end();
    const saved = JSON.parse(values.get(FLOATING_LAYOUT_STORAGE_KEY));
    expect(saved.windows.spectrum).toEqual({ x: 50, y: 70, width: 300, height: 200 });
    manager.destroy();

    const restored = document.createElement("section");
    restored.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200 });
    const nextManager = createFloatingWindowManager({ container, storage, interactFactory });
    nextManager.register({ id: "spectrum", element: restored, resizable: false });
    expect(restored.style.left).toBe("50px");
    expect(restored.style.top).toBe("70px");
    expect(restored.dataset.floatingUserPlaced).toBe("true");
    nextManager.destroy();
  });

  test("positions anchored surfaces and cleans up auto updates", async () => {
    const cleanup = vi.fn();
    const computePositionFn = vi.fn(async () => ({ x: 123.4, y: 56.7 }));
    const autoUpdateFn = vi.fn((_reference, _floating, update) => {
      update();
      return cleanup;
    });
    const positioner = createAnchoredFloatingPositioner({ computePositionFn, autoUpdateFn });
    const reference = document.createElement("button");
    const floating = document.createElement("div");

    positioner.start(reference, floating);
    await Promise.resolve();
    await Promise.resolve();
    expect(floating.style.left).toBe("123px");
    expect(floating.style.top).toBe("57px");
    positioner.stop();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
