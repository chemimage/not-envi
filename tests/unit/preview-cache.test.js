import { describe, expect, test, vi } from "vitest";
import { drawCachedScreenPreview, updateScreenPreviewCache } from "../../src/render/preview-cache.js";

describe("preview cache", () => {
  test("replays cached preview using its original viewport size", () => {
    const drawImage = vi.fn();
    const fillRect = vi.fn();
    const beginPath = vi.fn();
    const rect = vi.fn();
    const clip = vi.fn();
    const cpuCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      beginPath,
      rect,
      clip,
      fillRect,
      drawImage,
      imageSmoothingEnabled: false,
      fillStyle: ""
    };
    const els = {
      cpuCanvas: { getContext: () => cpuCtx, style: {} },
      gpuCanvas: { style: {} }
    };
    const ds = {
      view: { x: 0, y: 0 },
      lastScreenFrames: new Map()
    };
    const sourceCanvas = { width: 64, height: 32 };
    const viewport = { x: 0, y: 0, w: 320, h: 180 };

    updateScreenPreviewCache(ds, 1, "gray:0", 1, sourceCanvas, viewport);
    const drew = drawCachedScreenPreview({
      els,
      ds,
      panelSlot: 1,
      modeKey: "gray:0",
      eff: 1,
      viewport
    });

    expect(drew).toBe(true);
    expect(fillRect).toHaveBeenCalledWith(0, 0, 320, 180);
    expect(beginPath).toHaveBeenCalledTimes(1);
    expect(rect).toHaveBeenCalledWith(0, 0, 320, 180);
    expect(clip).toHaveBeenCalledTimes(1);
    expect(drawImage).toHaveBeenCalledWith(sourceCanvas, 0, 0, 320, 180);
  });
});
