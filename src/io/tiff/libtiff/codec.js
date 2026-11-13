import { callLibtiff, createLibtiffModule, libtiffResult } from "./runtime.js";

const MAX_BLOCK = 32 * 1024 * 1024;
export const LIBTIFF_SCRATCH_BYTES = 4 * 1024 * 1024;
const COMPRESSIONS = new Set([1, 5, 8, 32946, 32773]);

function aborted(options) {
  if (options?.signal?.aborted || options?.signals?.some((signal) => signal?.aborted) || options?.cancelled?.()) {
    throw Object.assign(new Error("TIFF decode aborted."), { name: "AbortError" });
  }
}

/** Include the private WASM input/output copies in the existing admission lease. */
export function estimateBoundedTiffScratchBytes(directory, decodedBytes = 0, encodedBytes = 0) {
  if (!COMPRESSIONS.has(Number(directory?.Compression || 1))) throw new Error("Unsupported bounded TIFF compression.");
  return LIBTIFF_SCRATCH_BYTES + decodedBytes * 2 + encodedBytes;
}

class CodecFile {
  constructor() { this.bytes = new Uint8Array(4096); this.size = 0; }
  read(offset, count) { return this.bytes.subarray(offset, Math.min(this.size, offset + count)); }
  write(offset, data) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + data.length > 65536) throw new Error("TIFF codec descriptor exceeds 64 KiB.");
    if (offset + data.length > this.bytes.length) {
      const grown = new Uint8Array(65536); grown.set(this.bytes); this.bytes = grown;
    }
    this.bytes.set(data, offset); this.size = Math.max(this.size, offset + data.length);
    return data.length;
  }
}

export async function decodeLibtiffBlock(directory, buffer, expectedBytes, options = {}) {
  aborted(options);
  const input = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > MAX_BLOCK || input.length > MAX_BLOCK) {
    throw new RangeError("TIFF block exceeds the bounded 32 MiB reservation.");
  }
  const compression = Number(directory.Compression || 1);
  if (!COMPRESSIONS.has(compression)) throw new Error(`Unsupported bounded TIFF compression ${compression}.`);
  const first = (value, fallback) => Number(Array.isArray(value) || ArrayBuffer.isView(value) ? value[0] : value) || fallback;
  const bits = first(directory.BitsPerSample, 8);
  const samples = Number(directory.PlanarConfiguration) === 2 ? 1 : first(directory.SamplesPerPixel, 1);
  const bytesPerPixel = bits / 8 * samples;
  const width = Number(directory.TileWidth || directory.ImageWidth) || expectedBytes / bytesPerPixel;
  const rows = expectedBytes / (width * bytesPerPixel);
  if (![8, 16, 32, 64].includes(bits) || !Number.isSafeInteger(width) || width < 1 || width > 0xffffffff
    || !Number.isSafeInteger(rows) || rows < 1 || rows > 0xffffffff || !Number.isSafeInteger(samples) || samples < 1 || samples > 4096) {
    throw new Error("Unsupported TIFF block sample geometry.");
  }
  const module = await createLibtiffModule(options.wasmModule);
  module.io = new CodecFile();
  let source = 0, output = 0;
  try {
    libtiffResult(module, await callLibtiff(module, "hyve_codec", [width, rows, bits, samples,
      first(directory.SampleFormat, 1), compression, first(directory.Predictor, 1), first(directory.FillOrder, 1), options.littleEndian === false ? 0 : 1]));
    aborted(options);
    source = module._malloc(input.length); output = module._malloc(expectedBytes);
    if (!source || !output) throw new Error("TIFF codec memory reservation failed.");
    module.HEAPU8.set(input, source);
    libtiffResult(module, module._hyve_decode(source, input.length, output, expectedBytes));
    if (module.HEAPU8.length > estimateBoundedTiffScratchBytes(directory, expectedBytes, input.length)) {
      throw new Error("TIFF codec heap exceeded its memory reservation.");
    }
    aborted(options);
    return module.HEAPU8.slice(output, output + expectedBytes).buffer;
  } finally {
    module._free(source); module._free(output); module._hyve_close();
  }
}
