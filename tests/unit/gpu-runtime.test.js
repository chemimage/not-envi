import { describe, expect, test } from "vitest";
import { createGpuRuntime } from "../../src/render/gpu-runtime.js";

describe("gpu runtime", () => {
  test("reports unsupported and no-op when navigator.gpu is unavailable", async () => {
    const rt = createGpuRuntime({
      els: {
        main: { getBoundingClientRect: () => ({ width: 100, height: 100 }) },
        gpuCanvas: { width: 0, height: 0, getContext: () => null }
      }
    });
    if (rt.supported) {
      // Environment may provide WebGPU; just assert interface exists.
      expect(typeof rt.ensureReady).toBe("function");
      expect(typeof rt.renderGray).toBe("function");
      return;
    }
    await expect(rt.ensureReady()).resolves.toBe(false);
    expect(rt.renderGray(new Float32Array([0]), 1, 1, { minVal: 0, maxVal: 1, gamma: 1, gain: 1, contrast: 1 })).toBe(false);
  });
});
