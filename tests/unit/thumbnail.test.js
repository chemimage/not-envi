import { describe, expect, test, vi } from "vitest";
import { createThumbnailController } from "../../src/render/thumbnail.js";

function makeThumbCtx() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    strokeRect: vi.fn(),
    imageSmoothingEnabled: false
  };
}

describe("thumbnail controller", () => {
  test("renderThumbnail keeps panel visible", () => {
    const render = vi.fn();
    const ds = {
      id: "ds1",
      activeBand: 0,
      meta: { samples: 100, lines: 50, interleave: "bsq" },
      ds: {},
      view: { x: 0, y: 0, scale: 1 },
      thumb: { ready: false }
    };
    const els = {
      thumbWrap: { style: { display: "block" } },
      main: { getBoundingClientRect: () => ({ width: 800, height: 400 }) },
      thumb: { width: 200, height: 120, getBoundingClientRect: () => ({ left: 0, top: 0 }) },
      cpuCanvas: { width: 800, height: 600 }
    };
    const ctrl = createThumbnailController({
      els,
      thumbCtx: makeThumbCtx(),
      toFloat32: (x) => x,
      tone01: () => 0,
      resolveDisplayRange: () => ({ minVal: 0, maxVal: 1 }),
      getBandSettings: () => ({ gamma: 1, gain: 1, contrast: 1 }),
      readBandWindow: async () => new Float32Array(0),
      readBandWindowBIP: async () => new Float32Array(0),
      getActive: () => ds,
      render,
      getDevicePixelRatio: () => 1
    });

    ctrl.renderThumbnail();
    expect(els.thumbWrap.style.display).toBe("block");
    expect(render).not.toHaveBeenCalled();
  });

  test("onThumbClick recenters view and triggers render", () => {
    const render = vi.fn();
    const ds = {
      meta: { samples: 1000, lines: 500 },
      view: { x: 0, y: 0, scale: 1 },
      thumb: { ready: true, x0: 0, y0: 0, w: 200, h: 100 }
    };
    const els = {
      thumbWrap: { style: { display: "none" } },
      main: { getBoundingClientRect: () => ({ width: 800, height: 400 }) },
      thumb: { width: 200, height: 100, getBoundingClientRect: () => ({ left: 0, top: 0 }) },
      cpuCanvas: { width: 100, height: 50 }
    };
    const ctrl = createThumbnailController({
      els,
      thumbCtx: makeThumbCtx(),
      toFloat32: (x) => x,
      tone01: () => 0,
      resolveDisplayRange: () => ({ minVal: 0, maxVal: 1 }),
      getBandSettings: () => ({ gamma: 1, gain: 1, contrast: 1 }),
      readBandWindow: async () => new Float32Array(0),
      readBandWindowBIP: async () => new Float32Array(0),
      getActive: () => ds,
      render,
      getDevicePixelRatio: () => 1
    });

    ctrl.onThumbClick({ clientX: 100, clientY: 50 });
    expect(ds.view.x).toBeGreaterThan(0);
    expect(ds.view.y).toBeGreaterThan(0);
    expect(render).toHaveBeenCalledTimes(1);
  });
});
