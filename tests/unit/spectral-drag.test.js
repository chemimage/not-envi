import { describe, expect, test, vi } from "vitest";
import { createSpectralDragController } from "../../src/app/wiring/spectral-drag.js";

describe("spectral drag controller", () => {
  test("dismisses the spectrum panel when the single-point selection moves out of bounds", () => {
    const closeSpectrum = vi.fn();
    const openSpectrumAt = vi.fn(async () => {});
    const ctrl = createSpectralDragController({
      els: {
        main: {
          getBoundingClientRect: () => ({ left: 0, top: 0 })
        }
      },
      getActive: () => ({
        id: "ds1",
        meta: { samples: 10, lines: 8 }
      }),
      screenToImage: (sx, sy) => ({ x: sx, y: sy }),
      getEffectiveAreaSelectionKey: () => "",
      getSpectrumPickEnabled: () => true,
      openSpectrumAt,
      closeSpectrum
    });

    const began = ctrl.beginFromEvent({
      pointerId: 1,
      clientX: 4,
      clientY: 5,
      pointerType: "mouse"
    });
    expect(began).toBe(true);
    expect(openSpectrumAt).toHaveBeenCalledTimes(1);

    const updated = ctrl.updateFromEvent({
      pointerId: 1,
      clientX: -1,
      clientY: 5,
      pointerType: "mouse"
    });

    expect(updated).toBe(true);
    expect(closeSpectrum).toHaveBeenCalledTimes(1);
  });

  test("preview rejects out-of-bounds points", () => {
    const ctrl = createSpectralDragController({
      els: {
        main: {
          getBoundingClientRect: () => ({ left: 0, top: 0 })
        }
      },
      getActive: () => ({
        id: "ds1",
        meta: { samples: 10, lines: 8 }
      }),
      screenToImage: (sx, sy) => ({ x: sx, y: sy }),
      getEffectiveAreaSelectionKey: () => "",
      getSpectrumPickEnabled: () => true,
      openSpectrumAt: vi.fn(async () => {}),
      closeSpectrum: vi.fn()
    });

    expect(ctrl.previewFromEvent({
      clientX: 2,
      clientY: 3,
      pointerType: "mouse"
    })).toBe(true);

    expect(ctrl.previewFromEvent({
      clientX: 12,
      clientY: 3,
      pointerType: "mouse"
    })).toBe(false);
  });
});
