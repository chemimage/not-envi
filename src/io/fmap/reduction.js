// One compact accumulator per runnable job. The C span result is shared only
// synchronously; neither it nor a resident-page view is retained across yields.
export const REDUCTION_VALUES = 261;
export const REDUCTION_BYTES = REDUCTION_VALUES * Float64Array.BYTES_PER_ELEMENT;

export function createReduction(message, exports) {
  const bins = message.bins ?? 0;
  if (!Number.isInteger(bins) || bins < 0 || bins > 256) throw new RangeError("Invalid reduction bins.");
  const mask = message.mask;
  if (mask && (!(mask instanceof Uint8Array) || mask.length !== message.requestedW * message.requestedH)) {
    throw new RangeError("Invalid reduction mask.");
  }
  const values = new Float64Array(REDUCTION_VALUES);
  values[0] = Infinity; values[1] = -Infinity;
  const js = message.reductionBackend === "js";
  function consume(slot, offset, count, stride, spec, targetOffset, validBytes = null) {
    // Experimental placement-matched control for the checked benchmark. The
    // same lease planner feeds this JS loop and the C kernel; UI uses C only.
    if (js) {
      if (![1, 4].includes(spec.dataType)) throw new Error("The JS reduction control supports uint8/Float32 only.");
      const ptr = validBytes === null ? exports.fmap_slot_ptr(slot) : exports.fmap_scratch_ptr();
      const view = new DataView(exports.memory.buffer, ptr);
      const scale = bins ? (bins - 1) / (message.max - message.min) : 0;
      for (let i = 0; i < count; i += 1) {
        if (mask && !mask[targetOffset + i]) continue;
        const at = offset + i * stride;
        const value = spec.dataType === 1 ? view.getUint8(at) : view.getFloat32(at, message.littleEndian);
        if (!Number.isFinite(value)) continue;
        values[0] = Math.min(values[0], value); values[1] = Math.max(values[1], value);
        values[2] += 1; values[3] += value; values[4] += value * value;
        if (bins) {
          const bin = Math.floor((value - message.min) * scale);
          if (!Number.isNaN(bin)) values[5 + Math.max(0, Math.min(bins - 1, bin))] += 1;
        }
      }
      return;
    }
    for (let start = 0; start < count;) {
      if (mask && !mask[targetOffset + start]) { start += 1; continue; }
      let end = start + 1;
      if (mask) while (end < count && mask[targetOffset + end]) end += 1;
      else end = count;
      const args = [offset + start * stride, end - start, stride, spec.dataType,
        message.littleEndian ? 1 : 0, 1, bins, message.min ?? 0, message.max ?? 1];
      const result = validBytes === null
        ? exports.fmap_reduce_numeric(slot, ...args)
        : exports.fmap_reduce_scratch_numeric(...args, validBytes);
      if (result !== end - start) throw new Error(`fmap reduction failed (status ${result}).`);
      const span = new Float64Array(exports.memory.buffer, exports.fmap_reduction_ptr(), REDUCTION_VALUES);
      values[0] = Math.min(values[0], span[0]); values[1] = Math.max(values[1], span[1]);
      for (let i = 2; i < 5 + bins; i += 1) values[i] += span[i];
      start = end;
    }
  }
  return { reduction: true, values, consume };
}
