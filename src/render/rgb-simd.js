/** Independent display kernel. Fixed 16,384-pixel scratch replaces the
 * prototype's full-frame WASM mirrors. No page-pool pointers or growing memory;
 * renderer/worker planes and the retained ImageData keep their existing owners.
 * Each call is synchronous, so no scratch pointer crosses an await. */
export async function createRgbSimdKernel(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes);
  const api = instance.exports, memory = api.memory;
  const capacity = api.rgb_capacity();
  const inputs = [0, 1, 2].map(channel => new Float32Array(memory.buffer, api.rgb_input(channel), capacity));
  const output = new Uint8ClampedArray(memory.buffer, api.rgb_output(), capacity * 4);
  const tones = new Float64Array(memory.buffer, api.rgb_tones(), 15);
  const stats = { backend: "simd", allocatedBytes: memory.buffer.byteLength, stagedBytes: 0, outputBytes: 0, coloredPixels: 0 };

  function colorize(rasters, params, dst, width, rect, transparent) {
    for (let c = 0; c < 3; c++) {
      const p = params[c];
      tones.set([p.minVal, p.maxVal, p.brightness, p.gain, p.contrast], c * 5);
    }
    for (let x = rect.x; x < rect.x + rect.w; x += capacity) {
      const bw = Math.min(capacity, rect.x + rect.w - x);
      const rows = Math.max(1, Math.floor(capacity / bw));
      for (let y = rect.y; y < rect.y + rect.h; y += rows) {
        const bh = Math.min(rows, rect.y + rect.h - y);
        for (let c = 0; c < 3; c++) for (let row = 0; row < bh; row++) {
          const start = (y + row) * width + x;
          inputs[c].set(rasters[c].dataF32.subarray(start, start + bw), row * bw);
        }
        if (api.rgb_color(bw, bh, Number(transparent)) !== 0) throw new Error("RGB scratch bounds rejected.");
        for (let row = 0; row < bh; row++) dst.set(output.subarray(row * bw * 4, (row + 1) * bw * 4), ((y + row) * width + x) * 4);
        stats.stagedBytes += bw * bh * 12; stats.outputBytes += bw * bh * 4; stats.coloredPixels += bw * bh;
      }
    }
  }
  return { colorize, stats };
}
