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

  test("drawOverlays draws grid lines when enabled", () => {
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
});
