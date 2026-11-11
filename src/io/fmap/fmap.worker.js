import { FmapPageFillQueue } from "./page-fill-queue.js";
/**
 * File range bridge and cooperative ENVI processing for one source. BSQ, BIL,
 * and BIP planners feed all nine supported numeric types through bounded C
 * extraction. Dense windows request whole pages; cold sparse spans retain exact
 * partial-page validity through the independent fill queue. File offsets stay
 * exact JavaScript integers at the Blob boundary and become u64 page IDs
 * independently of WASM pointers. See https://github.com/chemimage/Hyve/issues/23.
 *
 * A range demand resumes with a pinned lease; processing releases that lease and
 * every WASM view before its next yield. Async Blob reads can overlap while
 * runnable foreground jobs precede speculative work. Cancellation removes an
 * individual waiter without poisoning a shared fill. Counters measure worker
 * copies and bytes delivered by browser APIs, not physical disk traffic.
 */
const PROTOCOL_VERSION = 1;
const RASTER_TYPE_BYTES = Object.freeze({
  1: 1, 2: 2, 3: 4, 4: 4, 5: 8, 12: 2, 13: 4, 14: 8, 15: 8
});
const state = { file: null, meta: null, generation: 0, pageSize: 0, exports: null, fillQueue: null, closed: true,
  jobs: [], waiting: new Map(), jobById: new Map(), scheduled: false, order: 0, stats: {} };

// The worker pulls queued jobs between bounded batches. A local message task
// yields to incoming requests/cancellation without chained timers' minimum
// delay. Only one wake-up is outstanding; the UI never acknowledges batches.
const batchChannel = new MessageChannel();
batchChannel.port1.onmessage = runBatch;

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`Invalid fmap ${label}.`);
  return value;
}

function safeProduct(values, label) {
  let product = 1;
  for (const value of values) {
    product *= value;
    if (!Number.isSafeInteger(product)) throw new RangeError(`Invalid fmap ${label}.`);
  }
  return product;
}

function validateRasterMeta(meta, fileSize) {
  if (!meta || typeof meta !== "object") throw new TypeError("Missing fmap raster metadata.");
  const samples = integer(meta.samples, "raster samples");
  const lines = integer(meta.lines, "raster lines");
  const bands = integer(meta.bands, "raster bands");
  const headerOffset = integer(meta.headerOffset ?? 0, "raster header offset");
  const dataType = integer(meta.dataType, "raster data type");
  const bytesPerValue = integer(meta.bytesPerValue, "raster bytes per value");
  if (!samples || !lines || !bands || !bytesPerValue) {
    throw new RangeError("fmap raster dimensions and sample size must be positive.");
  }
  if (!Object.hasOwn(RASTER_TYPE_BYTES, dataType)
      || RASTER_TYPE_BYTES[dataType] !== bytesPerValue) {
    throw new Error(`Unsupported fmap raster data type: ${dataType}.`);
  }
  if (!["bsq", "bil", "bip"].includes(meta.interleave)) {
    throw new Error(`Unsupported fmap raster interleave: ${meta.interleave}.`);
  }
  if (typeof meta.littleEndian !== "boolean") {
    throw new TypeError("fmap raster byte order must be boolean.");
  }
  const payloadBytes = safeProduct([samples, lines, bands, bytesPerValue], "raster payload size");
  const expectedEnd = headerOffset + payloadBytes;
  if (!Number.isSafeInteger(expectedEnd)) throw new RangeError("Invalid fmap raster payload end.");
  if (expectedEnd > fileSize) {
    throw new Error(`Truncated fmap raster: expected at least ${expectedEnd} bytes, found ${fileSize}.`);
  }
  return { ...meta, samples, lines, bands, headerOffset, dataType, bytesPerValue };
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
  const fills = state.fillQueue?.getStats() || {};
  return { ...state.stats, ...fills,
    copiedBytes: state.stats.copiedBytes + (fills.pageFillCopiedBytes || 0),
    cacheHits: Number(call("fmap_hits")), cacheMisses: Number(call("fmap_misses")),
    cacheEvictions: Number(call("fmap_evictions")), residentBytes: Number(call("fmap_resident_bytes")),
    pinnedBytes: Number(call("fmap_pinned_bytes")), wasmBytes: state.exports.memory.buffer.byteLength };
}
function replyError(message, error) {
  self.postMessage({ id: message.id, generation: message.generation,
    error: { name: error.name || "Error", message: error.message || String(error) },
    stats: state.exports ? counters() : {} });
}

async function readFile(file, pageSize, stats, offset, length) {
  integer(offset, "read offset"); integer(length, "read length");
  const end = integer(offset + length, "read end");
  if (end > file.size || length > pageSize) throw new RangeError("fmap range exceeds the file or one read batch.");
  const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
  if (bytes.byteLength !== length) throw new Error(`Truncated fmap read at ${offset}: expected ${length} bytes, found ${bytes.byteLength}.`);
  stats.browserBytes += length;
  stats.readCalls += 1;
  return bytes;
}

function rangeDemand(message, pageIndex, offset, length) {
  return { kind: "range", pageIndex, offset, length, priority: message.priority,
    generation: message.generation, requestId: message.id };
}

function checkpoint(bytes) {
  return { kind: "checkpoint", bytes };
}

function* copyRange(offset, length, target, targetOffset, message) {
  let cursor = offset;
  let remaining = length;
  while (remaining > 0) {
    const pageIndex = Math.floor(cursor / state.pageSize);
    const inPage = cursor - (pageIndex * state.pageSize);
    const take = Math.min(remaining, state.pageSize - inPage);
    const lease = yield rangeDemand(message, pageIndex, inPage, take);
    try {
      target.set(new Uint8Array(state.exports.memory.buffer,
        call("fmap_slot_ptr", lease.slot) + inPage, take), targetOffset);
      state.stats.copiedBytes += take;
    } finally { lease.release(); }
    cursor += take;
    targetOffset += take;
    remaining -= take;
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

function extractScratch(byteOffset, take, stride, length, spec) {
  if (spec.float32) return Number(call("fmap_extract_scratch_f32", byteOffset, take,
    take === 1 ? spec.sampleBytes : stride, state.meta.littleEndian ? 1 : 0, length));
  return Number(call("fmap_extract_scratch_numeric", byteOffset, take,
    take === 1 ? spec.sampleBytes : stride, spec.dataType, state.meta.littleEndian ? 1 : 0, length));
}

// Each range yield resumes with a pinned lease. The lease and every WASM view are
// released before the generator yields again.
function* readValues(offset, count, stride, target, targetOffset, preferPage, message) {
  integer(offset, "sample offset"); integer(count, "sample count"); integer(stride, "sample stride");
  const spec = numericSpec();
  if (stride < spec.sampleBytes) throw new RangeError("Numeric stride is smaller than one sample.");
  if (count && integer(offset + ((count - 1) * stride) + spec.sampleBytes, "sample end") > state.file.size) {
    throw new Error("Truncated ENVI sample range.");
  }
  state.stats.requestedBytes += count * spec.sampleBytes;
  const capacity = numericCapacity(spec);
  while (count > 0) {
    requireGeneration(message.generation);
    const pageIndex = Math.floor(offset / state.pageSize);
    const inPage = offset - (pageIndex * state.pageSize);
    const pageLength = Math.min(state.pageSize, state.file.size - (pageIndex * state.pageSize));
    const pageFit = inPage + spec.sampleBytes <= state.pageSize;
    const resident = pageFit && rangeIsResident(offset, spec.sampleBytes);
    if (pageFit && (resident || preferPage)) {
      const take = Math.min(count,
        Math.floor((pageLength - inPage - spec.sampleBytes) / stride) + 1,
        Math.max(1, Math.floor(state.batchBytes / spec.sampleBytes)), capacity);
      if (take <= 0) throw new Error("Truncated fmap page.");
      const demandOffset = preferPage ? 0 : inPage;
      const demandLength = preferPage ? pageLength : (((take - 1) * stride) + spec.sampleBytes);
      const lease = yield rangeDemand(message, pageIndex, demandOffset, demandLength);
      try {
        const result = extractPage(lease.slot, inPage, take, stride, spec);
        if (result !== take) throw new Error(`fmap extraction failed (status ${result}).`);
        copyExtracted(target, targetOffset, take, spec);
        state.stats.copiedBytes += take * spec.transportBytes;
      } finally { lease.release(); }
      offset += take * stride; count -= take; targetOffset += take;
      yield checkpoint(Math.max(take * spec.sampleBytes, resident ? 0 : demandLength));
    } else if (pageFit) {
      // Cold sparse spans retain only their exact in-page interval.
      const maxSpan = Math.max(spec.sampleBytes,
        Math.min(state.pageSize - inPage, state.batchBytes));
      const take = stride - spec.sampleBytes <= state.sparseReadMaxGapBytes
        ? Math.min(count, Math.floor((maxSpan - spec.sampleBytes) / stride) + 1, capacity) : 1;
      const length = ((take - 1) * stride) + spec.sampleBytes;
      const lease = yield rangeDemand(message, pageIndex, inPage, length);
      try {
        const result = extractPage(lease.slot, inPage, take, stride, spec);
        if (result !== take) throw new Error(`fmap sparse extraction failed (status ${result}).`);
        copyExtracted(target, targetOffset, take, spec);
        state.stats.sparseReads += 1;
        state.stats.copiedBytes += take * spec.transportBytes;
      } finally { lease.release(); }
      offset += take * stride; count -= take; targetOffset += take;
      yield checkpoint(length);
    } else {
      // A numeric value may straddle two pages. Assemble only that value in a
      // bounded JS buffer, then use C scratch after every page lease is released.
      const bytes = new Uint8Array(spec.sampleBytes);
      yield* copyRange(offset, spec.sampleBytes, bytes, 0, message);
      new Uint8Array(state.exports.memory.buffer, call("fmap_scratch_ptr"), spec.sampleBytes).set(bytes);
      const result = extractScratch(0, 1, spec.sampleBytes, spec.sampleBytes, spec);
      if (result !== 1) throw new Error(`fmap split-page extraction failed (status ${result}).`);
      copyExtracted(target, targetOffset, 1, spec);
      state.stats.sparseReads += 1;
      state.stats.copiedBytes += spec.sampleBytes + spec.transportBytes;
      offset += stride; count -= 1; targetOffset += 1;
      yield checkpoint(spec.sampleBytes);
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

function rangeIsResident(offset, length) {
  let cursor = offset;
  let remaining = length;
  while (remaining > 0) {
    const page = Math.floor(cursor / state.pageSize);
    const inPage = cursor - (page * state.pageSize);
    const take = Math.min(remaining, state.pageSize - inPage);
    const slot = Number(call("fmap_find_page", BigInt(page)));
    if (slot < 0 || Number(call("fmap_range_valid", slot, inPage, take)) !== 1) return false;
    cursor += take;
    remaining -= take;
  }
  return true;
}

function chooseRowSlabRows(remainingRows, rowSourceStride, rowSpan, usefulRowBytes) {
  const maxSpan = Math.min(state.pageSize, state.batchBytes);
  let rows = 1;
  while (rows < remainingRows) {
    const candidate = rows + 1;
    const span = ((candidate - 1) * rowSourceStride) + rowSpan;
    const useful = candidate * usefulRowBytes;
    if (span > maxSpan || span > useful * state.maxCoalescedOverreadRatio) break;
    rows = candidate;
  }
  return rows;
}

function* readWindowRows(message, values, spec, stride) {
  const { x0, y0, outW, outH, requestedW, step, band, generation } = message;
  const row0 = pixelOffset(x0, y0, band);
  const row1 = outH > 1 ? pixelOffset(x0, y0 + step, band) : row0;
  const rowSourceStride = outH > 1 ? row1 - row0 : 0;
  const rowSpan = outW ? ((outW - 1) * stride) + spec.sampleBytes : 0;
  const usefulRowBytes = outW * spec.sampleBytes;
  const capacity = numericCapacity(spec);

  for (let row = 0; row < outH;) {
    requireGeneration(generation);
    const offset = pixelOffset(x0, y0 + row * step, band);
    const slabRows = rowSourceStride > 0 && outW <= capacity
      ? chooseRowSlabRows(outH - row, rowSourceStride, rowSpan, usefulRowBytes) : 1;
    const slabLength = slabRows > 1 ? ((slabRows - 1) * rowSourceStride) + rowSpan : rowSpan;
    if (slabRows > 1 && !rangeIsResident(offset, slabLength)) {
      const bytes = new Uint8Array(slabLength);
      yield* copyRange(offset, slabLength, bytes, 0, message);
      new Uint8Array(state.exports.memory.buffer, call("fmap_scratch_ptr"), slabLength).set(bytes);
      state.stats.requestedBytes += slabRows * usefulRowBytes;
      for (let localRow = 0; localRow < slabRows; localRow += 1) {
        const result = extractScratch(localRow * rowSourceStride, outW, stride, slabLength, spec);
        if (result !== outW) throw new Error(`fmap row-slab extraction failed (status ${result}).`);
        copyExtracted(values, (row + localRow) * requestedW, outW, spec);
      }
      state.stats.sparseReads += 1;
      state.stats.copiedBytes += slabLength + (slabRows * outW * spec.transportBytes);
      row += slabRows;
      yield checkpoint(slabLength);
      continue;
    }
    yield* readValues(offset, outW, stride, values, row * requestedW, false, message);
    row += 1;
  }
}

function* readWindow(message) {
  const { x0, y0, outW, outH, requestedW, requestedH, step, band } = message;
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
  const preferPage = state.sparseReadThresholdBytes === 0
    || (useful * outH >= state.sparseReadThresholdBytes && stride === spec.sampleBytes);
  if (preferPage) {
    for (let row = 0; row < outH; row += 1) {
      yield* readValues(pixelOffset(x0, y0 + row * step, band), outW, stride,
        values, row * requestedW, true, message);
    }
  } else {
    yield* readWindowRows(message, values, spec, stride);
  }
  state.stats.usefulValues += outW * outH;
  return values;
}

function* readSpectrum(message) {
  const { x, y, bandStart = 0, bandCount = state.meta.bands } = message;
  integer(x, "spectrum x"); integer(y, "spectrum y"); integer(bandStart, "spectrum band start"); integer(bandCount, "spectrum band count");
  const meta = state.meta;
  if (x >= meta.samples || y >= meta.lines || bandStart + bandCount > meta.bands) throw new RangeError("Spectrum coordinate or band range is outside the dataset.");
  const values = output(bandCount);
  const bytes = meta.bytesPerValue;
  const stride = meta.interleave === "bsq" ? meta.samples * meta.lines * bytes
    : (meta.interleave === "bil" ? meta.samples * bytes : bytes);
  yield* readValues(pixelOffset(x, y, bandStart), bandCount, stride,
    values, 0, state.sparseReadThresholdBytes === 0, message);
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
    const take = Math.min(length - written, state.pageSize - inPage, state.batchBytes);
    const lease = yield rangeDemand(message, pageIndex, inPage, take);
    try {
      values.set(new Uint8Array(state.exports.memory.buffer,
        call("fmap_slot_ptr", lease.slot) + inPage, take), written);
      state.stats.copiedBytes += take;
    } finally { lease.release(); }
    cursor += take;
    written += take;
    yield checkpoint(take);
  }
  state.stats.usefulValues += length;
  return values;
}

function schedule() {
  if (state.scheduled || !state.jobs.length) return;
  state.scheduled = true;
  batchChannel.port2.postMessage(null);
}

function releaseResumeLease(job) {
  if (job.resumeValue?.release) job.resumeValue.release();
  job.resumeValue = undefined;
}

function removeJob(job) {
  state.jobById.delete(job.message.id);
  state.waiting.delete(job.message.id);
  job.waitingCancel = null;
}

function resumeWaiting(job, lease, error) {
  if (state.waiting.get(job.message.id) !== job || job.cancelled) {
    lease?.release?.();
    return;
  }
  state.waiting.delete(job.message.id);
  job.waitingCancel = null;
  if (error) job.resumeError = error;
  else job.resumeValue = lease;
  job.order = ++state.order;
  state.jobs.push(job);
  schedule();
}

function runBatch() {
  state.scheduled = false;
  state.jobs.sort((a, b) => a.message.priority - b.message.priority || a.order - b.order);
  const job = state.jobs.shift();
  if (!job) return;
  let batchBytes = 0;
  const start = performance.now();
  let paused = false;
  let didWork = false;
  try {
    requireGeneration(job.message.generation);
    while (!paused) {
      let result;
      if (job.resumeError) {
        const error = job.resumeError;
        job.resumeError = null;
        result = job.iterator.throw(error);
      } else {
        const value = job.resumeValue;
        job.resumeValue = undefined;
        result = job.iterator.next(value);
      }
      if (result.done) {
        didWork = true;
        removeJob(job);
        const buffer = result.value.buffer;
        self.postMessage({ id: job.message.id, generation: state.generation,
          result: { buffer, stats: counters() } }, [buffer]);
        break;
      }
      const command = result.value;
      if (command?.kind === "checkpoint") {
        didWork = true;
        batchBytes += integer(command.bytes, "batch bytes");
        if (batchBytes >= state.batchBytes || performance.now() - start >= 4) {
          job.order = ++state.order;
          state.jobs.push(job);
          paused = true;
        }
        continue;
      }
      if (command?.kind !== "range") throw new Error("Invalid fmap worker demand.");
      let request;
      try {
        request = state.fillQueue.request({ ...command,
          requestId: `${job.message.id}:${++job.demandOrder}` });
      } catch (error) {
        job.resumeError = error;
        continue;
      }
      if (request.lease) {
        job.resumeValue = request.lease;
        continue;
      }
      if (!request.promise || typeof request.cancel !== "function") {
        throw new Error("Invalid fmap fill queue request.");
      }
      job.waitingCancel = request.cancel;
      state.waiting.set(job.message.id, job);
      request.promise.then(
        (lease) => resumeWaiting(job, lease, null),
        (error) => resumeWaiting(job, null, error),
      );
      paused = true;
    }
  } catch (error) {
    releaseResumeLease(job);
    removeJob(job);
    job.iterator.return?.();
    replyError(job.message, error);
  }
  if (didWork) {
    state.stats.batches += 1;
    state.stats.peakBatchBytes = Math.max(state.stats.peakBatchBytes, batchBytes);
    state.stats.maxBatchMs = Math.max(state.stats.maxBatchMs, performance.now() - start);
  }
  schedule();
}

function cancelJob(job) {
  if (job.cancelled) return;
  job.cancelled = true;
  const index = state.jobs.indexOf(job);
  if (index >= 0) state.jobs.splice(index, 1);
  state.waiting.delete(job.message.id);
  job.waitingCancel?.();
  releaseResumeLease(job);
  removeJob(job);
  job.iterator.return?.();
  state.stats.workerCancelledRequests += 1;
  replyError(job.message, abortError());
}

async function open(message) {
  if (message.protocolVersion !== PROTOCOL_VERSION || !(message.file instanceof Blob)) throw new Error("Unsupported fmap source/protocol.");
  const pageSize = integer(message.pageSize, "page size");
  const slots = Math.floor(integer(message.poolBytes, "pool bytes") / pageSize);
  if (pageSize < 4096 || !slots) throw new RangeError("Invalid fmap pool.");
  const readConcurrency = integer(message.readConcurrency ?? 2, "read concurrency");
  const maxQueuedRequests = integer(message.maxQueuedRequests ?? 64, "fill request limit");
  const maxQueuedBytes = integer(message.maxQueuedBytes ?? (32 * 1024 * 1024), "fill byte limit");
  if (!readConcurrency || !maxQueuedRequests || !maxQueuedBytes) throw new RangeError("Invalid fmap fill queue limits.");
  state.fillQueue?.close();
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
  state.maxCoalescedOverreadRatio = Number(message.maxCoalescedOverreadRatio);
  if (!Number.isFinite(state.maxCoalescedOverreadRatio) || state.maxCoalescedOverreadRatio < 1) {
    throw new RangeError("Invalid fmap coalesced overread ratio.");
  }
  state.stats = { requestedBytes: 0, browserBytes: 0, copiedBytes: 0, usefulValues: 0,
    readCalls: 0, sparseReads: 0, outputBytes: 0, batches: 0, peakBatchBytes: 0, maxBatchMs: 0, workerCancelledRequests: 0 };
  const sourceFile = state.file;
  const sourceStats = state.stats;
  state.fillQueue = new FmapPageFillQueue({ core: state.exports, fileSize: sourceFile.size,
    pageSize, generation: state.generation, concurrency: readConcurrency,
    maxQueuedRequests, maxQueuedBytes,
    readFile: (offset, length) => readFile(sourceFile, pageSize, sourceStats, offset, length) });
  state.jobs.length = 0;
  state.waiting.clear();
  state.jobById.clear();
  state.closed = false;
  return { residentBytes: slots * pageSize, stats: counters() };
}

self.onmessage = async (event) => {
  const message = event.data || {};
  try {
    if (message.type === "open") {
      self.postMessage({ id: message.id, result: await open(message) });
    } else if (message.type === "cancel") {
      const job = state.jobById.get(message.id);
      if (job) cancelJob(job);
    } else if (message.type === "clear" || message.type === "close") {
      for (const job of [...state.jobById.values()]) cancelJob(job);
      state.generation = message.generation;
      if (message.type === "close") {
        state.fillQueue.close();
        state.closed = true;
        state.file = null;
      } else state.fillQueue.clear(state.generation);
    } else if (message.type === "configureRaster") {
      requireGeneration(message.generation);
      if (state.meta) throw new Error("fmap raster metadata is already configured.");
      if (state.jobById.size !== 0) throw new Error("Cannot configure fmap raster metadata while requests are active.");
      state.meta = validateRasterMeta(message.meta, state.file.size);
      self.postMessage({ id: message.id, generation: state.generation,
        result: { stats: counters() } });
    } else if (message.type === "setConcurrency") {
      requireGeneration(message.generation);
      const concurrency = integer(message.readConcurrency, "read concurrency");
      if (!concurrency) throw new RangeError("Invalid fmap read concurrency.");
      state.fillQueue.setConcurrency(concurrency);
    } else if (message.type === "stats") {
      requireGeneration(message.generation);
      self.postMessage({ id: message.id, result: { stats: counters() } });
    } else if (message.type === "window" || message.type === "spectrum" || message.type === "range") {
      requireGeneration(message.generation);
      message.priority = message.priority === 1 ? 1 : 0;
      const iterator = message.type === "window" ? readWindow(message)
        : (message.type === "spectrum" ? readSpectrum(message) : readRange(message));
      if (state.jobById.has(message.id)) throw new Error("Duplicate fmap request id.");
      const job = { message, iterator, order: ++state.order, demandOrder: 0, cancelled: false,
        waitingCancel: null, resumeValue: undefined, resumeError: null };
      state.jobs.push(job);
      state.jobById.set(message.id, job);
      schedule();
    } else throw new Error(`Unknown fmap request ${message.type}.`);
  } catch (error) { replyError(message, error); }
};
