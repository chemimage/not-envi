import { describe, expect, test, vi } from "vitest";
import { createRenderer } from "../../src/render/render-main.js";

function makeDeps(overrides = {}) {
  const cpuCtx = {
    setTransform: vi.fn(),
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    createImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) })),
    save: vi.fn(),
    restore: vi.fn(),
    drawImage: vi.fn(),
    imageSmoothingEnabled: false,
    fillStyle: ""
  };
  const overlayCtx = {
    setTransform: vi.fn(),
    clearRect: vi.fn()
  };
  const els = {
    main: { getBoundingClientRect: () => ({ width: 320, height: 180 }) },
    cpuCanvas: { width: 0, height: 0, style: {}, getContext: () => cpuCtx },
    overlayCanvas: { width: 0, height: 0, style: {}, getContext: () => overlayCtx },
    gpuCanvas: { style: {} },
    gpuBadge: { textContent: "" }
  };
  return {
    state: { _rafPending: false, renderSeq: 0, histMode: "whole", histViewDebounce: null },
    els,
    now: () => 0,
    setStatus: vi.fn(),
    getActive: () => null,
    getBandSettings: () => ({ gamma: 1, gain: 1, contrast: 1 }),
    resolveDisplayRange: () => ({ minVal: 0, maxVal: 1 }),
    initWebGPU: async () => false,
    gpuSupported: false,
    gpuRender: vi.fn(),
    cpuRenderGray: vi.fn(),
    cpuRenderColor: vi.fn(),
    tryRasterFromPyramid: async () => null,
    readBandWindow: async () => new Float32Array(0),
    readBandWindowBIP: async () => new Float32Array(0),
    toFloat32: (x) => x,
    clampView: vi.fn(),
    syncRangeInputsFromSettings: vi.fn(),
    drawOverlays: vi.fn(),
    updatePerf: vi.fn(),
    renderThumbnail: vi.fn(),
    updateHud: vi.fn(),
    ensureViewHistogram: vi.fn(),
    ...overrides
  };
}

describe("render-main", () => {
  test("render clears canvases when there is no active dataset", async () => {
    const deps = makeDeps();
    const renderer = createRenderer(deps);

    await renderer.render();

    const cpuCtx = deps.els.cpuCanvas.getContext();
    const overlayCtx = deps.els.overlayCanvas.getContext();
    expect(deps.els.cpuCanvas.width).toBeGreaterThan(0);
    expect(deps.els.overlayCanvas.height).toBeGreaterThan(0);
    expect(cpuCtx.fillRect).toHaveBeenCalledTimes(1);
    expect(overlayCtx.clearRect).toHaveBeenCalledTimes(1);
  });

  test("scheduleRender coalesces multiple calls into one frame", async () => {
    const deps = makeDeps();
    const renderer = createRenderer(deps);

    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      setTimeout(() => cb(0), 0);
      return 1;
    });

    renderer.scheduleRender();
    renderer.scheduleRender();
    renderer.scheduleRender();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const cpuCtx = deps.els.cpuCanvas.getContext();
    expect(raf).toHaveBeenCalledTimes(1);
    expect(cpuCtx.fillRect).toHaveBeenCalledTimes(1);
    raf.mockRestore();
  });

  test("schedulePreview coalesces preview draws into one frame", async () => {
    const ds = {
      id: "ds1",
      activeBand: 0,
      view: { x: 6, y: 4, scale: 1.25 },
      meta: { samples: 200, lines: 120, bands: 1, interleave: "bsq" },
      lastScreenFrame: {
        modeKey: "gray:0",
        eff: 1,
        viewX: 0,
        viewY: 0,
        canvas: { width: 320, height: 180 }
      }
    };
    const deps = makeDeps({
      getActive: () => ds
    });
    const renderer = createRenderer(deps);

    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      setTimeout(() => cb(0), 0);
      return 1;
    });

    renderer.schedulePreview();
    renderer.schedulePreview();
    renderer.schedulePreview();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const cpuCtx = deps.els.cpuCanvas.getContext();
    expect(raf).toHaveBeenCalledTimes(1);
    expect(cpuCtx.drawImage).toHaveBeenCalledTimes(1);
    expect(deps.drawOverlays).toHaveBeenCalledTimes(1);
    raf.mockRestore();
  });

  test("render keeps zoomed-out direct raster sizing consistent", async () => {
    const ds = {
      id: 1,
      activeBand: 0,
      view: { x: -150, y: -62.5, scale: 0.8 },
      meta: { samples: 100, lines: 100, bands: 1, interleave: "bsq" },
      ds: {},
      lastRaster: null
    };
    const readBandWindow = vi.fn(async (_meta, _src, _band, _x0, _y0, outW, outH) => (
      new Float32Array(outW * outH)
    ));
    const deps = makeDeps({
      getActive: () => ds,
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      readBandWindow,
      clampView: () => {}
    });
    const renderer = createRenderer(deps);

    await renderer.render();

    expect(deps.cpuRenderGray).toHaveBeenCalledTimes(1);
    expect(deps.cpuRenderGray.mock.calls[0][1]).toBe(200);
    expect(deps.cpuRenderGray.mock.calls[0][2]).toBe(113);
    expect(readBandWindow).toHaveBeenCalledTimes(1);
  });

  test("render uses color composite path for three-band color mode", async () => {
    const ds = {
      id: "ds1",
      activeBand: 0,
      displayMode: "rgb",
      view: { x: 0, y: 0, scale: 1 },
      meta: { samples: 8, lines: 4, bands: 3, interleave: "bsq" },
      ds: {},
      lastRaster: null,
      lastCompositeRaster: null,
      bandStatsWhole: new Map()
    };
    const readBandWindow = vi.fn(async (_meta, _src, band, _x0, _y0, outW, outH) => {
      const arr = new Float32Array(outW * outH);
      arr.fill(band + 1);
      return arr;
    });
    const deps = makeDeps({
      getActive: () => ds,
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      initWebGPU: vi.fn(async () => true),
      gpuSupported: true,
      readBandWindow,
      clampView: () => {}
    });
    const renderer = createRenderer(deps);

    await renderer.render();

    expect(deps.initWebGPU).not.toHaveBeenCalled();
    expect(deps.cpuRenderColor).toHaveBeenCalledTimes(1);
    expect(deps.cpuRenderGray).not.toHaveBeenCalled();
    expect(deps.gpuRender).not.toHaveBeenCalled();
    expect(readBandWindow).toHaveBeenCalledTimes(3);
    expect(ds.lastCompositeRaster?.channelBands).toEqual([0, 1, 2]);
  });

  test("render uses TIFF composite window reads when available", async () => {
    const compositeWindow = vi.fn(async (_meta, _x0, _y0, outW, outH) => ({
      bands: [0, 1, 2].map((band) => {
        const arr = new Float32Array(outW * outH);
        arr.fill(band + 1);
        return arr;
      })
    }));
    const ds = {
      id: "ds-tiff",
      activeBand: 0,
      displayMode: "rgb",
      view: { x: 0, y: 0, scale: 1 },
      meta: { samples: 8, lines: 4, bands: 3, interleave: "bip", sourceFormat: "tiff" },
      ds: {
        supportsCompositeWindow: () => true,
        readCompositeWindow: compositeWindow
      },
      lastRaster: null,
      lastCompositeRaster: null,
      bandStatsWhole: new Map()
    };
    const readBandWindow = vi.fn(async () => new Float32Array(0));
    const deps = makeDeps({
      getActive: () => ds,
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      readBandWindow,
      readBandWindowBIP: readBandWindow,
      clampView: () => {}
    });
    const renderer = createRenderer(deps);

    await renderer.render();

    expect(compositeWindow).toHaveBeenCalledTimes(1);
    expect(readBandWindow).not.toHaveBeenCalled();
    expect(deps.cpuRenderColor).toHaveBeenCalledTimes(1);
    expect(ds.lastCompositeRaster?.channelBands).toEqual([0, 1, 2]);
  });

  test("render paints progressive TIFF composite updates with transparent no-data", async () => {
    const compositeWindow = vi.fn(async (_meta, _x0, _y0, outW, outH, _step, options) => {
      if (typeof options?.onProgress === "function") {
        const partialBands = [0, 1, 2].map((band) => {
          const arr = new Float32Array(outW * outH);
          arr.fill(Number.NaN);
          arr[0] = band + 1;
          return arr;
        });
        await options.onProgress({ bands: partialBands, width: outW, height: outH });
      }
      return {
        bands: [0, 1, 2].map((band) => {
          const arr = new Float32Array(outW * outH);
          arr.fill(band + 1);
          return arr;
        })
      };
    });
    const ds = {
      id: "ds-tiff-progressive",
      activeBand: 0,
      displayMode: "rgb",
      view: { x: 0, y: 0, scale: 1 },
      meta: { samples: 8, lines: 4, bands: 3, interleave: "bip", sourceFormat: "tiff" },
      ds: {
        supportsCompositeWindow: () => true,
        readCompositeWindow: compositeWindow
      },
      lastRaster: null,
      lastCompositeRaster: null,
      bandStatsWhole: new Map()
    };
    const buildColorCanvas = vi.fn(() => ({ width: 8, height: 4 }));
    const drawCanvasToViewport = vi.fn();
    const deps = makeDeps({
      getActive: () => ds,
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      buildColorCanvas,
      drawCanvasToViewport,
      cpuRenderColor: vi.fn(() => ({ width: 8, height: 4 })),
      clampView: () => {}
    });
    const renderer = createRenderer(deps);

    await renderer.render();

    expect(compositeWindow).toHaveBeenCalledTimes(1);
    expect(buildColorCanvas).toHaveBeenCalledTimes(1);
    expect(buildColorCanvas.mock.calls[0][2]).toEqual(expect.objectContaining({ transparentNoData: true }));
    expect(drawCanvasToViewport).toHaveBeenCalledTimes(1);
    expect(deps.cpuRenderColor).toHaveBeenCalledTimes(1);
  });

  test("render coarsens expensive raw TIFF composite reads on first paint", async () => {
    const compositeWindow = vi.fn(async (_meta, _x0, _y0, outW, outH) => ({
      bands: [0, 1, 2].map((band) => {
        const arr = new Float32Array(outW * outH);
        arr.fill(band + 1);
        return arr;
      })
    }));
    const ds = {
      id: "ds-he",
      activeBand: 0,
      displayMode: "rgb",
      view: { x: 0, y: 0, scale: 0.5 },
      meta: { samples: 1280, lines: 720, bands: 3, interleave: "bip", sourceFormat: "tiff" },
      ds: {
        supportsCompositeWindow: () => true,
        estimateReadWork: () => ({ sparseRaw: true, nativeJpeg: false, blockCount: 64, spanReads: 8_000 }),
        readCompositeWindow: compositeWindow
      },
      lastRaster: null,
      lastCompositeRaster: null,
      bandStatsWhole: new Map()
    };
    const deps = makeDeps({
      getActive: () => ds,
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      clampView: () => {}
    });
    const renderer = createRenderer(deps);

    await renderer.render();

    expect(compositeWindow).toHaveBeenCalledTimes(1);
    expect(compositeWindow.mock.calls[0][3]).toBeLessThan(100);
    expect(compositeWindow.mock.calls[0][4]).toBeLessThan(60);
  });

  test("render uses direct TIFF composite overview reads when native overviews are available", async () => {
    const compositeWindow = vi.fn(async (_meta, _x0, _y0, outW, outH) => ({
      bands: [0, 1, 2].map((band) => {
        const arr = new Float32Array(outW * outH);
        arr.fill(band + 1);
        return arr;
      })
    }));
    const ds = {
      id: "ds-vis-native-overview",
      activeBand: 0,
      displayMode: "rgb",
      view: { x: 0, y: 0, scale: 0.5 },
      meta: { samples: 1280, lines: 720, bands: 3, interleave: "bip", sourceFormat: "tiff" },
      ds: {
        supportsCompositeWindow: () => true,
        hasNativeOverviews: () => true,
        estimateReadWork: () => ({ sparseRaw: false, nativeJpeg: true, blockCount: 400, scaledDecodePixels: 800_000 }),
        readCompositeWindow: compositeWindow
      },
      lastRaster: null,
      lastCompositeRaster: null,
      bandStatsWhole: new Map()
    };
    const deps = makeDeps({
      getActive: () => ds,
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      clampView: () => {}
    });
    const renderer = createRenderer(deps);

    await renderer.render();

    expect(compositeWindow).toHaveBeenCalledTimes(1);
    expect(compositeWindow.mock.calls[0][5]).toBeGreaterThan(1);
  });

  test("render skips pyramid-overview TIFF preview path when native overviews are unavailable", async () => {
    const compositeWindow = vi.fn(async (_meta, _x0, _y0, outW, outH) => ({
      bands: [0, 1, 2].map((band) => {
        const arr = new Float32Array(outW * outH);
        arr.fill(band + 1);
        return arr;
      })
    }));
    const ds = {
      id: "ds-vis-no-overview",
      activeBand: 0,
      displayMode: "rgb",
      view: { x: 0, y: 0, scale: 0.5 },
      meta: { samples: 1280, lines: 720, bands: 3, interleave: "bip", sourceFormat: "tiff" },
      ds: {
        supportsCompositeWindow: () => true,
        hasNativeOverviews: () => false,
        estimateReadWork: () => ({ sparseRaw: false, nativeJpeg: true, blockCount: 400, scaledDecodePixels: 800_000 }),
        readCompositeWindow: compositeWindow
      },
      lastRaster: null,
      lastCompositeRaster: null,
      bandStatsWhole: new Map()
    };
    const deps = makeDeps({
      getActive: () => ds,
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      clampView: () => {}
    });
    const renderer = createRenderer(deps);

    await renderer.render();

    expect(compositeWindow).toHaveBeenCalledTimes(1);
  });

  test("render stages raw TIFF composite refinement across same-view rerenders", async () => {
    const compositeWindow = vi.fn(async (_meta, _x0, _y0, outW, outH) => ({
      bands: [0, 1, 2].map((band) => {
        const arr = new Float32Array(outW * outH);
        arr.fill(band + 1);
        return arr;
      })
    }));
    const ds = {
      id: "ds-he-refine",
      activeBand: 0,
      displayMode: "rgb",
      view: { x: 0, y: 0, scale: 0.5 },
      meta: { samples: 1280, lines: 720, bands: 3, interleave: "bip", sourceFormat: "tiff" },
      ds: {
        supportsCompositeWindow: () => true,
        hasNativeOverviews: () => false,
        estimateReadWork: () => ({ sparseRaw: true, nativeJpeg: false, blockCount: 400, spanReads: 48_000 }),
        readCompositeWindow: compositeWindow
      },
      lastRaster: null,
      lastCompositeRaster: null,
      bandStatsWhole: new Map()
    };
    const deps = makeDeps({
      getActive: () => ds,
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      clampView: () => {}
    });
    const renderer = createRenderer(deps);
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);

    await renderer.render();
    expect(compositeWindow).toHaveBeenCalledTimes(1);
    expect(compositeWindow.mock.calls[0][3]).toBeLessThanOrEqual(20);
    expect(ds.__panelRefineStates?.get(1)).toEqual(expect.objectContaining({ maxFactor: 8 }));

    await renderer.render();
    expect(compositeWindow).toHaveBeenCalledTimes(2);
    expect(compositeWindow.mock.calls[1][3]).toBeGreaterThan(compositeWindow.mock.calls[0][3]);
    expect(ds.__panelRefineStates?.get(1)).toEqual(expect.objectContaining({ maxFactor: 4 }));

    await renderer.render();
    expect(compositeWindow).toHaveBeenCalledTimes(3);
    expect(compositeWindow.mock.calls[2][3]).toBeGreaterThan(compositeWindow.mock.calls[1][3]);
    expect(ds.__panelRefineStates?.get(1)).toEqual(expect.objectContaining({ maxFactor: 2 }));

    await renderer.render();
    expect(compositeWindow).toHaveBeenCalledTimes(4);
    expect(compositeWindow.mock.calls[3][3]).toBeGreaterThan(compositeWindow.mock.calls[2][3]);
    expect(ds.__panelRefineStates?.get(1)).toEqual(expect.objectContaining({ maxFactor: 1 }));

    await renderer.render();
    expect(compositeWindow).toHaveBeenCalledTimes(5);
    expect(compositeWindow.mock.calls[4][3]).toBeGreaterThan(compositeWindow.mock.calls[3][3]);
    raf.mockRestore();
  });

  test("render draws thumbnail-only preview while a first raw TIFF composite read is loading", async () => {
    let releaseRead = null;
    const compositeWindow = vi.fn(async () => (
      new Promise((resolve) => {
        releaseRead = () => resolve({
          bands: [0, 1, 2].map((band) => new Float32Array(10).fill(band + 1))
        });
      })
    ));
    const ds = {
      id: "ds-he-preview",
      activeBand: 0,
      displayMode: "rgb",
      view: { x: 0, y: 0, scale: 1 },
      meta: { samples: 100, lines: 50, bands: 3, interleave: "bip", sourceFormat: "tiff" },
      ds: {
        supportsCompositeWindow: () => true,
        hasNativeOverviews: () => false,
        readCompositeWindow: compositeWindow
      },
      thumb: {
        base: { width: 100, height: 50 },
        baseW: 100,
        baseH: 50,
        ready: true,
        x0: 0,
        y0: 0,
        w: 320,
        h: 180
      },
      lastRaster: null,
      lastCompositeRaster: null,
      bandStatsWhole: new Map()
    };
    const deps = makeDeps({
      getActive: () => ds,
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      clampView: () => {}
    });
    const renderer = createRenderer(deps);

    const renderPromise = renderer.render();
    await Promise.resolve();

    expect(deps.els.cpuCanvas.getContext().drawImage).toHaveBeenCalledTimes(1);
    expect(typeof releaseRead).toBe("function");
    releaseRead();
    await renderPromise;
  });

  test("render draws cached screen preview while a fresh raster is loading", async () => {
    let releaseRead = null;
    const ds = {
      id: "ds1",
      activeBand: 0,
      view: { x: 8, y: 6, scale: 1.5 },
      meta: { samples: 200, lines: 120, bands: 1, interleave: "bsq" },
      ds: {},
      lastRaster: null,
      lastScreenFrame: {
        modeKey: "gray:0",
        eff: 1,
        viewX: 0,
        viewY: 0,
        canvas: { width: 320, height: 180 }
      }
    };
    const readBandWindow = vi.fn(async (_meta, _src, _band, _x0, _y0, outW, outH) => (
      new Promise((resolve) => {
        releaseRead = () => resolve(new Float32Array(outW * outH));
      })
    ));
    const deps = makeDeps({
      getActive: () => ds,
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      readBandWindow,
      clampView: () => {}
    });
    const renderer = createRenderer(deps);

    const renderPromise = renderer.render();
    await Promise.resolve();

    const cpuCtx = deps.els.cpuCanvas.getContext();
    expect(cpuCtx.drawImage).toHaveBeenCalledTimes(1);
    expect(deps.els.cpuCanvas.style.display).toBe("block");
    expect(deps.els.gpuCanvas.style.display).toBe("none");
    expect(readBandWindow).toHaveBeenCalledTimes(1);
    expect(typeof releaseRead).toBe("function");

    releaseRead();
    await renderPromise;
  });

  test("render does not reuse an in-flight grayscale read across same-view rerenders", async () => {
    const releases = [];
    const ds = {
      id: "ds1",
      activeBand: 0,
      view: { x: 8, y: 6, scale: 1.5 },
      meta: { samples: 200, lines: 120, bands: 1, interleave: "bsq" },
      ds: {},
      lastRaster: null,
      lastScreenFrame: {
        modeKey: "gray:0",
        eff: 1,
        viewX: 0,
        viewY: 0,
        canvas: { width: 320, height: 180 }
      }
    };
    const readBandWindow = vi.fn(async (_meta, _src, _band, _x0, _y0, outW, outH) => (
      new Promise((resolve) => {
        releases.push(() => resolve(new Float32Array(outW * outH)));
      })
    ));
    const deps = makeDeps({
      getActive: () => ds,
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      readBandWindow,
      clampView: () => {}
    });
    const renderer = createRenderer(deps);

    const firstRender = renderer.render();
    await Promise.resolve();
    const secondRender = renderer.render();
    await Promise.resolve();

    expect(readBandWindow).toHaveBeenCalledTimes(2);
    expect(releases).toHaveLength(2);

    releases.forEach((release) => release());
    await Promise.all([firstRender, secondRender]);
  });

  test("render uses each panel active band for the same dataset in multi-panel mode", async () => {
    const ds = {
      id: "ds1",
      activeBand: 0,
      view: { x: 0, y: 0, scale: 1 },
      meta: { samples: 8, lines: 4, bands: 3, interleave: "bsq" },
      ds: {},
      lastRaster: null,
      lastCompositeRaster: null
    };
    const panel1 = { slot: 1, datasetId: "ds1", activeBand: 0, view: ds.view };
    const panel2 = { slot: 2, datasetId: "ds1", activeBand: 2, view: ds.view };
    const readBandWindow = vi.fn(async (_meta, _src, band, _x0, _y0, outW, outH) => {
      const data = new Float32Array(outW * outH);
      data.fill(band + 1);
      return data;
    });
    const buildGrayCanvas = vi.fn(() => ({ width: 8, height: 4 }));
    const drawCanvasToViewport = vi.fn();
    const clampView = vi.fn();
    const deps = makeDeps({
      getActive: () => ds,
      getActivePanel: () => panel2,
      getVisibleDatasetPanels: () => [
        { panel: panel1, dataset: ds },
        { panel: panel2, dataset: ds }
      ],
      getPanelLayoutDevice: () => [
        { slot: 1, x: 0, y: 0, w: 160, h: 180 },
        { slot: 2, x: 160, y: 0, w: 160, h: 180 }
      ],
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      readBandWindow,
      buildGrayCanvas,
      drawCanvasToViewport,
      clampView
    });
    const renderer = createRenderer(deps);

    await renderer.render();

    expect(clampView).toHaveBeenNthCalledWith(1, 2, ds);
    expect(clampView).toHaveBeenNthCalledWith(2, 1, ds);
    expect(readBandWindow.mock.calls.map((call) => call[2])).toEqual([2, 0]);
    expect(buildGrayCanvas).toHaveBeenCalledTimes(2);
    expect(drawCanvasToViewport).toHaveBeenCalledTimes(2);
  });

  test("render passes panel viewport size into pyramid reads", async () => {
    const ds = {
      id: "ds1",
      activeBand: 0,
      view: { x: 0, y: 0, scale: 2 },
      meta: { samples: 1280, lines: 720, bands: 1, interleave: "bsq" },
      ds: {},
      lastRaster: null,
      lastScreenFrame: null,
      lastRastersByPanel: new Map()
    };
    const panel1 = { slot: 1, datasetId: "ds1", activeBand: 0, view: ds.view };
    const panel2 = { slot: 2, datasetId: "ds1", activeBand: 0, view: ds.view };
    const tryRasterFromPyramid = vi
      .fn()
      .mockResolvedValue({
        band: 0,
        w: 100,
        h: 50,
        dataF32: new Float32Array(100 * 50),
        partial: false,
        approximate: true
      });
    const buildGrayCanvas = vi.fn(() => ({ width: 100, height: 50 }));
    const drawCanvasToViewport = vi.fn();
    const deps = makeDeps({
      getActive: () => ds,
      getActivePanel: () => panel2,
      getVisibleDatasetPanels: () => [
        { panel: panel1, dataset: ds },
        { panel: panel2, dataset: ds }
      ],
      getPanelLayoutDevice: () => [
        { slot: 1, x: 0, y: 0, w: 140, h: 180 },
        { slot: 2, x: 140, y: 0, w: 180, h: 180 }
      ],
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      tryRasterFromPyramid,
      buildGrayCanvas,
      drawCanvasToViewport,
      readBandWindow: vi.fn(async () => {
        throw new Error("direct read should not run for this preview render");
      }),
      clampView: () => {}
    });
    const renderer = createRenderer(deps);

    await renderer.render();

    expect(tryRasterFromPyramid).toHaveBeenNthCalledWith(1, ds, 0, 2, 180, 180);
    expect(tryRasterFromPyramid).toHaveBeenNthCalledWith(2, ds, 0, 2, 140, 180);
  });

  test("render overlay mode tints both layers without throwing", async () => {
    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, "createElement").mockImplementation((tagName) => {
      if (String(tagName).toLowerCase() === "canvas") {
        return {
          width: 0,
          height: 0,
          getContext: () => ({
            drawImage: vi.fn(),
            fillRect: vi.fn(),
            setTransform: vi.fn(),
            clearRect: vi.fn(),
            beginPath: vi.fn(),
            rect: vi.fn(),
            clip: vi.fn(),
            save: vi.fn(),
            restore: vi.fn(),
            imageSmoothingEnabled: false,
            globalCompositeOperation: "source-over",
            fillStyle: ""
          })
        };
      }
      return originalCreateElement(tagName);
    });

    try {
      const dsLeft = {
        id: "left",
        activeBand: 0,
        view: { x: 0, y: 0, scale: 1 },
        meta: { samples: 64, lines: 32, bands: 1, interleave: "bsq", sourceFormat: "envi" },
        ds: {},
        lastRaster: null,
        lastCompositeRaster: null
      };
      const dsRight = {
        id: "right",
        activeBand: 0,
        view: { x: 0, y: 0, scale: 1 },
        meta: { samples: 64, lines: 32, bands: 1, interleave: "bsq", sourceFormat: "tiff" },
        ds: {},
        lastRaster: null,
        lastCompositeRaster: null
      };
      const panel1 = { slot: 1, datasetId: "left", activeBand: 0, view: dsLeft.view };
      const panel2 = { slot: 2, datasetId: "right", activeBand: 0, view: dsRight.view };
      const readBandWindow = vi.fn(async (_meta, _src, _band, _x0, _y0, outW, outH) => new Float32Array(outW * outH));
      const buildGrayCanvas = vi.fn(() => ({ width: 64, height: 32 }));
      const drawCanvasToViewport = vi.fn();
      const deps = makeDeps({
        getActive: () => dsLeft,
        getActivePanel: () => panel1,
        getVisibleDatasetPanels: () => [
          { panel: panel1, dataset: dsLeft },
          { panel: panel2, dataset: dsRight }
        ],
        getDisplayCompositionMode: () => "overlay",
        getPanelLayoutDevice: () => [
          { slot: 1, x: 0, y: 0, w: 320, h: 180 },
          { slot: 2, x: 0, y: 0, w: 320, h: 180 }
        ],
        getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
        readBandWindow,
        buildGrayCanvas,
        drawCanvasToViewport,
        clampView: () => {}
      });
      const renderer = createRenderer(deps);

      await renderer.render();

      expect(buildGrayCanvas).toHaveBeenCalledTimes(2);
      expect(drawCanvasToViewport).toHaveBeenCalledTimes(2);
    } finally {
      createElementSpy.mockRestore();
    }
  });

  test("render prioritizes ENVI panel draws ahead of slower TIFF panel work", async () => {
    let releaseComposite = null;
    const dsEnvi = {
      id: "envi",
      activeBand: 0,
      view: { x: 0, y: 0, scale: 1 },
      meta: { samples: 64, lines: 32, bands: 1, interleave: "bsq", sourceFormat: "envi" },
      ds: {},
      lastRaster: null,
      lastCompositeRaster: null
    };
    const dsTiff = {
      id: "vis",
      activeBand: 0,
      displayMode: "rgb",
      view: { x: 0, y: 0, scale: 1 },
      meta: { samples: 64, lines: 32, bands: 3, interleave: "bip", sourceFormat: "tiff" },
      ds: {
        supportsCompositeWindow: () => true,
        readCompositeWindow: vi.fn(async (_meta, _x0, _y0, outW, outH) => (
          new Promise((resolve) => {
            releaseComposite = () => resolve({
              bands: [0, 1, 2].map((band) => {
                const arr = new Float32Array(outW * outH);
                arr.fill(band + 1);
                return arr;
              })
            });
          })
        ))
      },
      lastRaster: null,
      lastCompositeRaster: null,
      bandStatsWhole: new Map()
    };
    const panel1 = { slot: 1, datasetId: "envi", activeBand: 0, view: dsEnvi.view };
    const panel2 = { slot: 2, datasetId: "vis", activeBand: 0, view: dsTiff.view };
    const readBandWindow = vi.fn(async (_meta, _src, _band, _x0, _y0, outW, outH) => new Float32Array(outW * outH));
    const buildGrayCanvas = vi.fn(() => ({ width: 64, height: 32 }));
    const buildColorCanvas = vi.fn(() => ({ width: 64, height: 32 }));
    const drawCanvasToViewport = vi.fn();
    const deps = makeDeps({
      getActive: () => dsTiff,
      getActivePanel: () => panel2,
      getVisibleDatasetPanels: () => [
        { panel: panel1, dataset: dsEnvi },
        { panel: panel2, dataset: dsTiff }
      ],
      getPanelLayoutDevice: () => [
        { slot: 1, x: 0, y: 0, w: 160, h: 180 },
        { slot: 2, x: 160, y: 0, w: 160, h: 180 }
      ],
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      readBandWindow,
      buildGrayCanvas,
      buildColorCanvas,
      drawCanvasToViewport,
      clampView: () => {}
    });
    const renderer = createRenderer(deps);

    const renderPromise = renderer.render();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(readBandWindow).toHaveBeenCalledTimes(1);
    expect(dsTiff.ds.readCompositeWindow).toHaveBeenCalledTimes(1);
    expect(buildGrayCanvas).toHaveBeenCalledTimes(1);
    expect(drawCanvasToViewport).toHaveBeenCalledTimes(1);
    expect(typeof releaseComposite).toBe("function");

    releaseComposite();
    await renderPromise;

    expect(buildColorCanvas).toHaveBeenCalledTimes(1);
    expect(drawCanvasToViewport).toHaveBeenCalledTimes(2);
  });

  test("render keeps progressive TIFF panel state across a same-view rerender", async () => {
    let firstCancelled = null;
    let releaseFirstComposite = null;
    let compositeCalls = 0;
    const makeComposite = (outW, outH, fillOffset = 0) => ({
      bands: [0, 1, 2].map((band) => {
        const arr = new Float32Array(outW * outH);
        arr.fill(band + 1 + fillOffset);
        return arr;
      })
    });
    const dsEnvi = {
      id: "envi",
      activeBand: 0,
      view: { x: 0, y: 0, scale: 1 },
      meta: { samples: 64, lines: 32, bands: 1, interleave: "bsq", sourceFormat: "envi" },
      ds: {},
      lastRaster: null,
      lastCompositeRaster: null
    };
    const dsTiff = {
      id: "vis",
      activeBand: 0,
      displayMode: "rgb",
      view: { x: 0, y: 0, scale: 1 },
      meta: { samples: 64, lines: 32, bands: 3, interleave: "bip", sourceFormat: "tiff" },
      ds: {
        supportsCompositeWindow: () => true,
        readCompositeWindow: vi.fn(async (_meta, _x0, _y0, outW, outH, _step, options) => {
          compositeCalls += 1;
          if (compositeCalls === 1) {
            firstCancelled = options?.cancelled || null;
            await options?.onProgress?.({
              bands: [0, 1, 2].map((band) => {
                const arr = new Float32Array(outW * outH);
                arr.fill(Number.NaN);
                arr[0] = band + 1;
                return arr;
              })
            });
            return new Promise((resolve) => {
              releaseFirstComposite = () => resolve(makeComposite(outW, outH));
            });
          }
          return makeComposite(outW, outH, 10);
        })
      },
      lastRaster: null,
      lastCompositeRaster: null,
      lastScreenFrame: null,
      bandStatsWhole: new Map()
    };
    const panel1 = { slot: 1, datasetId: "envi", activeBand: 0, view: dsEnvi.view };
    const panel2 = { slot: 2, datasetId: "vis", activeBand: 0, view: dsTiff.view };
    const deps = makeDeps({
      getActive: () => dsTiff,
      getActivePanel: () => panel2,
      getVisibleDatasetPanels: () => [
        { panel: panel1, dataset: dsEnvi },
        { panel: panel2, dataset: dsTiff }
      ],
      getPanelLayoutDevice: () => [
        { slot: 1, x: 0, y: 0, w: 160, h: 180 },
        { slot: 2, x: 160, y: 0, w: 160, h: 180 }
      ],
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      readBandWindow: vi.fn(async (_meta, _src, _band, _x0, _y0, outW, outH) => new Float32Array(outW * outH)),
      buildGrayCanvas: vi.fn(() => ({ width: 64, height: 32 })),
      buildColorCanvas: vi.fn(() => ({ width: 64, height: 32 })),
      drawCanvasToViewport: vi.fn(),
      clampView: () => {}
    });
    const renderer = createRenderer(deps);

    const firstRender = renderer.render();
    await Promise.resolve();
    await Promise.resolve();

    expect(typeof firstCancelled).toBe("function");
    expect(dsTiff.lastScreenFrame).toBeTruthy();

    const secondRender = renderer.render();
    await Promise.resolve();
    await Promise.resolve();

    expect(firstCancelled()).toBe(false);
    expect(typeof releaseFirstComposite).toBe("function");
    expect(dsTiff.ds.readCompositeWindow).toHaveBeenCalledTimes(1);

    releaseFirstComposite();
    await Promise.all([firstRender, secondRender]);
    expect(dsTiff.ds.readCompositeWindow).toHaveBeenCalledTimes(1);
  });

  test("render does not collapse nearby panel views into the same in-flight TIFF request", async () => {
    let releaseFirstComposite = null;
    let compositeCalls = 0;
    const ds = {
      id: "vis",
      activeBand: 0,
      displayMode: "rgb",
      view: { x: 0, y: 0, scale: 1 },
      meta: { samples: 64, lines: 32, bands: 3, interleave: "bip", sourceFormat: "tiff" },
      ds: {
        supportsCompositeWindow: () => true,
        readCompositeWindow: vi.fn(async (_meta, _x0, _y0, outW, outH) => {
          compositeCalls += 1;
          const composite = {
            bands: [0, 1, 2].map((band) => {
              const arr = new Float32Array(outW * outH);
              arr.fill(band + 1);
              return arr;
            })
          };
          if (compositeCalls === 1) {
            return new Promise((resolve) => {
              releaseFirstComposite = () => resolve(composite);
            });
          }
          return composite;
        })
      },
      lastRaster: null,
      lastCompositeRaster: null,
      lastScreenFrame: null,
      bandStatsWhole: new Map()
    };
    const panel = { slot: 1, datasetId: "vis", activeBand: 0, view: ds.view };
    const deps = makeDeps({
      getActive: () => ds,
      getActivePanel: () => panel,
      getVisibleDatasetPanels: () => [{ panel, dataset: ds }],
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      buildColorCanvas: vi.fn(() => ({ width: 64, height: 32 })),
      drawCanvasToViewport: vi.fn(),
      clampView: () => {}
    });
    const renderer = createRenderer(deps);

    const firstRender = renderer.render();
    await Promise.resolve();
    await Promise.resolve();
    expect(ds.ds.readCompositeWindow).toHaveBeenCalledTimes(1);

    ds.view.x = 0.25;
    const secondRender = renderer.render();
    await Promise.resolve();
    await Promise.resolve();

    expect(ds.ds.readCompositeWindow).toHaveBeenCalledTimes(2);
    expect(typeof releaseFirstComposite).toBe("function");
    releaseFirstComposite();
    await secondRender;
    await firstRender;
  });

  test("render tries the pyramid path even when the view extends outside bounds", async () => {
    const ds = {
      id: "ds1",
      activeBand: 0,
      view: { x: -4, y: 0, scale: 1 },
      meta: { samples: 8, lines: 4, bands: 1, interleave: "bsq" },
      ds: {},
      lastRaster: null,
      lastScreenFrame: null,
      lastRastersByPanel: new Map()
    };
    const pyramidRaster = {
      band: 0,
      w: 4,
      h: 2,
      dataF32: new Float32Array(8),
      partial: false,
      approximate: false
    };
    const tryRasterFromPyramid = vi.fn(async () => pyramidRaster);
    const readBandWindow = vi.fn(async () => {
      throw new Error("direct read should not run when pyramid raster is available");
    });
    const deps = makeDeps({
      getActive: () => ds,
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      tryRasterFromPyramid,
      readBandWindow,
      clampView: () => {}
    });
    const renderer = createRenderer(deps);

    await renderer.render();

    expect(tryRasterFromPyramid).toHaveBeenCalledWith(ds, 0, 1, 320, 180);
    expect(readBandWindow).not.toHaveBeenCalled();
  });

  test.each([
    { kind: "partial", scale: 0.5, partial: true, approximate: false },
    { kind: "approximate", scale: 2, partial: false, approximate: true }
  ])("renders $kind pyramid previews without promoting them to stable rasters", async ({ scale, partial, approximate }) => {
    const previewRaster = {
      band: 0,
      w: 160,
      h: 90,
      dataF32: new Float32Array(160 * 90),
      partial,
      approximate
    };
    const ds = {
      id: "ds1",
      activeBand: 0,
      view: { x: 0, y: 0, scale },
      meta: { samples: 1280, lines: 720, bands: 1, interleave: "bsq" },
      ds: {},
      lastRaster: null,
      lastScreenFrame: null,
      lastRastersByPanel: new Map()
    };
    const deps = makeDeps({
      getActive: () => ds,
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      tryRasterFromPyramid: async () => previewRaster,
      cpuRenderGray: vi.fn(() => ({ width: 160, height: 90 })),
      readBandWindow: vi.fn(async () => {
        throw new Error("direct read should not run for this progressive render");
      }),
      clampView: () => {}
    });
    const renderer = createRenderer(deps);

    await renderer.render();

    expect(deps.cpuRenderGray).toHaveBeenCalledTimes(1);
    expect(ds.lastRaster).toBeNull();
    expect(ds.lastScreenFrame).toBeTruthy();
    expect(ds.lastRastersByPanel.size).toBe(0);
  });
});
