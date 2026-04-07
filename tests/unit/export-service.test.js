import { describe, expect, test, vi } from "vitest";
import { createExportService } from "../../src/export/export-service.js";

function baseDeps() {
  return {
    state: { selection: { imgRect: null } },
    els: { cpuCanvas: { width: 100, height: 100 }, exportDlg: { close: () => {} }, expFormatPng: { checked: true } },
    getActive: () => null,
    setStatus: () => {},
    humanBytes: (n) => String(n),
    fmt: (n) => String(n),
    clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
    bandLabel: () => "b0",
    renderWindowToImageData: async (_ds, _band, _x0, _y0, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    readBandWindow: async () => new Float32Array(1),
    readBandWindowBIP: async () => new Float32Array(1),
    downloadBlob: () => {},
    alertFn: () => {},
    confirmFn: () => true
  };
}

describe("export service", () => {
  test("collectAreaSelections uses effective (single/group-aware) selection list when provided", () => {
    const ds = {
      id: 1,
      meta: { samples: 200, lines: 200 },
      drawings: [
        { id: 10, tool: "rect", points: [{ x: 2, y: 2 }, { x: 8, y: 8 }] },
        { id: 11, tool: "rect", points: [{ x: 20, y: 20 }, { x: 40, y: 40 }] }
      ]
    };
    const deps = baseDeps();
    deps.getEffectiveAreaSelections = () => [ds.drawings[1]];
    const service = createExportService(deps);

    const selections = service.collectAreaSelections(ds);
    expect(selections).toHaveLength(1);
    expect(selections[0].id).toBe(11);
    expect(selections[0].rect.w).toBe(20);
    expect(selections[0].rect.h).toBe(20);
  });

  test("exportRendered draws ruler overlays into rendered output", async () => {
    const ds = {
      name: "demo",
      activeBand: 0,
      meta: { samples: 64, lines: 64 },
      drawings: []
    };
    const deps = baseDeps();
    deps.downloadBlob = vi.fn();
    deps.getDrawData = vi.fn(() => ({
      items: [],
      draft: null,
      rulerHover: null,
      rulerProfileHover: null,
      selectionIds: [],
      marqueeOffset: 0
    }));
    const ctx = {
      putImageData: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(400), width: 10, height: 10 })),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      strokeRect: vi.fn(),
      clearRect: vi.fn(),
      setTransform: vi.fn(),
      set strokeStyle(v) { this._strokeStyle = v; },
      set lineWidth(v) { this._lineWidth = v; }
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ctx),
      toBlob: vi.fn((cb) => cb(new Blob(["x"], { type: "image/png" })))
    };
    const originalCreateElement = document.createElement.bind(document);
    const createEl = vi.spyOn(document, "createElement").mockImplementation((tag) => {
      if (tag === "canvas") return canvas;
      return originalCreateElement(tag);
    });
    try {
      const service = createExportService(deps);
      await service.exportRendered(ds, "png", { x0: 0, y0: 0, w: 10, h: 10 }, "window", [0], { includeAnnotations: true });
      expect(deps.getDrawData).toHaveBeenCalled();
      expect(deps.downloadBlob).toHaveBeenCalledTimes(1);
    } finally {
      createEl.mockRestore();
    }
  });
});
