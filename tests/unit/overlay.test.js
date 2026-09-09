import { describe, expect, test, vi } from "vitest";
import { createOverlayRenderer } from "../../src/render/overlay.js";

function makeCtx() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
    setLineDash: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    rect: vi.fn(),
    strokeRect: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 42 }))
  };
}

describe("overlay renderer", () => {
  test("drawOverlays clears overlay even when dataset is missing", () => {
    const ctx = makeCtx();
    const els = {
      chkScale: { checked: false },
      chkGrid: { checked: false },
      overlayCanvas: { width: 400, height: 300 }
    };
    const overlay = createOverlayRenderer({
      els,
      overlayCtx: ctx,
      getDevicePixelRatio: () => 1
    });

    overlay.drawOverlays(null);
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 400, 300);
  });

  test("grid spacing snaps to decimal 1/2/5 progression", () => {
    const ctx = makeCtx();
    const els = {
      chkScale: { checked: false },
      chkGrid: { checked: true },
      overlayCanvas: { width: 512, height: 256 }
    };
    const overlay = createOverlayRenderer({
      els,
      overlayCtx: ctx,
      getDevicePixelRatio: () => 1
    });
    const ds = {
      view: { x: 0, y: 0, scale: 1 },
      meta: { samples: 1024, lines: 512 }
    };

    overlay.drawOverlays(ds);

    expect(ctx.beginPath).toHaveBeenCalled();
    expect(ctx.stroke).toHaveBeenCalled();
    const moveCalls = ctx.moveTo.mock.calls;
    expect(moveCalls.length).toBeGreaterThan(1);
    expect(moveCalls[0][0]).toBe(0);
    expect(moveCalls[1][0]).toBe(100);
  });

  test("drawOverlays boundary follows rendered raster footprint", () => {
    const ctx = makeCtx();
    const els = {
      chkScale: { checked: false },
      chkGrid: { checked: false },
      overlayCanvas: { width: 10, height: 10 }
    };
    const overlay = createOverlayRenderer({
      els,
      overlayCtx: ctx,
      getDevicePixelRatio: () => 1
    });
    const ds = {
      view: { x: -0.2, y: -0.2, scale: 1 },
      meta: { samples: 5, lines: 5 }
    };

    overlay.drawOverlays(ds);
    expect(ctx.strokeRect).toHaveBeenCalledWith(1, 1, 4, 4);
  });

  test("drawOverlaysForPanel uses the provided panel raster and band for ruler profiles", () => {
    const ctx = makeCtx();
    const els = {
      chkScale: { checked: false },
      chkGrid: { checked: false },
      overlayCanvas: { width: 200, height: 120 }
    };
    const overlay = createOverlayRenderer({
      els,
      overlayCtx: ctx,
      getDevicePixelRatio: () => 1,
      getDrawData: () => ({
        items: [
          { id: 9, tool: "ruler", color: "#fff", points: [{ x: 10, y: 20 }, { x: 50, y: 20 }] }
        ],
        draft: null,
        rulerHover: null,
        rulerProfileHover: null,
        selectionIds: [],
        marqueeOffset: 0
      })
    });
    const ds = {
      activeBand: 0,
      view: { x: 0, y: 0, scale: 1 },
      meta: { samples: 100, lines: 80 }
    };
    const panelRaster = {
      band: 2,
      dataF32: new Float32Array(ds.meta.samples * ds.meta.lines).fill(5),
      w: ds.meta.samples,
      h: ds.meta.lines,
      step: 1,
      x0: 0,
      y0: 0
    };

    overlay.drawOverlaysForPanel(ds, { x: 0, y: 0, w: 100, h: 80 }, { raster: panelRaster, activeBand: 2 });
    expect(ctx.stroke).toHaveBeenCalledTimes(3);
  });

  test("draws spectral point crosshair at fixed viewport-relative screen size", () => {
    const ctx = makeCtx();
    const strokeStyles = [];
    Object.defineProperty(ctx, "strokeStyle", {
      get: () => strokeStyles[strokeStyles.length - 1],
      set: (value) => { strokeStyles.push(value); },
      configurable: true
    });
    const els = {
      chkScale: { checked: false },
      chkGrid: { checked: false },
      overlayCanvas: { width: 200, height: 100 }
    };
    const overlay = createOverlayRenderer({
      els,
      overlayCtx: ctx,
      getDevicePixelRatio: () => 1,
      getDrawData: () => ({
        items: [],
        draft: null,
        rulerHover: null,
        rulerProfileHover: null,
        selectionIds: [],
        marqueeOffset: 0,
        spectrumPoint: { dsId: "ds1", x: 49, y: 29, color: "#22c55e" }
      })
    });
    const ds = {
      id: "ds1",
      view: { x: 0, y: 0, scale: 1 },
      meta: { samples: 100, lines: 60 }
    };

    overlay.drawOverlaysForPanel(ds, { x: 0, y: 0, w: 200, h: 100 }, {});
    expect(ctx.moveTo).toHaveBeenCalledWith(44.5, 29.5);
    expect(ctx.lineTo).toHaveBeenCalledWith(48, 29.5);
    expect(ctx.moveTo).toHaveBeenCalledWith(49.5, 24.5);
    expect(ctx.lineTo).toHaveBeenCalledWith(49.5, 28);
    expect(strokeStyles).toContain("rgba(34,197,94,0.96)");

    ctx.moveTo.mockClear();
    ctx.lineTo.mockClear();
    ds.view.scale = 2;
    ds.view.x = 24.75;
    ds.view.y = 14.75;
    overlay.drawOverlaysForPanel(ds, { x: 0, y: 0, w: 200, h: 100 }, {});
    expect(ctx.moveTo).toHaveBeenCalledWith(44.5, 29.5);
    expect(ctx.lineTo).toHaveBeenCalledWith(48, 29.5);
    expect(ctx.moveTo).toHaveBeenCalledWith(49.5, 24.5);
    expect(ctx.lineTo).toHaveBeenCalledWith(49.5, 28);
  });
});
