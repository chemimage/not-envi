import { afterEach, describe, expect, test, vi } from "vitest";
import { APP_CONFIG } from "../../src/app/config.js";
import { createThumbnailController } from "../../src/render/thumbnail.js";

const originalUserAgent = navigator.userAgent;

afterEach(() => {
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: originalUserAgent
  });
});

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

  test("renderThumbnail defers TIFF thumbnail builds until a stable raster exists", async () => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
    });

    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, "createElement").mockImplementation((tagName) => {
      if (String(tagName).toLowerCase() === "canvas") {
        return {
          width: 0,
          height: 0,
          getContext: () => ({
            putImageData: vi.fn()
          })
        };
      }
      return originalCreateElement(tagName);
    });

    try {
      const readBandWindow = vi.fn(async () => new Float32Array([0, 0, 0, 0]));
      const ds = {
        id: "ds-tiff",
        activeBand: 0,
        meta: { samples: 100, lines: 50, interleave: "bsq", sourceFormat: "tiff" },
        ds: {},
        view: { x: 0, y: 0, scale: 1 },
        thumb: { ready: false }
      };
      const els = {
        thumbWrap: { style: { display: "block", width: "", height: "" } },
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
        readBandWindow,
        readBandWindowBIP: async () => new Float32Array(0),
        getActive: () => ds,
        render: vi.fn(),
        getDevicePixelRatio: () => 1
      });

      ctrl.renderThumbnail();
      await Promise.resolve();

      expect(readBandWindow).not.toHaveBeenCalled();
      expect(ds.thumb.buildPendingKey).toBeUndefined();
    } finally {
      createElementSpy.mockRestore();
    }
  });

  test("ensureDatasetPreviewOverview builds smaller native TIFF overviews first, then larger deferred ones", async () => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
    });

    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, "createElement").mockImplementation((tagName) => {
      if (String(tagName).toLowerCase() === "canvas") {
        return {
          width: 0,
          height: 0,
          getContext: () => ({
            putImageData: vi.fn()
          })
        };
      }
      return originalCreateElement(tagName);
    });

    try {
      const compositeWindow = vi.fn(async (_meta, _x0, _y0, outW, outH) => ({
        bands: [0, 1, 2].map((band) => new Float32Array(outW * outH).fill(band + 1))
      }));
      const render = vi.fn();
      const ds = {
        id: "ds-vis",
        activeBand: 0,
        displayMode: "rgb",
        meta: { samples: 4096, lines: 2048, interleave: "bip", sourceFormat: "tiff" },
        ds: {
          supportsCompositeWindow: () => true,
          hasNativeOverviews: () => true,
          readCompositeWindow: compositeWindow
        },
        view: { x: 0, y: 0, scale: 1 },
        thumb: { ready: false }
      };
      const ctrl = createThumbnailController({
        els: {
          thumbWrap: { style: { display: "block", width: "", height: "" } },
          main: { getBoundingClientRect: () => ({ width: 800, height: 400 }) },
          thumb: { width: 200, height: 120, getBoundingClientRect: () => ({ left: 0, top: 0 }) },
          cpuCanvas: { width: 800, height: 600 }
        },
        thumbCtx: makeThumbCtx(),
        toFloat32: (x) => x,
        tone01: () => 0.5,
        resolveDisplayRange: () => ({ minVal: 0, maxVal: 2 }),
        getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
        readBandWindow: async () => new Float32Array(0),
        readBandWindowBIP: async () => new Float32Array(0),
        getActive: () => ds,
        render,
        getDevicePixelRatio: () => 1,
        isThreeBandColorMode: () => true
      });

      ctrl.ensureDatasetPreviewOverview(ds);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(compositeWindow).toHaveBeenCalledTimes(1);
      const initialOutW = compositeWindow.mock.calls[0][3];
      expect(initialOutW).toBeLessThan(APP_CONFIG.previewOverview.standardDeferredLongEdge);
      expect(ds.previewOverview?.ready).toBe(true);

      ds.lastCompositeRaster = { mode: "rgb" };
      ctrl.ensureDatasetPreviewOverview(ds);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(compositeWindow).toHaveBeenCalledTimes(2);
      expect(compositeWindow.mock.calls[1][3]).toBeGreaterThan(initialOutW);
    } finally {
      createElementSpy.mockRestore();
    }
  });

  test("ensureDatasetPreviewOverview defers raw TIFF preview overview until a stable raster exists", async () => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
    });

    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, "createElement").mockImplementation((tagName) => {
      if (String(tagName).toLowerCase() === "canvas") {
        return {
          width: 0,
          height: 0,
          getContext: () => ({
            putImageData: vi.fn()
          })
        };
      }
      return originalCreateElement(tagName);
    });

    try {
      const compositeWindow = vi.fn(async (_meta, _x0, _y0, outW, outH) => ({
        bands: [0, 1, 2].map((band) => new Float32Array(outW * outH).fill(band + 1))
      }));
      const ds = {
        id: "ds-he",
        activeBand: 0,
        displayMode: "rgb",
        meta: { samples: 4096, lines: 2048, interleave: "bip", sourceFormat: "tiff" },
        ds: {
          supportsCompositeWindow: () => true,
          hasNativeOverviews: () => false,
          readCompositeWindow: compositeWindow
        },
        view: { x: 0, y: 0, scale: 1 },
        thumb: { ready: false }
      };
      const ctrl = createThumbnailController({
        els: {
          thumbWrap: { style: { display: "block", width: "", height: "" } },
          main: { getBoundingClientRect: () => ({ width: 800, height: 400 }) },
          thumb: { width: 200, height: 120, getBoundingClientRect: () => ({ left: 0, top: 0 }) },
          cpuCanvas: { width: 800, height: 600 }
        },
        thumbCtx: makeThumbCtx(),
        toFloat32: (x) => x,
        tone01: () => 0.5,
        resolveDisplayRange: () => ({ minVal: 0, maxVal: 2 }),
        getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
        readBandWindow: async () => new Float32Array(0),
        readBandWindowBIP: async () => new Float32Array(0),
        getActive: () => ds,
        render: vi.fn(),
        getDevicePixelRatio: () => 1,
        isThreeBandColorMode: () => true
      });

      ctrl.ensureDatasetPreviewOverview(ds);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(compositeWindow).not.toHaveBeenCalled();
      expect(ds.previewOverview?.ready).not.toBe(true);

      ds.lastCompositeRaster = { mode: "rgb" };
      ctrl.ensureDatasetPreviewOverview(ds);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(compositeWindow).toHaveBeenCalledTimes(1);
      expect(compositeWindow.mock.calls[0][3]).toBeGreaterThan(APP_CONFIG.previewOverview.standardBootstrapLongEdge);
      expect(compositeWindow.mock.calls[0][3]).toBeLessThanOrEqual(APP_CONFIG.previewOverview.standardDeferredLongEdge);
      expect(ds.previewOverview?.ready).toBe(true);
    } finally {
      createElementSpy.mockRestore();
    }
  });

  test("ensureDatasetPreviewOverview defers ENVI preview overview until a stable raster exists", async () => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
    });

    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, "createElement").mockImplementation((tagName) => {
      if (String(tagName).toLowerCase() === "canvas") {
        return {
          width: 0,
          height: 0,
          getContext: () => ({
            putImageData: vi.fn()
          })
        };
      }
      return originalCreateElement(tagName);
    });

    try {
      const readBandWindow = vi.fn(async (_meta, _src, _band, _x0, _y0, outW, outH, _step, out) => {
        const target = out || new Float32Array(outW * outH);
        target.fill(1);
        return target;
      });
      const ds = {
        id: "ds-envi",
        activeBand: 0,
        meta: { samples: 4096, lines: 2048, interleave: "bsq", sourceFormat: "envi" },
        ds: {},
        view: { x: 0, y: 0, scale: 1 },
        thumb: { ready: false }
      };
      const ctrl = createThumbnailController({
        els: {
          thumbWrap: { style: { display: "block", width: "", height: "" } },
          main: { getBoundingClientRect: () => ({ width: 800, height: 400 }) },
          thumb: { width: 200, height: 120, getBoundingClientRect: () => ({ left: 0, top: 0 }) },
          cpuCanvas: { width: 800, height: 600 }
        },
        thumbCtx: makeThumbCtx(),
        toFloat32: (x) => x,
        tone01: () => 0.5,
        resolveDisplayRange: () => ({ minVal: 0, maxVal: 2 }),
        getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
        readBandWindow,
        readBandWindowBIP: async () => new Float32Array(0),
        getActive: () => ds,
        render: vi.fn(),
        getDevicePixelRatio: () => 1
      });

      ctrl.ensureDatasetPreviewOverview(ds);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(readBandWindow).not.toHaveBeenCalled();
      expect(ds.previewOverview?.ready).not.toBe(true);

      ds.lastRaster = { band: 0 };
      ctrl.ensureDatasetPreviewOverview(ds);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(readBandWindow).toHaveBeenCalledTimes(1);
      expect(readBandWindow.mock.calls[0][5]).toBeGreaterThan(APP_CONFIG.previewOverview.standardBootstrapLongEdge);
      expect(readBandWindow.mock.calls[0][5]).toBeLessThanOrEqual(APP_CONFIG.previewOverview.standardDeferredLongEdge);
      expect(ds.previewOverview?.ready).toBe(true);
    } finally {
      createElementSpy.mockRestore();
    }
  });

});
