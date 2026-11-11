/**
 * Validate exact file ranges and result sizes before worker admission.
 * Worker messages carry source generation, request identity, priority, and
 * scalar window/probe fields. Completion transfers an owned numeric buffer;
 * cancellation callbacks and AbortSignal objects stay on the main thread.
 */
export const FMAP_PROTOCOL_VERSION = 1;

export const FMAP_ENVI_TYPE_BYTES = Object.freeze({
  1: 1,
  2: 2,
  3: 4,
  4: 4,
  5: 8,
  12: 2,
  13: 4,
  14: 8,
  15: 8
});

export function checkedResultBytes(width, height = 1, bytesPerValue = 4) {
  const w = assertSafeFileInteger(width, "result width");
  const h = assertSafeFileInteger(height, "result height");
  const elementBytes = assertSafeFileInteger(bytesPerValue, "result bytes per value");
  if (!elementBytes) throw new RangeError("result bytes per value must be positive.");
  const bytes = w * h * elementBytes;
  if (!Number.isSafeInteger(bytes)) throw new RangeError("fmap result exceeds the exact integer range.");
  return bytes;
}

export function assertSafeFileInteger(value, label = "file offset") {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
  return number;
}

export function checkedAdd(left, right, label = "file range") {
  const a = assertSafeFileInteger(left, `${label} start`);
  const b = assertSafeFileInteger(right, `${label} length`);
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) throw new RangeError(`${label} exceeds the browser's exact integer range.`);
  return sum;
}

export function expectedEnviPayloadBytes(meta) {
  const samples = assertSafeFileInteger(meta?.samples, "ENVI samples");
  const lines = assertSafeFileInteger(meta?.lines, "ENVI lines");
  const bands = assertSafeFileInteger(meta?.bands, "ENVI bands");
  const bytes = assertSafeFileInteger(meta?.dataTypeInfo?.bytes, "ENVI bytes per sample");
  if (!samples || !lines || !bands || !bytes) throw new RangeError("ENVI dimensions and sample size must be positive.");
  const headerOffset = assertSafeFileInteger(meta?.headerOffset || 0, "ENVI header offset");
  const samplesPerFile = samples * lines;
  if (!Number.isSafeInteger(samplesPerFile)) throw new RangeError("ENVI dimensions exceed the browser's exact integer range.");
  const values = samplesPerFile * bands;
  if (!Number.isSafeInteger(values)) throw new RangeError("ENVI dimensions exceed the browser's exact integer range.");
  const payload = values * bytes;
  if (!Number.isSafeInteger(payload)) throw new RangeError("ENVI payload exceeds the browser's exact integer range.");
  return checkedAdd(headerOffset, payload, "ENVI payload");
}

export function assertFmapEnviMeta(meta, fileSize) {
  const dataType = Number(meta?.dataType);
  const expectedBytes = FMAP_ENVI_TYPE_BYTES[dataType];
  const actualBytes = Number(meta?.dataTypeInfo?.bytes);
  if (!expectedBytes || actualBytes !== expectedBytes) throw new Error(`Unsupported fmap ENVI data type: ${dataType}.`);
  if (!["bsq", "bil", "bip"].includes(meta?.interleave)) throw new Error(`Unsupported fmap ENVI interleave: ${meta?.interleave}.`);
  const expected = expectedEnviPayloadBytes(meta);
  const actual = assertSafeFileInteger(fileSize, "file size");
  if (actual < expected) {
    throw new Error(`Truncated ENVI data: expected at least ${expected} bytes, found ${actual}.`);
  }
  return expected;
}

// Kept for callers compiled against the initial slice; validation now covers
// every ENVI type and interleave tracked by issue #23.
export const assertFmapBsqFloat32Meta = assertFmapEnviMeta;

export function normalizeFmapWindow(meta, x0, y0, outW, outH, step) {
  const samples = assertSafeFileInteger(meta?.samples, "ENVI samples");
  const lines = assertSafeFileInteger(meta?.lines, "ENVI lines");
  const x = Math.min(samples - 1, Math.max(0, Math.floor(Number(x0) || 0)));
  const y = Math.min(lines - 1, Math.max(0, Math.floor(Number(y0) || 0)));
  const stride = Math.max(1, assertSafeFileInteger(Math.floor(Number(step ?? 1)), "window step"));
  const requestedW = assertSafeFileInteger(Math.max(0, Math.floor(Number(outW))), "window width");
  const requestedH = assertSafeFileInteger(Math.max(0, Math.floor(Number(outH))), "window height");
  assertSafeFileInteger(x, "window x");
  assertSafeFileInteger(y, "window y");
  checkedResultBytes(requestedW, requestedH);
  const width = Math.min(requestedW, Math.ceil((samples - x) / stride));
  const height = Math.min(requestedH, Math.ceil((lines - y) / stride));
  return { x0: x, y0: y, outW: width, outH: height, requestedW, requestedH, step: stride };
}

export function createAbortError(message = "fmap request aborted") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
