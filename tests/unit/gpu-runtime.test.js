import { afterEach, describe, expect, test, vi } from "vitest";
import { createGpuRuntime } from "../../src/render/gpu-runtime.js";

afterEach(() => vi.unstubAllGlobals());

describe("gpu runtime", () => {
  test("reports unsupported and no-op when navigator.gpu is unavailable", async () => {
    vi.stubGlobal("navigator", { gpu: undefined });
    const rt = createGpuRuntime({
      els: {
        main: { getBoundingClientRect: () => ({ width: 100, height: 100 }) },
        gpuCanvas: { width: 0, height: 0, getContext: () => null }
      }
    });
    expect(rt.supported).toBe(false);
    await expect(rt.ensureReady()).resolves.toBe(false);
    expect(rt.renderGray(new Float32Array([0]), 1, 1, { minVal: 0, maxVal: 1, gamma: 1, gain: 1, contrast: 1 })).toBe(false);
  });
});
