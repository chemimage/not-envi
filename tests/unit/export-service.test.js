import { describe, expect, test, vi } from "vitest";
import { fromArrayBuffer } from "geotiff";
import { createExportService } from "../../src/export/export-service.js";

async function blobToArrayBuffer(blob) {
  if (blob && typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  if (typeof FileReader !== "undefined") {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(fr.error || new Error("Failed reading blob"));
      fr.onload = () => resolve(fr.result);
      fr.readAsArrayBuffer(blob);
    });
  }
  return new Response(blob).arrayBuffer();
}

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
    getBandSettings: () => ({ min: null, max: null, brightness: 0, gain: 1, contrast: 1 }),
    resolveDisplayRange: () => ({ minVal: 0, maxVal: 1 }),
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
      selectedAreaId: 21,
      drawings: [
        { id: 21, tool: "rect", points: [{ x: 1, y: 1 }, { x: 8, y: 8 }] },
        { id: 22, tool: "ruler", color: "#22c55e", points: [{ x: 2, y: 3 }, { x: 20, y: 10 }] }
      ]
    };
    const deps = baseDeps();
    deps.downloadBlob = vi.fn();
    deps.getEffectiveAreaSelections = vi.fn(() => [ds.drawings[0]]);
    deps.getDrawData = vi.fn((_dataset, explicitState) => ({
      items: explicitState?.drawings || [],
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
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      fillText: vi.fn(),
      measureText: vi.fn(() => ({ width: 24 })),
      setLineDash: vi.fn(),
      arcTo: vi.fn(),
      closePath: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
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
      await service.exportRendered(ds, "png", { x0: 0, y0: 0, w: 10, h: 10 }, "window", [0], {
        includeAnnotations: true,
        omitSelectionOverlay: true
      });
      expect(deps.getDrawData).toHaveBeenCalled();
      const explicitState = deps.getDrawData.mock.calls[0][1];
      expect(explicitState.drawings).toHaveLength(1);
      expect(explicitState.drawings[0].id).toBe(22);
      expect(explicitState.selectedAreaId).toBeNull();
      expect(deps.downloadBlob).toHaveBeenCalledTimes(1);
    } finally {
      createEl.mockRestore();
    }
  });

  test("exportScaled8StackTIFF scales raw samples using the current display range", async () => {
    const deps = baseDeps();
    deps.resolveDisplayRange = vi.fn(() => ({ minVal: 0, maxVal: 20 }));
    deps.readBandWindow = vi.fn(async () => new Float32Array([-10, 0, 10, 30]));
    deps.downloadBlob = vi.fn();
    const service = createExportService(deps);
    const ds = {
      name: "demo",
      activeBand: 0,
      ds: {},
      meta: {
        samples: 2,
        lines: 2,
        bands: 1,
        interleave: "bsq",
        dataType: 4,
        dataTypeInfo: { bytes: 4, name: "float32", ctor: Float32Array }
      }
    };

    await service.exportScaled8StackTIFF(ds, { x0: 0, y0: 0, w: 2, h: 2 }, [0]);

    expect(deps.downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, filename] = deps.downloadBlob.mock.calls[0];
    expect(filename).toContain("scaled8.tiff");
    const tiff = await fromArrayBuffer(await blobToArrayBuffer(blob));
    const img = await tiff.getImage(0);
    expect(img.fileDirectory.BitsPerSample[0]).toBe(8);
    const raster = await img.readRasters({ samples: [0] });
    const values = ArrayBuffer.isView(raster) ? raster : raster[0];
    expect(deps.resolveDisplayRange).toHaveBeenCalledWith(ds, 0, null);
    expect(Array.from(values)).toEqual([0, 0, 128, 255]);
  });
});
