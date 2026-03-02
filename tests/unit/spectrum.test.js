import { afterEach, describe, expect, test, vi } from "vitest";
import { createSpectrumController } from "../../src/render/spectrum.js";

describe("spectrum controller", () => {
  const originalRAF = globalThis.requestAnimationFrame;

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRAF;
  });

  test("open/close lifecycle updates panel state", async () => {
    globalThis.requestAnimationFrame = (cb) => {
      cb();
      return 1;
    };

    const specCtx = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      setLineDash: vi.fn(),
      fillText: vi.fn(),
      textAlign: "",
      textBaseline: "",
      lineWidth: 1,
      strokeStyle: "",
      fillStyle: "",
      font: ""
    };
    const els = {
      specPanel: { style: { display: "none" } },
      specCanvas: {
        width: 0,
        height: 0,
        getBoundingClientRect: () => ({ width: 300, height: 180 })
      },
      specSub: { textContent: "" },
      specFoot: { textContent: "" }
    };
    const ds = {
      id: 7,
      name: "demo",
      activeBand: 1,
      meta: { bands: 3, wlUnits: "nm", scale: null, bandNames: ["a", "b", "c"] }
    };

    const ctrl = createSpectrumController({
      els,
      specCtx,
      getActive: () => ds,
      bandLabel: (_ds, b) => `B${b}`,
      updatePerf: vi.fn(),
      sanitizeFilePart: (s) => s,
      downloadBlob: vi.fn(),
      readSpectrumAtPixel: async () => new Float32Array([1, 2, 3]),
      wavelengthArrayOrNull: () => [500, 600, 700]
    });

    await ctrl.openSpectrumAt(ds, 10, 20);
    expect(ctrl.isOpenForDatasetId(7)).toBe(true);
    expect(els.specPanel.style.display).toBe("block");

    ctrl.closeSpectrum();
    expect(ctrl.isOpenForDatasetId(7)).toBe(false);
    expect(els.specPanel.style.display).toBe("none");
  });
});
