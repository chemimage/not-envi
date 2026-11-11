/* global FileReaderSync */
const PROTOCOL_VERSION = 1;
const state = {
  file: null,
  meta: null,
  generation: 0,
  pageSize: 0,
  slotCount: 0,
  exports: null,
  stats: null,
  closed: true
};

function resetStats() {
  state.stats = {
    requestedBytes: 0,
    browserBytes: 0,
    copiedBytes: 0,
    usefulValues: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheEvictions: 0
  };
}

function safeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new RangeError(`${label} must be a non-negative safe integer.`);
  return number;
}

function workerError(error) {
  return {
    name: String(error?.name || "Error"),
    message: String(error?.message || error || "fmap worker failed")
  };
}

function requireGeneration(generation) {
  if (state.closed || !state.file) throw new Error("fmap source is closed.");
  if (Number(generation) !== state.generation) {
    const error = new Error("Stale fmap request.");
    error.name = "AbortError";
    throw error;
  }
}

function callExport(name, ...args) {
  const fn = state.exports?.[name];
  if (typeof fn !== "function") throw new Error(`fmap WASM export ${name} is unavailable.`);
  return fn(...args);
}

function slotPointer(slot) {
  const pointer = Number(callExport("fmap_slot_ptr", slot));
  if (!Number.isSafeInteger(pointer) || pointer < 0) throw new Error("fmap WASM returned an invalid slot pointer.");
  return pointer;
}

function pageArgument(pageIndex) {
  return BigInt(safeInteger(pageIndex, "page index"));
}

function releaseSlot(slot) {
  callExport("fmap_release_page", slot);
}

function loadPage(pageIndex, generation) {
  requireGeneration(generation);
  const page = pageArgument(pageIndex);
  const slot = Number(callExport("fmap_acquire_page", page));
  if (slot === -2) throw new Error("fmap resident pool is exhausted because every slot is pinned.");
  if (slot < 0) throw new Error(`fmap WASM could not acquire page ${pageIndex} (status ${slot}).`);
  const valid = Number(callExport("fmap_slot_valid_bytes", slot));
  if (valid > 0) {
    callExport("fmap_touch_page", slot);
    state.stats.cacheHits = Number(callExport("fmap_hits"));
    state.stats.cacheMisses = Number(callExport("fmap_misses"));
    state.stats.cacheEvictions = Number(callExport("fmap_evictions"));
    return slot;
  }

  const offset = pageIndex * state.pageSize;
  const stop = Math.min(state.file.size, offset + state.pageSize);
  const reader = new FileReaderSync();
  const buffer = reader.readAsArrayBuffer(state.file.slice(offset, stop));
  requireGeneration(generation);
  const bytes = new Uint8Array(buffer);
  const pointer = slotPointer(slot);
  const resident = new Uint8Array(state.exports.memory.buffer, pointer, state.pageSize);
  resident.fill(0);
  resident.set(bytes);
  const commitStatus = Number(callExport("fmap_commit_page", slot, bytes.byteLength));
  if (commitStatus !== 0) {
    releaseSlot(slot);
    throw new Error(`fmap WASM could not commit page ${pageIndex} (status ${commitStatus}).`);
  }
  state.stats.browserBytes += bytes.byteLength;
  state.stats.copiedBytes += bytes.byteLength;
  state.stats.cacheHits = Number(callExport("fmap_hits"));
  state.stats.cacheMisses = Number(callExport("fmap_misses"));
  state.stats.cacheEvictions = Number(callExport("fmap_evictions"));
  return slot;
}

function readExact(offsetRaw, lengthRaw, generation) {
  const offset = safeInteger(offsetRaw, "read offset");
  const length = safeInteger(lengthRaw, "read length");
  const end = offset + length;
  if (!Number.isSafeInteger(end)) throw new RangeError("Read range exceeds the browser's exact integer range.");
  state.stats.requestedBytes += length;
  if (end > state.file.size) throw new Error(`Truncated file read at ${offset}: requested ${length} bytes, file size is ${state.file.size}.`);
  const output = new Uint8Array(length);
  let written = 0;
  while (written < length) {
    requireGeneration(generation);
    const absolute = offset + written;
    const pageIndex = Math.floor(absolute / state.pageSize);
    const inPage = absolute - (pageIndex * state.pageSize);
    const slot = loadPage(pageIndex, generation);
    try {
      const valid = Number(callExport("fmap_slot_valid_bytes", slot));
      const take = Math.min(length - written, valid - inPage);
      if (take <= 0) throw new Error(`Truncated fmap page at file offset ${absolute}.`);
      const pointer = slotPointer(slot);
      output.set(new Uint8Array(state.exports.memory.buffer, pointer + inPage, take), written);
      written += take;
      state.stats.copiedBytes += take;
    } finally {
      releaseSlot(slot);
    }
  }
  return output;
}

function pixelOffset(meta, x, y, band) {
  const plane = meta.samples * meta.lines;
  const valueIndex = (band * plane) + (y * meta.samples) + x;
  const offset = meta.headerOffset + (valueIndex * 4);
  if (!Number.isSafeInteger(offset)) throw new RangeError("ENVI pixel offset exceeds the browser's exact integer range.");
  return offset;
}

function extractFloat32Le(offsetRaw, countRaw, strideBytesRaw, generation, target, targetOffset = 0) {
  let offset = safeInteger(offsetRaw, "Float32 offset");
  let remaining = safeInteger(countRaw, "Float32 count");
  const strideBytes = safeInteger(strideBytesRaw, "Float32 stride");
  if (strideBytes < 4) throw new RangeError("Float32 stride must be at least four bytes.");
  while (remaining > 0) {
    requireGeneration(generation);
    const pageIndex = Math.floor(offset / state.pageSize);
    const inPage = offset - (pageIndex * state.pageSize);
    if ((state.pageSize - inPage) < 4) {
      const bytes = readExact(offset, 4, generation);
      state.stats.requestedBytes -= 4;
      target[targetOffset] = new DataView(bytes.buffer, bytes.byteOffset, 4).getFloat32(0, true);
      targetOffset += 1;
      remaining -= 1;
      offset += strideBytes;
      continue;
    }
    const slot = loadPage(pageIndex, generation);
    try {
      const valid = Number(callExport("fmap_slot_valid_bytes", slot));
      const available = valid - inPage;
      const take = available >= 4 ? Math.min(remaining, Math.floor((available - 4) / strideBytes) + 1) : 0;
      if (take <= 0) throw new Error(`Truncated Float32 sample at file offset ${offset}.`);
      const extracted = Number(callExport("fmap_extract_f32_le", slot, inPage, take, strideBytes));
      if (extracted !== take) throw new Error(`fmap WASM Float32 extraction failed with status ${extracted}.`);
      const outputPointer = Number(callExport("fmap_output_ptr"));
      const values = new Float32Array(state.exports.memory.buffer, outputPointer, take);
      target.set(values, targetOffset);
      targetOffset += take;
      remaining -= take;
      offset += take * strideBytes;
      state.stats.copiedBytes += take * 4;
    } finally {
      releaseSlot(slot);
    }
  }
}

function readBandWindow(message) {
  requireGeneration(message.generation);
  const { meta } = state;
  const { x0, y0, outW, outH, requestedW, requestedH, step, band } = message;
  if (!Number.isInteger(band) || band < 0 || band >= meta.bands) throw new RangeError("Invalid ENVI band index.");
  const output = new Float32Array(requestedW * requestedH);
  const little = !!meta.littleEndian;
  const rowBytes = outW > 0 ? (((outW - 1) * step) + 1) * 4 : 0;
  for (let row = 0; row < outH; row += 1) {
    const offset = pixelOffset(meta, x0, y0 + (row * step), band);
    const base = row * requestedW;
    state.stats.requestedBytes += rowBytes;
    if (little) {
      extractFloat32Le(offset, outW, step * 4, message.generation, output, base);
    } else {
      const bytes = readExact(offset, rowBytes, message.generation);
      // readExact already records requested bytes; avoid double counting this fallback.
      state.stats.requestedBytes -= rowBytes;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let column = 0; column < outW; column += 1) {
        output[base + column] = view.getFloat32(column * step * 4, false);
      }
    }
  }
  state.stats.usefulValues += outW * outH;
  return output;
}

function readSpectrum(message) {
  requireGeneration(message.generation);
  const { meta } = state;
  const x = Number(message.x);
  const y = Number(message.y);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= meta.samples || y >= meta.lines) {
    throw new RangeError("Spectrum coordinate is outside the dataset.");
  }
  const output = new Float32Array(meta.bands);
  for (let band = 0; band < meta.bands; band += 1) {
    const offset = pixelOffset(meta, x, y, band);
    if (meta.littleEndian) {
      state.stats.requestedBytes += 4;
      extractFloat32Le(offset, 1, 4, message.generation, output, band);
    } else {
      const bytes = readExact(offset, 4, message.generation);
      output[band] = new DataView(bytes.buffer, bytes.byteOffset, 4).getFloat32(0, false);
    }
  }
  state.stats.usefulValues += meta.bands;
  return output;
}

async function openSource(message) {
  if (message.protocolVersion !== PROTOCOL_VERSION) throw new Error("Unsupported fmap worker protocol.");
  if (!(message.file instanceof Blob)) throw new Error("fmap requires a user-selected File or Blob.");
  if (!(message.wasmBytes instanceof ArrayBuffer)) throw new Error("fmap WASM artifact is unavailable.");
  const pageSize = safeInteger(message.pageSize, "page size");
  const poolBytes = safeInteger(message.poolBytes, "pool size");
  if (pageSize <= 0 || poolBytes < pageSize) throw new Error("fmap pool must contain at least one page.");
  const slotCount = Math.floor(poolBytes / pageSize);
  const result = await WebAssembly.instantiate(message.wasmBytes, {});
  const exports = result.instance?.exports || result.exports;
  if (!(exports?.memory instanceof WebAssembly.Memory)) throw new Error("fmap WASM memory export is unavailable.");
  state.file = message.file;
  state.meta = message.meta;
  state.generation = Number(message.generation);
  state.pageSize = pageSize;
  state.slotCount = slotCount;
  state.exports = exports;
  state.closed = false;
  resetStats();
  const status = Number(callExport("fmap_init", pageSize, slotCount));
  if (status !== 0) throw new Error(`fmap WASM initialization failed with status ${status}.`);
  return { slotCount, residentBytes: slotCount * pageSize };
}

self.onmessage = async (event) => {
  const message = event?.data || {};
  const id = Number(message.id);
  if (!Number.isFinite(id)) return;
  try {
    let result = null;
    let transfer = [];
    if (message.type === "open") {
      result = await openSource(message);
    } else if (message.type === "window") {
      const output = readBandWindow(message);
      result = { buffer: output.buffer, stats: { ...state.stats } };
      transfer = [output.buffer];
    } else if (message.type === "spectrum") {
      const output = readSpectrum(message);
      result = { buffer: output.buffer, stats: { ...state.stats } };
      transfer = [output.buffer];
    } else if (message.type === "stats") {
      requireGeneration(message.generation);
      result = { ...state.stats };
    } else if (message.type === "clear") {
      state.generation = Number(message.generation);
      callExport("fmap_reset");
      result = true;
    } else if (message.type === "close") {
      state.generation = Number(message.generation);
      state.file = null;
      state.meta = null;
      state.closed = true;
      result = true;
    } else {
      throw new Error(`Unknown fmap worker request: ${String(message.type)}`);
    }
    self.postMessage({ id, generation: state.generation, result }, transfer);
  } catch (error) {
    self.postMessage({ id, generation: Number(message.generation), error: workerError(error) });
  }
};
