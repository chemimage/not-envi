export async function createWasmKernel(bytes, name) {
  const { instance } = await WebAssembly.instantiate(bytes);
  const { memory } = instance.exports;
  let count = 0, data, output, tones, ids = [], revisions = [], offsets;
  let stagedBytes = 0, copiedOutputBytes = 0;
  function colorize(rasters, params, dst, width, rect, transparent) {
    const n = rasters[0].w * rasters[0].h;
    if (n !== count) {
      count = n;
      const base = (Number(instance.exports.__heap_base.value) + 15) & ~15;
      offsets = [base, base + n * 4, base + n * 8, base + n * 12, base + n * 16];
      const required = offsets[4] + 120;
      if (memory.buffer.byteLength < required) memory.grow(Math.ceil((required - memory.buffer.byteLength) / 65536));
      data = [0, 1, 2].map(c => new Float32Array(memory.buffer, offsets[c], n));
      output = new Uint8ClampedArray(memory.buffer, offsets[3], n * 4);
      tones = new Float64Array(memory.buffer, offsets[4], 15);
      ids = []; revisions = [];
    }
    for (let c = 0; c < 3; c++) {
      const r = rasters[c], p = params[c];
      if (ids[c] !== r.compositionId || revisions[c] !== r.revision || !Number.isSafeInteger(r.revision)) {
        if (ids[c] === r.compositionId && revisions[c] === r.previousRevision) {
          for (const patch of r.dirtyRects) for (let y = patch.y; y < patch.y + patch.h; y++) {
            const start = y * width + patch.x;
            data[c].set(r.dataF32.subarray(start, start + patch.w), start); stagedBytes += patch.w * 4;
          }
        } else { data[c].set(r.dataF32); stagedBytes += n * 4; }
        ids[c] = r.compositionId; revisions[c] = r.revision;
      }
      tones.set([p.minVal, p.maxVal, p.brightness, p.gain, p.contrast], c * 5);
    }
    instance.exports[name](...offsets, width, rect.x, rect.y, rect.w, rect.h, Number(transparent));
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      const start = (y * width + rect.x) * 4;
      dst.set(output.subarray(start, start + rect.w * 4), start); copiedOutputBytes += rect.w * 4;
    }
  }
  return { colorize, stats: () => ({ allocatedWasmBytes: memory.buffer.byteLength, stagedBytes, copiedOutputBytes }) };
}
