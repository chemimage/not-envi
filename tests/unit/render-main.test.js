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
});
