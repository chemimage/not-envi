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

  test("onThumbClick delegates to linked recenter helper when provided", () => {
    const render = vi.fn();
    const recenterViewAtFraction = vi.fn(() => true);
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
      getDevicePixelRatio: () => 1,
      recenterViewAtFraction
    });

    ctrl.onThumbClick({ clientX: 150, clientY: 25 });
    expect(recenterViewAtFraction).toHaveBeenCalledWith(0.75, 0.25);
    expect(render).toHaveBeenCalledTimes(1);
  });

  test("renderWindowToImageData reuses a caller-owned Float32Array scratch buffer", async () => {
    let capturedOut = null;
    const ds = {
      id: "ds1",
      activeBand: 0,
      meta: { samples: 2, lines: 2, interleave: "bsq" },
      ds: {}
    };
    const ctrl = createThumbnailController({
      els: {
        thumbWrap: { style: { display: "none" } },
        main: { getBoundingClientRect: () => ({ width: 800, height: 400 }) },
        thumb: { width: 200, height: 100, getBoundingClientRect: () => ({ left: 0, top: 0 }) },
        cpuCanvas: { width: 100, height: 50 }
      },
      thumbCtx: makeThumbCtx(),
      toFloat32: (arr, out = null) => out || arr,
      tone01: (v) => v / 4,
      resolveDisplayRange: () => ({ minVal: 0, maxVal: 4 }),
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      readBandWindow: async (...args) => {
        capturedOut = args[8];
        capturedOut.set([0, 1, 2, 3], 0);
        return capturedOut;
      },
      readBandWindowBIP: async () => new Float32Array(0),
      getActive: () => ds,
      render: vi.fn(),
      getDevicePixelRatio: () => 1
    });

    const img = await ctrl.renderWindowToImageData(ds, 0, 0, 0, 2, 2, 1);

    expect(capturedOut).toBeInstanceOf(Float32Array);
    expect(img.width).toBe(2);
    expect(img.height).toBe(2);
    expect(Array.from(img.data.slice(0, 8))).toEqual([0, 0, 0, 255, 64, 64, 64, 255]);
  });
});
