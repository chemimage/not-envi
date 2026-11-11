export const FMAP_PROTOCOL_VERSION = 1;

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
  const headerOffset = assertSafeFileInteger(meta?.headerOffset || 0, "ENVI header offset");
  const samplesPerFile = samples * lines;
  if (!Number.isSafeInteger(samplesPerFile)) throw new RangeError("ENVI dimensions exceed the browser's exact integer range.");
  const values = samplesPerFile * bands;
  if (!Number.isSafeInteger(values)) throw new RangeError("ENVI dimensions exceed the browser's exact integer range.");
  const payload = values * bytes;
  if (!Number.isSafeInteger(payload)) throw new RangeError("ENVI payload exceeds the browser's exact integer range.");
  return checkedAdd(headerOffset, payload, "ENVI payload");
}

export function assertFmapBsqFloat32Meta(meta, fileSize) {
  if (meta?.interleave !== "bsq" || Number(meta?.dataType) !== 4 || Number(meta?.dataTypeInfo?.bytes) !== 4) {
    throw new Error("fmap currently supports BSQ Float32 ENVI data only.");
  }
  const expected = expectedEnviPayloadBytes(meta);
  const actual = assertSafeFileInteger(fileSize, "file size");
  if (actual < expected) {
    throw new Error(`Truncated ENVI data: expected at least ${expected} bytes, found ${actual}.`);
  }
  return expected;
}

export function normalizeFmapWindow(meta, x0, y0, outW, outH, step) {
  const samples = assertSafeFileInteger(meta?.samples, "ENVI samples");
  const lines = assertSafeFileInteger(meta?.lines, "ENVI lines");
  const x = Math.min(samples - 1, Math.max(0, Math.floor(Number(x0) || 0)));
  const y = Math.min(lines - 1, Math.max(0, Math.floor(Number(y0) || 0)));
  const stride = Math.max(1, Math.floor(Number(step) || 1));
  const requestedW = Math.max(0, Math.floor(Number(outW) || 0));
  const requestedH = Math.max(0, Math.floor(Number(outH) || 0));
  const width = Math.min(requestedW, Math.ceil((samples - x) / stride));
  const height = Math.min(requestedH, Math.ceil((lines - y) / stride));
  return { x0: x, y0: y, outW: width, outH: height, requestedW, requestedH, step: stride };
}

export function createAbortError(message = "fmap request aborted") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
