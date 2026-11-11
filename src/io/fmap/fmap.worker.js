/* global FileReaderSync */
/**
 * File range bridge and cooperative BSQ Float32 processing for one source.
 * Dense windows reuse resident pages; cold sparse spans use C-owned scratch
 * without evicting viewport pages. File offsets stay exact JavaScript integers
 * at the Blob boundary and become u64 page IDs independently of WASM pointers.
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

// Each yield releases the page and scratch ownership. No WASM view survives a yield.
function* readValues(offset, count, stride, target, targetOffset, preferPage, generation) {
  integer(offset, "sample offset"); integer(count, "sample count"); integer(stride, "sample stride");
  if (stride < 4) throw new RangeError("Float32 stride must be at least four bytes.");
  if (count && integer(offset + ((count - 1) * stride) + 4, "sample end") > state.file.size) {
    throw new Error("Truncated Float32 sample range.");
  }
  state.stats.requestedBytes += count * 4;
  while (count > 0) {
    requireGeneration(generation);
    const pageIndex = Math.floor(offset / state.pageSize);
    const inPage = offset - (pageIndex * state.pageSize);
    const cachedSlot = Number(call("fmap_find_page", BigInt(pageIndex)));
    const pageFit = inPage + 4 <= state.pageSize;
    if (pageFit && (cachedSlot >= 0 || preferPage)) {
      const slot = acquire(pageIndex);
      let take;
      try {
        const valid = Number(call("fmap_slot_valid_bytes", slot));
        take = Math.min(count, Math.floor((valid - inPage - 4) / stride) + 1,
          Math.max(1, Math.floor(state.batchBytes / 4)));
        if (take <= 0) throw new Error("Truncated fmap page.");
        const result = Number(call("fmap_extract_f32", slot, inPage, take, take === 1 ? 4 : stride, state.meta.littleEndian ? 1 : 0));
        if (result !== take) throw new Error(`fmap extraction failed (status ${result}).`);
        target.set(new Float32Array(state.exports.memory.buffer, call("fmap_output_ptr"), take), targetOffset);
        state.stats.copiedBytes += take * 4;
      } finally { call("fmap_release_page", slot); }
      offset += take * stride; count -= take; targetOffset += take;
      yield Math.max(take * 4, cachedSlot < 0 ? state.pageSize : 0);
    } else {
      // Sparse cold ranges bypass the resident cache without evicting viewport pages.
      // Coalescing is allowed only for small gaps and always fits the scratch page.
      const maxSpan = Math.min(state.pageSize, state.batchBytes);
      const take = stride - 4 <= state.sparseReadMaxGapBytes
        ? Math.min(count, Math.floor((maxSpan - 4) / stride) + 1) : 1;
      const length = ((take - 1) * stride) + 4;
      const bytes = readFile(offset, length);
      new Uint8Array(state.exports.memory.buffer, call("fmap_scratch_ptr"), length).set(bytes);
      const result = Number(call("fmap_extract_scratch_f32", 0, take, take === 1 ? 4 : stride, state.meta.littleEndian ? 1 : 0, length));
      if (result !== take) throw new Error(`fmap sparse extraction failed (status ${result}).`);
      target.set(new Float32Array(state.exports.memory.buffer, call("fmap_output_ptr"), take), targetOffset);
      state.stats.sparseReads += 1;
      state.stats.copiedBytes += length + (take * 4);
      offset += take * stride; count -= take; targetOffset += take;
      yield length;
    }
  }
}

function pixelOffset(x, y, band) {
  const meta = state.meta;
  return integer(meta.headerOffset + ((((band * meta.lines) + y) * meta.samples + x) * 4), "pixel offset");
}

function output(count) {
  const bytes = integer(count * 4, "output bytes");
  if (bytes > state.maxResultBytes) throw new RangeError("fmap result exceeds its request budget.");
  state.stats.outputBytes += bytes;
  return new Float32Array(count);
}

function* readWindow(message) {
  const { x0, y0, outW, outH, requestedW, requestedH, step, band, generation } = message;
  for (const value of [x0, y0, outW, outH, requestedW, requestedH, step, band]) integer(value, "window field");
  const meta = state.meta;
  if (!step || band >= meta.bands || outW > requestedW || outH > requestedH
    || (outW && x0 + (outW - 1) * step >= meta.samples)
    || (outH && y0 + (outH - 1) * step >= meta.lines)) throw new RangeError("Invalid fmap window.");
  const values = output(requestedW * requestedH);
  const preferPage = outW * outH * 4 >= state.sparseReadThresholdBytes && step <= 4;
  for (let row = 0; row < outH; row += 1) {
    yield* readValues(pixelOffset(x0, y0 + row * step, band), outW, step * 4,
      values, row * requestedW, preferPage, generation);
  }
  state.stats.usefulValues += outW * outH;
  return values;
}

function* readSpectrum(message) {
  const { x, y, generation } = message;
  integer(x, "spectrum x"); integer(y, "spectrum y");
  const meta = state.meta;
  if (x >= meta.samples || y >= meta.lines) throw new RangeError("Spectrum coordinate is outside the dataset.");
  const values = output(meta.bands);
  yield* readValues(pixelOffset(x, y, 0), meta.bands, meta.samples * meta.lines * 4,
    values, 0, state.sparseReadThresholdBytes === 0, generation);
  state.stats.usefulValues += meta.bands;
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
  state.meta.headerOffset = Number(state.meta.headerOffset || 0);
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
    } else if (message.type === "window" || message.type === "spectrum") {
      requireGeneration(message.generation);
      message.priority = message.priority === 1 ? 1 : 0;
      state.jobs.push({ message, iterator: message.type === "window" ? readWindow(message) : readSpectrum(message), order: ++state.order });
      schedule();
    } else throw new Error(`Unknown fmap request ${message.type}.`);
  } catch (error) { replyError(message, error); }
};
