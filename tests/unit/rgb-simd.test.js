// @vitest-environment node
import { describe, expect, test } from "vitest";
import { verifyRgbArtifact } from "../../scripts/rgb-artifact.mjs";
import { createRgbSimdKernel } from "../../src/render/rgb-simd.js";
import { loadRgbSimdKernel } from "../../src/render/rgb-simd-loader.js";
import { tone01 } from "../../src/render/display-math.js";

const bytes = verifyRgbArtifact();
function oracle(rasters, params, dst, w, rect, transparent) {
  for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) {
    const i = y * w + x, p = i * 4;
    if (transparent && rasters.some(r => !Number.isFinite(r.dataF32[i]))) { dst.fill(0, p, p + 4); continue; }
    for (let c = 0; c < 3; c++) {
      const t = params[c];
      dst[p + c] = Math.round(tone01(rasters[c].dataF32[i], t.minVal, t.maxVal, t.brightness, t.gain, t.contrast) * 255);
    }
    dst[p + 3] = 255;
  }
}

describe("bounded SIMD RGB", () => {
  test("matches JS bytes across unusual ranges, random Float32 values, rounding edges and non-finite pixels", async () => {
    const kernel = await createRgbSimdKernel(bytes);
    let random = 1234;
    const next = () => { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; return random >>> 0; };
    for (let trial = 0; trial < 64; trial++) {
      const w = 131, h = 67;
      const rasters = [0, 1, 2].map(() => {
        const bits = Uint32Array.from({ length: w * h }, () => next()), dataF32 = new Float32Array(bits.buffer);
        dataF32.set([NaN, Infinity, -Infinity, -0, 0, 0.5, 255, 256]);
        for (let i = 16; i < 300; i++) dataF32[i] = (i % 256 + 0.5) / 255;
        return { dataF32, w, h };
      });
      const params = [0, 1, 2].map(() => ({ minVal: 0, maxVal: 1, brightness: 0, gain: 1, contrast: 1 }));
      if (trial % 4 === 1) params[1].maxVal = 0;
      if (trial % 4 === 2) Object.assign(params[2], { minVal: 230, maxVal: -100, brightness: -0.3, gain: -2, contrast: 3 });
      if (trial >= 16) params.forEach(t => Object.assign(t, { minVal: (next() % 10000 - 5000) / 17,
        maxVal: (next() % 10000 - 5000) / 17, brightness: (next() % 2000 - 1000) / 199,
        gain: (next() % 2000 - 1000) / 399, contrast: (next() % 2000 - 1000) / 299 }));
      if (trial >= 56) Object.assign(params[trial % 3], [
        { minVal: Infinity }, { maxVal: -Infinity }, { contrast: Infinity }, { brightness: -Infinity },
        { gain: Infinity }, { minVal: NaN }, { maxVal: NaN }, { contrast: NaN }
      ][trial - 56]);
      const rect = trial % 2 ? { x: 3, y: 1, w: 125, h: 65 } : { x: 0, y: 0, w, h };
      const ordered = trial % 3 ? rasters : [...rasters].reverse();
      for (const transparent of [false, true]) {
        const expected = new Uint8ClampedArray(w * h * 4).fill(73), actual = expected.slice();
        oracle(ordered, params, expected, w, rect, transparent);
        kernel.colorize(ordered, params, actual, w, rect, transparent);
        expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
      }
    }
    expect(kernel.stats.allocatedBytes).toBe(384 * 1024);
  });

  test("tiles both dimensions, preserves exterior bytes, and never grows scratch across sizes", async () => {
    const kernel = await createRgbSimdKernel(bytes);
    for (const [w, h] of [[257, 131], [16391, 5], [513, 259], [3, 3]]) {
      const rasters = [0, 1, 2].map(c => ({ dataF32: Float32Array.from({ length: w * h }, (_, i) => (i * 17 + c * 61) % 256) }));
      const params = [0, 1, 2].map(() => ({ minVal: 4, maxVal: 230, brightness: 0.03, gain: 1.1, contrast: 0.9 }));
      const rect = { x: 1, y: 1, w: w - 2, h: h - 2 };
      const expected = new Uint8ClampedArray(w * h * 4).fill(73), actual = expected.slice();
      oracle(rasters, params, expected, w, rect, true);
      kernel.colorize(rasters, params, actual, w, rect, true);
      expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
      expect(kernel.stats.allocatedBytes).toBe(384 * 1024);
    }
    const { instance } = await WebAssembly.instantiate(bytes);
    expect(instance.exports.rgb_color(16385, 1, 0)).toBe(-1);
    expect(instance.exports.rgb_color(1, 16385, 0)).toBe(-1);
    expect(() => instance.exports.memory.grow(1)).toThrow();
  });

  test("unsupported SIMD, blocked loading and compile failures select JS fallback", async () => {
    expect(await loadRgbSimdKernel({ fetchBytes: async () => { throw new Error("blocked"); } })).toBeNull();
    expect(await loadRgbSimdKernel({ fetchBytes: async () => bytes, create: async () => { throw new WebAssembly.CompileError("SIMD unavailable"); } })).toBeNull();
    expect(await loadRgbSimdKernel({ fetchBytes: async () => bytes })).toMatchObject({ stats: { backend: "simd", allocatedBytes: 393216 } });
  });
});
