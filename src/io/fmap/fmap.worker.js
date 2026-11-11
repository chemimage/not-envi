/* global FileReaderSync */
/**
 * File range bridge and cooperative ENVI processing for one source. BSQ, BIL,
 * and BIP planners feed all nine supported numeric types through bounded C
 * extraction. Dense windows reuse resident pages; cold sparse spans use
 * C-owned scratch without evicting viewport pages. File offsets stay exact
 * JavaScript integers at the Blob boundary and become u64 page IDs independently
 * of WASM pointers. See https://github.com/chemimage/Hyve/issues/23.
 *
 * Each generator yield releases every page/scratch/output view before another
 * job or control message runs. Foreground jobs precede speculative work.
 * A single synchronous provider read cannot be interrupted; cancellation is
 * observed between batches. Counters measure worker copies and bytes delivered
 * by browser APIs, not physical disk traffic or all main-thread allocations.
 */
const PROTOCOL_VERSION = 1;
const state = { file: null, meta: null, generation: 0, pageSize: 0, exports: null, closed: true,
  jobs: [], scheduled: false, order: 0, stats: {} };

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`Invalid fmap ${label}.`);
  return value;
}

function abortError() { const error = new Error("Obsolete fmap request."); error.name = "AbortError"; return error; }
function requireGeneration(generation) {
  if (state.closed || generation !== state.generation) throw abortError();
}
function call(name, ...args) {
  if (typeof state.exports?.[name] !== "function") throw new Error(`Missing fmap WASM export ${name}.`);
  return state.exports[name](...args);
}
function counters() {
  return { ...state.stats, cacheHits: Number(call("fmap_hits")), cacheMisses: Number(call("fmap_misses")),
    cacheEvictions: Number(call("fmap_evictions")), residentBytes: Number(call("fmap_resident_bytes")),
    pinnedBytes: Number(call("fmap_pinned_bytes")), wasmBytes: state.exports.memory.buffer.byteLength };
}
function replyError(message, error) {
  self.postMessage({ id: message.id, generation: message.generation,
    error: { name: error.name || "Error", message: error.message || String(error) },
    stats: state.exports ? counters() : {} });
}

function readFile(offset, length) {
  integer(offset, "read offset"); integer(length, "read length");
  const end = integer(offset + length, "read end");
  if (end > state.file.size || length > state.pageSize) throw new RangeError("fmap range exceeds the file or one read batch.");
  const bytes = new Uint8Array(new FileReaderSync().readAsArrayBuffer(state.file.slice(offset, end)));
  if (bytes.byteLength !== length) throw new Error(`Truncated fmap read at ${offset}: expected ${length} bytes, found ${bytes.byteLength}.`);
  state.stats.browserBytes += length;
  state.stats.readCalls += 1;
  return bytes;
}

function acquire(pageIndex) {
  const page = BigInt(pageIndex);
  const slot = Number(call("fmap_acquire_page", page));
  if (slot < 0) throw new Error(`Unable to acquire fmap page (status ${slot}).`);
  try {
    if (!call("fmap_slot_valid_bytes", slot)) {
      const offset = pageIndex * state.pageSize;
      const length = Math.min(state.pageSize, state.file.size - offset);
      const bytes = readFile(offset, length);
      new Uint8Array(state.exports.memory.buffer, call("fmap_slot_ptr", slot), length).set(bytes);
      if (call("fmap_commit_page", slot, length) !== 0) throw new Error("Unable to commit fmap page.");
      state.stats.copiedBytes += length;
    }
    return slot;
  } catch (error) {
    call("fmap_release_page", slot);
    call("fmap_evict_page", page);
    throw error;
  }
}

function numericSpec() {
  const dataType = Number(state.meta.dataType);
  const sampleBytes = Number(state.meta.bytesPerValue);
  const float32 = dataType === 4;
  return { dataType, sampleBytes, float32, transportBytes: float32 ? 4 : 8 };
}

function numericCapacity(spec) {
  return Number(call(spec.float32 ? "fmap_output_capacity_f32" : "fmap_output_f64_capacity"));
}

function copyExtracted(target, targetOffset, take, spec) {
  const pointer = call(spec.float32 ? "fmap_output_ptr" : "fmap_output_f64_ptr");
  const Extracted = spec.float32 ? Float32Array : Float64Array;
  target.set(new Extracted(state.exports.memory.buffer, pointer, take), targetOffset);
}

function extractPage(slot, inPage, take, stride, spec) {
  if (spec.float32) return Number(call("fmap_extract_f32", slot, inPage, take,
    take === 1 ? spec.sampleBytes : stride, state.meta.littleEndian ? 1 : 0));
  return Number(call("fmap_extract_numeric", slot, inPage, take,
    take === 1 ? spec.sampleBytes : stride, spec.dataType, state.meta.littleEndian ? 1 : 0));
}

function extractScratch(take, stride, length, spec) {
  if (spec.float32) return Number(call("fmap_extract_scratch_f32", 0, take,
    take === 1 ? spec.sampleBytes : stride, state.meta.littleEndian ? 1 : 0, length));
  return Number(call("fmap_extract_scratch_numeric", 0, take,
    take === 1 ? spec.sampleBytes : stride, spec.dataType, state.meta.littleEndian ? 1 : 0, length));
}

// Each yield releases the page and scratch ownership. No WASM view survives a yield.
function* readValues(offset, count, stride, target, targetOffset, preferPage, generation) {
  integer(offset, "sample offset"); integer(count, "sample count"); integer(stride, "sample stride");
  const spec = numericSpec();
  if (stride < spec.sampleBytes) throw new RangeError("Numeric stride is smaller than one sample.");
  if (count && integer(offset + ((count - 1) * stride) + spec.sampleBytes, "sample end") > state.file.size) {
    throw new Error("Truncated ENVI sample range.");
  }
  state.stats.requestedBytes += count * spec.sampleBytes;
  const capacity = numericCapacity(spec);
  while (count > 0) {
    requireGeneration(generation);
    const pageIndex = Math.floor(offset / state.pageSize);
    const inPage = offset - (pageIndex * state.pageSize);
    const cachedSlot = Number(call("fmap_find_page", BigInt(pageIndex)));
    const pageFit = inPage + spec.sampleBytes <= state.pageSize;
    if (pageFit && (cachedSlot >= 0 || preferPage)) {
      const slot = acquire(pageIndex);
      let take;
      try {
        const valid = Number(call("fmap_slot_valid_bytes", slot));
        take = Math.min(count, Math.floor((valid - inPage - spec.sampleBytes) / stride) + 1,
          Math.max(1, Math.floor(state.batchBytes / spec.sampleBytes)), capacity);
        if (take <= 0) throw new Error("Truncated fmap page.");
        const result = extractPage(slot, inPage, take, stride, spec);
        if (result !== take) throw new Error(`fmap extraction failed (status ${result}).`);
        copyExtracted(target, targetOffset, take, spec);
        state.stats.copiedBytes += take * spec.transportBytes;
      } finally { call("fmap_release_page", slot); }
      offset += take * stride; count -= take; targetOffset += take;
      yield Math.max(take * spec.sampleBytes, cachedSlot < 0 ? state.pageSize : 0);
    } else {
      // Sparse cold ranges bypass the resident cache without evicting viewport pages.
      // Coalescing is allowed only for small gaps and always fits the scratch page.
      const maxSpan = Math.min(state.pageSize, state.batchBytes);
      const take = stride - spec.sampleBytes <= state.sparseReadMaxGapBytes
        ? Math.min(count, Math.floor((maxSpan - spec.sampleBytes) / stride) + 1, capacity) : 1;
      const length = ((take - 1) * stride) + spec.sampleBytes;
      const bytes = readFile(offset, length);
      new Uint8Array(state.exports.memory.buffer, call("fmap_scratch_ptr"), length).set(bytes);
      const result = extractScratch(take, stride, length, spec);
      if (result !== take) throw new Error(`fmap sparse extraction failed (status ${result}).`);
      copyExtracted(target, targetOffset, take, spec);
      state.stats.sparseReads += 1;
      state.stats.copiedBytes += length + (take * spec.transportBytes);
      offset += take * stride; count -= take; targetOffset += take;
      yield length;
    }
  }
}

function pixelOffset(x, y, band) {
  const meta = state.meta;
  const bytes = meta.bytesPerValue;
  let index;
  if (meta.interleave === "bsq") index = ((band * meta.lines) + y) * meta.samples + x;
  else if (meta.interleave === "bil") index = ((y * meta.bands) + band) * meta.samples + x;
  else index = ((y * meta.samples) + x) * meta.bands + band;
  return integer(meta.headerOffset + (index * bytes), "pixel offset");
}

function output(count) {
  const spec = numericSpec();
  const bytes = integer(count * spec.transportBytes, "output bytes");
  if (bytes > state.maxResultBytes) throw new RangeError("fmap result exceeds its request budget.");
  state.stats.outputBytes += bytes;
  return spec.float32 ? new Float32Array(count) : new Float64Array(count);
}

function* readWindow(message) {
  const { x0, y0, outW, outH, requestedW, requestedH, step, band, generation } = message;
  for (const value of [x0, y0, outW, outH, requestedW, requestedH, step, band]) integer(value, "window field");
  const meta = state.meta;
  if (!step || band >= meta.bands || outW > requestedW || outH > requestedH
    || (outW && x0 + (outW - 1) * step >= meta.samples)
    || (outH && y0 + (outH - 1) * step >= meta.lines)) throw new RangeError("Invalid fmap window.");
  const values = output(requestedW * requestedH);
  const spec = numericSpec();
  const pixelStride = meta.interleave === "bip" ? meta.bands * spec.sampleBytes : spec.sampleBytes;
  const stride = step * pixelStride;
  const useful = outW * spec.sampleBytes;
  const preferPage = useful * outH >= state.sparseReadThresholdBytes
    && stride === spec.sampleBytes;
  for (let row = 0; row < outH; row += 1) {
    yield* readValues(pixelOffset(x0, y0 + row * step, band), outW, stride,
      values, row * requestedW, preferPage, generation);
  }
  state.stats.usefulValues += outW * outH;
  return values;
}

function* readSpectrum(message) {
  const { x, y, generation, bandStart = 0, bandCount = state.meta.bands } = message;
  integer(x, "spectrum x"); integer(y, "spectrum y"); integer(bandStart, "spectrum band start"); integer(bandCount, "spectrum band count");
  const meta = state.meta;
  if (x >= meta.samples || y >= meta.lines || bandStart + bandCount > meta.bands) throw new RangeError("Spectrum coordinate or band range is outside the dataset.");
  const values = output(bandCount);
  const bytes = meta.bytesPerValue;
  const stride = meta.interleave === "bsq" ? meta.samples * meta.lines * bytes
    : (meta.interleave === "bil" ? meta.samples * bytes : bytes);
  yield* readValues(pixelOffset(x, y, bandStart), bandCount, stride,
    values, 0, state.sparseReadThresholdBytes === 0, generation);
  state.stats.usefulValues += bandCount;
  return values;
}

function* readRange(message) {
  const { offset, length, generation } = message;
  integer(offset, "range offset"); integer(length, "range length");
  const end = integer(offset + length, "range end");
  if (end > state.file.size) throw new RangeError("fmap range exceeds EOF.");
  if (length > state.maxResultBytes) throw new RangeError("fmap range exceeds its request budget.");
  const values = new Uint8Array(length);
  state.stats.requestedBytes += length;
  state.stats.outputBytes += length;
  let cursor = offset;
  let written = 0;
  while (written < length) {
    requireGeneration(generation);
    const pageIndex = Math.floor(cursor / state.pageSize);
    const inPage = cursor - (pageIndex * state.pageSize);
    const slot = acquire(pageIndex);
    let take;
    try {
      const valid = Number(call("fmap_slot_valid_bytes", slot));
      take = Math.min(length - written, valid - inPage, state.batchBytes);
      if (take <= 0) throw new Error("Truncated fmap range page.");
      values.set(new Uint8Array(state.exports.memory.buffer, call("fmap_slot_ptr", slot) + inPage, take), written);
      state.stats.copiedBytes += take;
    } finally { call("fmap_release_page", slot); }
    cursor += take;
    written += take;
    yield take;
  }
  state.stats.usefulValues += length;
  return values;
}

function schedule() {
  if (state.scheduled || !state.jobs.length) return;
  state.scheduled = true;
  setTimeout(runBatch, 0);
}

function runBatch() {
  state.scheduled = false;
  state.jobs.sort((a, b) => a.message.priority - b.message.priority || a.order - b.order);
  const job = state.jobs.shift();
  if (!job) return;
  let batchBytes = 0;
  const start = performance.now();
  try {
    requireGeneration(job.message.generation);
    let result;
    do {
      result = job.iterator.next();
      batchBytes += result.done ? 0 : result.value;
    } while (!result.done && batchBytes < state.batchBytes && performance.now() - start < 4);
    state.stats.batches += 1;
    state.stats.peakBatchBytes = Math.max(state.stats.peakBatchBytes, batchBytes);
    state.stats.maxBatchMs = Math.max(state.stats.maxBatchMs, performance.now() - start);
    if (result.done) {
      const buffer = result.value.buffer;
      self.postMessage({ id: job.message.id, generation: state.generation,
        result: { buffer, stats: counters() } }, [buffer]);
    } else {
      job.order = ++state.order;
      state.jobs.push(job);
    }
  } catch (error) {
    job.iterator.return();
    replyError(job.message, error);
  }
  schedule();
}

function cancelJob(job) {
  job.iterator.return();
  state.stats.workerCancelledRequests += 1;
  replyError(job.message, abortError());
}

async function open(message) {
  if (message.protocolVersion !== PROTOCOL_VERSION || !(message.file instanceof Blob)) throw new Error("Unsupported fmap source/protocol.");
  const pageSize = integer(message.pageSize, "page size");
  const slots = Math.floor(integer(message.poolBytes, "pool bytes") / pageSize);
  if (pageSize < 4096 || !slots) throw new RangeError("Invalid fmap pool.");
  const { instance } = await WebAssembly.instantiate(message.wasmBytes, {});
  state.exports = instance.exports;
  const status = Number(call("fmap_init", pageSize, slots));
  if (status !== 0) throw new Error(`fmap initialization failed (status ${status}).`);
  state.file = message.file;
  state.meta = message.meta;
  if (message.mode !== "range") {
    if (!state.meta || !["bsq", "bil", "bip"].includes(state.meta.interleave)) throw new Error("Invalid fmap ENVI metadata.");
    state.meta.headerOffset = Number(state.meta.headerOffset || 0);
  }
  state.generation = message.generation;
  state.pageSize = pageSize;
  state.maxResultBytes = integer(message.maxResultBytes, "result limit");
  state.batchBytes = Math.max(4, integer(message.batchBytes, "batch limit"));
  state.sparseReadThresholdBytes = integer(message.sparseReadThresholdBytes, "sparse threshold");
  state.sparseReadMaxGapBytes = integer(message.sparseReadMaxGapBytes, "sparse gap");
  state.closed = false;
  state.stats = { requestedBytes: 0, browserBytes: 0, copiedBytes: 0, usefulValues: 0,
    readCalls: 0, sparseReads: 0, outputBytes: 0, batches: 0, peakBatchBytes: 0, maxBatchMs: 0, workerCancelledRequests: 0 };
  return { residentBytes: slots * pageSize, stats: counters() };
}

self.onmessage = async (event) => {
  const message = event.data || {};
  try {
    if (message.type === "open") {
      self.postMessage({ id: message.id, result: await open(message) });
    } else if (message.type === "cancel") {
      const index = state.jobs.findIndex((job) => job.message.id === message.id);
      if (index >= 0) cancelJob(state.jobs.splice(index, 1)[0]);
    } else if (message.type === "clear" || message.type === "close") {
      for (const job of state.jobs.splice(0)) cancelJob(job);
      state.generation = message.generation;
      call("fmap_reset");
      if (message.type === "close") { state.closed = true; state.file = null; }
    } else if (message.type === "stats") {
      requireGeneration(message.generation);
      self.postMessage({ id: message.id, result: { stats: counters() } });
    } else if (message.type === "window" || message.type === "spectrum" || message.type === "range") {
      requireGeneration(message.generation);
      message.priority = message.priority === 1 ? 1 : 0;
      const iterator = message.type === "window" ? readWindow(message)
        : (message.type === "spectrum" ? readSpectrum(message) : readRange(message));
      state.jobs.push({ message, iterator, order: ++state.order });
      schedule();
    } else throw new Error(`Unknown fmap request ${message.type}.`);
  } catch (error) { replyError(message, error); }
};
