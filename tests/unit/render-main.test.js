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

  test("render keeps zoomed-out direct raster sizing consistent", async () => {
    const ds = {
      id: 1,
      activeBand: 0,
      view: { x: -150, y: -62.5, scale: 0.8 },
      meta: { samples: 100, lines: 100, interleave: "bsq" },
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

  test("render draws cached screen preview while a fresh raster is loading", async () => {
    let releaseRead = null;
    const ds = {
      id: "ds1",
      activeBand: 0,
      view: { x: 8, y: 6, scale: 1.5 },
      meta: { samples: 200, lines: 120, interleave: "bsq" },
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

    const cpuCtx = deps.els.cpuCanvas.getContext();
    expect(cpuCtx.drawImage).toHaveBeenCalledTimes(1);
    expect(deps.els.cpuCanvas.style.display).toBe("block");
    expect(deps.els.gpuCanvas.style.display).toBe("none");

    releaseRead();
    await renderPromise;
  });
});
