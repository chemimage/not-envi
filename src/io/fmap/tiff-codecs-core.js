import { Inflate } from "pako";

const TIFF_COMPRESSION_NONE = 1;
const TIFF_COMPRESSION_LZW = 5;
const TIFF_COMPRESSION_DEFLATE = 8;
const TIFF_COMPRESSION_DEFLATE_OLD = 32946;
const TIFF_COMPRESSION_PACKBITS = 32773;
const LZW_CLEAR = 256;
const LZW_EOI = 257;
const LZW_TABLE_SIZE = 4096;
const DEFLATE_CHUNK_BYTES = 64 * 1024;
const DEFLATE_WINDOW_BYTES = 32 * 1024;

function abortError() {
  const error = new Error("TIFF block decode aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfCancelled(options) {
  if (options?.signal?.aborted || options?.cancelled?.()) throw abortError();
}

function safeExpectedBytes(value) {
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new RangeError("TIFF decoded byte count must be a non-negative safe integer.");
  }
  return bytes;
}

function inputBytes(buffer) {
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  if (ArrayBuffer.isView(buffer)) return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  throw new TypeError("TIFF codec input must be an ArrayBuffer or typed-array view.");
}

function compressionOf(fileDirectory) {
  return Number(fileDirectory?.Compression ?? fileDirectory?.compression ?? TIFF_COMPRESSION_NONE) || TIFF_COMPRESSION_NONE;
}

function overflowError(expected) {
  return new Error(`TIFF decoder exceeded its ${expected}-byte output reservation.`);
}

function exactLength(output, written, expected) {
  if (written !== expected) {
    throw new Error(`TIFF decoder produced ${written} bytes; expected exactly ${expected}.`);
  }
  return output.buffer;
}

function numericArray(value, fallback = []) {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return Array.from(value, Number);
  return value == null ? fallback : [Number(value)];
}

function predictorLayout(fileDirectory, expected, options) {
  const predictor = Number(fileDirectory?.Predictor ?? fileDirectory?.predictor ?? 1) || 1;
  if (predictor === 1) return { predictor };
  if (predictor !== 2 && predictor !== 3) {
    throw new Error(`Unsupported TIFF predictor ${predictor}.`);
  }
  const bits = numericArray(fileDirectory?.BitsPerSample ?? fileDirectory?.bitsPerSample);
  if (bits.length === 0 || bits.some((value) => !Number.isInteger(value) || value <= 0 || value % 8 !== 0)) {
    throw new Error("TIFF predictors require byte-aligned BitsPerSample values.");
  }
  if (bits.some((value) => value !== bits[0])) {
    throw new Error("TIFF predictors require equal BitsPerSample values.");
  }
  const bytesPerSample = bits[0] / 8;
  if (predictor === 2 && ![1, 2, 4].includes(bytesPerSample)) {
    throw new Error(`TIFF Predictor 2 does not support ${bits[0]}-bit samples.`);
  }
  if (predictor === 3 && ![2, 3, 4, 8].includes(bytesPerSample)) {
    throw new Error(`TIFF Predictor 3 does not support ${bits[0]}-bit samples.`);
  }
  const planar = Number(fileDirectory?.PlanarConfiguration ?? fileDirectory?.planarConfiguration ?? 1) || 1;
  if (planar !== 1 && planar !== 2) throw new Error(`Unsupported TIFF PlanarConfiguration ${planar}.`);
  const samples = Number(fileDirectory?.SamplesPerPixel ?? fileDirectory?.samplesPerPixel ?? bits.length) || bits.length;
  if (!Number.isSafeInteger(samples) || samples <= 0) throw new Error("Invalid TIFF SamplesPerPixel value.");
  const stride = planar === 2 ? 1 : samples;
  const width = Number(fileDirectory?.TileWidth
    ?? fileDirectory?.tileWidth
    ?? fileDirectory?.ImageWidth
    ?? fileDirectory?.imageWidth);
  if (!Number.isSafeInteger(width) || width <= 0) throw new Error("TIFF predictor requires a positive tile or image width.");
  const rowBytes = width * stride * bytesPerSample;
  if (!Number.isSafeInteger(rowBytes) || rowBytes <= 0) throw new Error("TIFF predictor row size is unsafe.");
  if (expected % rowBytes !== 0) {
    throw new Error(`TIFF predictor block length ${expected} is not a whole number of ${rowBytes}-byte rows.`);
  }
  let littleEndian = options?.littleEndian;
  if (littleEndian == null) littleEndian = fileDirectory?.LittleEndian ?? fileDirectory?.littleEndian;
  if (bytesPerSample > 1 && typeof littleEndian !== "boolean") {
    throw new Error("TIFF predictor byte order must be supplied as options.littleEndian.");
  }
  return {
    predictor,
    bytesPerSample,
    stride,
    rowBytes,
    rows: expected / rowBytes,
    littleEndian: littleEndian !== false
  };
}

function addPredictorValue(view, currentOffset, previousOffset, bytesPerSample, littleEndian) {
  switch (bytesPerSample) {
    case 1:
      view.setUint8(currentOffset, view.getUint8(currentOffset) + view.getUint8(previousOffset));
      break;
    case 2:
      view.setUint16(
        currentOffset,
        view.getUint16(currentOffset, littleEndian) + view.getUint16(previousOffset, littleEndian),
        littleEndian
      );
      break;
    case 4:
      view.setUint32(
        currentOffset,
        view.getUint32(currentOffset, littleEndian) + view.getUint32(previousOffset, littleEndian),
        littleEndian
      );
      break;
    default:
      throw new Error(`Unsupported TIFF Predictor 2 sample width ${bytesPerSample}.`);
  }
}

function applyHorizontalPredictor(output, layout, options) {
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  const sampleStride = layout.stride * layout.bytesPerSample;
  for (let row = 0; row < layout.rows; row += 1) {
    const rowStart = row * layout.rowBytes;
    const rowEnd = rowStart + layout.rowBytes;
    for (let offset = rowStart + sampleStride; offset < rowEnd; offset += layout.bytesPerSample) {
      if ((offset & 0x3fff) === 0) throwIfCancelled(options);
      addPredictorValue(view, offset, offset - sampleStride, layout.bytesPerSample, layout.littleEndian);
    }
  }
}

function applyFloatingPointPredictor(output, layout, options) {
  const { bytesPerSample, rowBytes, rows, stride, littleEndian } = layout;
  const samplesPerRow = rowBytes / bytesPerSample;
  const planeStride = stride;
  const copy = new Uint8Array(rowBytes);
  for (let row = 0; row < rows; row += 1) {
    throwIfCancelled(options);
    const rowStart = row * rowBytes;
    const rowView = output.subarray(rowStart, rowStart + rowBytes);
    for (let offset = planeStride; offset < rowBytes; offset += 1) {
      rowView[offset] = (rowView[offset] + rowView[offset - planeStride]) & 0xff;
    }
    copy.set(rowView);
    for (let sample = 0; sample < samplesPerRow; sample += 1) {
      for (let byte = 0; byte < bytesPerSample; byte += 1) {
        const plane = littleEndian ? bytesPerSample - byte - 1 : byte;
        rowView[(sample * bytesPerSample) + byte] = copy[(plane * samplesPerRow) + sample];
      }
    }
  }
}

function applyPredictor(outputBuffer, fileDirectory, options) {
  const output = new Uint8Array(outputBuffer);
  const layout = predictorLayout(fileDirectory, output.byteLength, options);
  if (layout.predictor === 2) applyHorizontalPredictor(output, layout, options);
  else if (layout.predictor === 3) applyFloatingPointPredictor(output, layout, options);
  return outputBuffer;
}

function decodeNone(input, expected, options) {
  throwIfCancelled(options);
  if (input.byteLength !== expected) {
    throw new Error(`Uncompressed TIFF block has ${input.byteLength} bytes; expected exactly ${expected}.`);
  }
  const output = new Uint8Array(expected);
  output.set(input);
  return output.buffer;
}

function decodePackBits(input, expected, options) {
  const output = new Uint8Array(expected);
  let source = 0;
  let written = 0;
  while (source < input.byteLength) {
    if ((source & 0x3fff) === 0) throwIfCancelled(options);
    const header = input[source++] << 24 >> 24;
    if (header === -128) continue;
    if (header >= 0) {
      const count = header + 1;
      if (source + count > input.byteLength) throw new Error("Truncated PackBits literal run.");
      if (written + count > expected) throw overflowError(expected);
      output.set(input.subarray(source, source + count), written);
      source += count;
      written += count;
    } else {
      const count = 1 - header;
      if (source >= input.byteLength) throw new Error("Truncated PackBits repeat run.");
      if (written + count > expected) throw overflowError(expected);
      output.fill(input[source++], written, written + count);
      written += count;
    }
  }
  return exactLength(output, written, expected);
}

class MsbBitReader {
  constructor(input) {
    this.input = input;
    this.bitOffset = 0;
  }

  read(width) {
    if (this.bitOffset + width > this.input.byteLength * 8) return null;
    let value = 0;
    for (let index = 0; index < width; index += 1) {
      const absolute = this.bitOffset + index;
      value = (value << 1) | ((this.input[absolute >> 3] >> (7 - (absolute & 7))) & 1);
    }
    this.bitOffset += width;
    return value;
  }
}

function decodeLzw(input, expected, options) {
  const output = new Uint8Array(expected);
  const prefix = new Uint16Array(LZW_TABLE_SIZE);
  const suffix = new Uint8Array(LZW_TABLE_SIZE);
  const stack = new Uint8Array(LZW_TABLE_SIZE);
  const reader = new MsbBitReader(input);
  let nextCode = 258;
  let codeWidth = 9;
  let oldCode = -1;
  let written = 0;
  let sawEoi = false;
  let iterations = 0;

  const reset = () => {
    nextCode = 258;
    codeWidth = 9;
    oldCode = -1;
  };
  const writeByte = (value) => {
    if (written >= expected) throw overflowError(expected);
    output[written++] = value;
  };
  const emit = (code) => {
    let depth = 0;
    let cursor = code;
    while (cursor >= 256) {
      if (cursor >= nextCode || depth >= stack.length) throw new Error(`Invalid TIFF LZW dictionary code ${cursor}.`);
      stack[depth++] = suffix[cursor];
      cursor = prefix[cursor];
    }
    if (cursor < 0 || cursor > 255 || depth >= stack.length) throw new Error(`Invalid TIFF LZW literal ${cursor}.`);
    stack[depth++] = cursor;
    const first = stack[depth - 1];
    while (depth > 0) writeByte(stack[--depth]);
    return first;
  };

  reset();
  while (true) {
    if ((iterations++ & 0x3ff) === 0) throwIfCancelled(options);
    const code = reader.read(codeWidth);
    if (code == null) break;
    if (code === LZW_CLEAR) {
      reset();
      continue;
    }
    if (code === LZW_EOI) {
      sawEoi = true;
      break;
    }
    if (oldCode < 0) {
      if (code > 255) throw new Error(`Invalid first TIFF LZW code ${code}.`);
      writeByte(code);
      oldCode = code;
      continue;
    }

    const current = code;
    let first;
    if (code < nextCode) {
      first = emit(code);
    } else if (code === nextCode) {
      first = emit(oldCode);
      writeByte(first);
    } else {
      throw new Error(`Invalid TIFF LZW code ${code}; next dictionary code is ${nextCode}.`);
    }

    if (nextCode < LZW_TABLE_SIZE) {
      prefix[nextCode] = oldCode;
      suffix[nextCode] = first;
      nextCode += 1;
      if (nextCode + 1 >= 2 ** codeWidth && codeWidth < 12) codeWidth += 1;
    }
    oldCode = current;
  }
  if (!sawEoi) throw new Error("TIFF LZW block ended before its EOI code.");
  throwIfCancelled(options);
  return exactLength(output, written, expected);
}

function decodeDeflate(input, expected, options) {
  const output = new Uint8Array(expected);
  let written = 0;
  let callbackError = null;
  const inflator = new Inflate({ chunkSize: DEFLATE_CHUNK_BYTES });
  inflator.onData = (chunk) => {
    try {
      throwIfCancelled(options);
      if (written + chunk.byteLength > expected) throw overflowError(expected);
      output.set(chunk, written);
      written += chunk.byteLength;
    } catch (error) {
      callbackError = error;
      throw error;
    }
  };
  try {
    inflator.push(input, true);
  } catch (error) {
    throw callbackError || error;
  }
  if (callbackError) throw callbackError;
  if (inflator.err) throw new Error(`Invalid TIFF Deflate block: ${inflator.msg || `status ${inflator.err}`}.`);
  throwIfCancelled(options);
  return exactLength(output, written, expected);
}

export function estimateBoundedTiffScratchBytes(fileDirectory) {
  let bytes;
  switch (compressionOf(fileDirectory)) {
    case TIFF_COMPRESSION_NONE:
    case TIFF_COMPRESSION_PACKBITS:
      bytes = 0;
      break;
    case TIFF_COMPRESSION_LZW:
      bytes = LZW_TABLE_SIZE * 4;
      break;
    case TIFF_COMPRESSION_DEFLATE:
    case TIFF_COMPRESSION_DEFLATE_OLD:
      bytes = DEFLATE_CHUNK_BYTES + DEFLATE_WINDOW_BYTES;
      break;
    default:
      throw new Error(`Unsupported bounded TIFF compression ${compressionOf(fileDirectory)}.`);
  }
  const predictor = Number(fileDirectory?.Predictor ?? fileDirectory?.predictor ?? 1) || 1;
  if (predictor === 3) {
    const bits = numericArray(fileDirectory?.BitsPerSample ?? fileDirectory?.bitsPerSample);
    const planar = Number(fileDirectory?.PlanarConfiguration ?? fileDirectory?.planarConfiguration ?? 1) || 1;
    const samples = Number(fileDirectory?.SamplesPerPixel ?? fileDirectory?.samplesPerPixel ?? bits.length) || bits.length;
    const width = Number(fileDirectory?.TileWidth
      ?? fileDirectory?.tileWidth
      ?? fileDirectory?.ImageWidth
      ?? fileDirectory?.imageWidth);
    const bytesPerSample = Number(bits[0]) / 8;
    const rowBytes = width * (planar === 2 ? 1 : samples) * bytesPerSample;
    if (!Number.isSafeInteger(rowBytes) || rowBytes <= 0) {
      throw new Error("Cannot estimate TIFF Predictor 3 row scratch from unsafe metadata.");
    }
    bytes += rowBytes;
  }
  if (!Number.isSafeInteger(bytes)) throw new Error("TIFF codec scratch estimate is unsafe.");
  return bytes;
}

export function decodeBoundedTiffBlockDirect(fileDirectory, buffer, expectedBytes, options = {}) {
  const expected = safeExpectedBytes(expectedBytes);
  const input = inputBytes(buffer);
  let decoded;
  switch (compressionOf(fileDirectory)) {
    case TIFF_COMPRESSION_NONE: decoded = decodeNone(input, expected, options); break;
    case TIFF_COMPRESSION_LZW: decoded = decodeLzw(input, expected, options); break;
    case TIFF_COMPRESSION_DEFLATE:
    case TIFF_COMPRESSION_DEFLATE_OLD: decoded = decodeDeflate(input, expected, options); break;
    case TIFF_COMPRESSION_PACKBITS: decoded = decodePackBits(input, expected, options); break;
    default: throw new Error(`Unsupported bounded TIFF compression ${compressionOf(fileDirectory)}.`);
  }
  throwIfCancelled(options);
  return applyPredictor(decoded, fileDirectory, options);
}
