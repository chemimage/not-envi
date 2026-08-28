import { describe, expect, test, vi } from "vitest";
import {
  FLOATING_LAYOUT_STORAGE_KEY,
  clampFloatingGeometry,
  createAnchoredFloatingPositioner,
  createFloatingWindowManager
} from "../../src/app/floating-windows.js";

describe("floating windows", () => {
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
