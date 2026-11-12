import InlineFmapWorker from "./fmap.worker.js?worker&inline";
import { FmapMappings } from "./mapped-regions.js";
import {
  FMAP_PROTOCOL_VERSION, assertFmapEnviMeta, checkedAdd, checkedResultBytes,
  createAbortError, normalizeFmapWindow
} from "./protocol.js";

let nextSourceId = 1;
const now = () => performance.now();
const controlTypes = new Set(["open", "stats", "mapRegion", "unmapRegion"]);

function limit(value, fallback, minimum = 1) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < minimum) throw new RangeError("Invalid fmap request limit.");
  return number;
}

function workerError(raw) {
  const error = new Error(String(raw?.message || "fmap worker request failed"));
  error.name = String(raw?.name || "Error");
  return error;
}

function cloneWasmBytes(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes.slice(0);
  if (ArrayBuffer.isView(bytes)) return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  throw new Error("fmap WASM artifact is unavailable.");
}

function windowCtor(meta) {
  if (typeof meta?.dataTypeInfo?.ctor === "function") return meta.dataTypeInfo.ctor;
  return Float64Array;
}

function transportCtor(meta) {
  return Number(meta?.dataType) === 4 ? Float32Array : Float64Array;
}

function transportBytes(meta) {
  return transportCtor(meta).BYTES_PER_ELEMENT;
}

function rasterDescriptor(meta) {
  return { samples: meta.samples, lines: meta.lines, bands: meta.bands,
    headerOffset: meta.headerOffset, interleave: meta.interleave, dataType: meta.dataType,
    bytesPerValue: meta.dataTypeInfo.bytes, littleEndian: meta.littleEndian };
}

/**
 * A per-open file session backed by a dedicated C/WASM worker.
 *
 * The selected File remains the backing store. The worker owns resident pages;
 * callers receive owned results using the released backend's numeric types,
 * never views into evictable WASM pages. Logical results above the worker cap
 * are assembled from bounded chunks with cancellation checked between chunks.
 * Runnable jobs wait independently on a deduplicated asynchronous page-fill
 * queue. Sparse ranges retain exact C validity; shared fills have independent
 * consumer leases. The 512 MiB default raw target is capped by small-file size.
 * Queue and active-byte limits are per source, not a whole-application budget.
 * The implicit whole-file mapping is source.mapping. source.map() adds sparse
 * region handles without loading bytes; a released handle's identity is never
 * reused. clear() preserves mappings, while close() invalidates every handle.
 * Window/spectrum options accept signal, cancelled(), priority, supersedeKey,
 * and maxAgeMs. Cancellation rejects immediately, but an active reservation is
 * released only after a worker reply. clear() advances the source generation;
 * close() terminates the worker. clear() before initial readiness is a no-op;
 * concurrent stats polls share one request. setMaxBytes() records a requested budget;
 * cache eviction reuses slots; shrinking WASM capacity requires a fresh memory
 * and instance, not necessarily a new worker. Congestion waits as lightweight
 * descriptors before output allocation; admitted work remains byte/count bounded.
 *
 * Status and follow-up work: https://github.com/chemimage/Hyve/issues/23
 */
export class FmapDataSource {
  constructor(file, meta, options = {}) {
    if (!(file instanceof Blob)) throw new TypeError("fmap requires a user-selected File or Blob.");
    const mode = options.mode === "range" ? "range" : "envi";
    if (mode === "envi") assertFmapEnviMeta(meta, file.size);
    this.pageSize = limit(options.pageSize, 256 * 1024, 4096);
    this.maxBytes = limit(options.poolBytes, 512 * 1024 * 1024, this.pageSize);
    this.maxResultBytes = limit(options.maxResultBytes, 4 * 1024 * 1024);
    this.maxInflightBytes = limit(options.maxInflightBytes, 8 * 1024 * 1024, this.pageSize + 4);
    this.maxQueuedBytes = limit(options.maxQueuedBytes, 32 * 1024 * 1024);
    this.maxQueuedRequests = limit(options.maxQueuedRequests, 64);
    this.maxLogicalResultBytes = limit(options.maxLogicalResultBytes, 128 * 1024 * 1024);
    this.maxLogicalBytes = limit(options.maxLogicalBytes, this.maxLogicalResultBytes);
    this.logicalBytesReserved = 0;
    this.batchBytes = Math.min(this.pageSize, limit(options.batchBytes, 64 * 1024));
    this.sparseReadThresholdBytes = limit(options.sparseReadThresholdBytes, Math.min(32 * 1024, this.pageSize / 8), 0);
    this.sparseReadMaxGapBytes = limit(options.sparseReadMaxGapBytes, 4096, 0);
    this.maxCoalescedOverreadRatio = Number(options.maxCoalescedOverreadRatio ?? 14);
    if (!Number.isFinite(this.maxCoalescedOverreadRatio) || this.maxCoalescedOverreadRatio < 1) {
      throw new RangeError("Invalid fmap coalesced overread ratio.");
    }
    this.file = file;
    this.meta = meta;
    this.mode = mode;
    // Let the raster wrapper defer output allocation until our byte admission.
    // This reader also owns clipping and the requested output stride.
    this.managesWindowOutput = mode === "envi";
    this.size = file.size;
    this.ownerId = `fmap:${nextSourceId++}`;
    this.mappings = new FmapMappings(this, (type, fields, bytes) => {
      if (type === "unmapRegion") this.#cancelMapping(fields.mappingId);
      return this.#enqueue(type, fields, bytes);
    });
    this.mapping = this.mappings.root;
    this.chunkSize = this.pageSize;
    // poolBytes is a per-file target, not a tab quota. Small files need only
    // their page-rounded size; larger files keep a bounded resident subset.
    this.residentBytes = Math.min(
      Math.floor(this.maxBytes / this.pageSize),
      Math.max(1, Math.ceil(file.size / this.pageSize))
    ) * this.pageSize;
    this.requestedMaxBytes = this.maxBytes;
    this.concurrency = limit(options.concurrency, 2);
    this.generation = 1;
    this.closed = false;
    this.worker = null;
    this.requestId = 0;
    this.logicalRequestId = 0;
    this.latestSupersedeGroups = new Map();
    this.active = 0;
    this.queue = [];
    this.waitingRequests = [];
    this.logicalWaiters = [];
    this.pending = new Map();
    this.pollTimer = null;
    this.statsRequest = null;
    this.stats = { requestedBytes: 0, browserBytes: 0, copiedBytes: 0, usefulValues: 0,
      cacheHits: 0, cacheMisses: 0, cacheEvictions: 0, sparseReads: 0,
      cancelledRequests: 0, rejectedRequests: 0, staleResults: 0,
      queuedRequests: 0, activeRequests: 0, queuedBytes: 0, inflightBytes: 0,
      logicalBytesReserved: 0, peakLogicalBytes: 0,
      peakQueuedBytes: 0, peakInflightBytes: 0, peakQueuedRequests: 0, queueWaitMs: 0 };
    this.workerFactory = options.workerFactory;
    const wasmBytes = cloneWasmBytes(options.wasmBytes);
    this.ready = this.#open(wasmBytes).catch((error) => { this.#fatal(error); throw error; });
  }

  #createWorker() {
    if (this.workerFactory) return this.workerFactory();
    if (typeof Worker === "undefined") {
      throw new Error("fmap requires dedicated Web Worker support.");
    }
    return new InlineFmapWorker();
  }

  async #open(wasmBytes) {
    this.worker = this.#createWorker();
    this.worker.onmessage = (event) => this.#handleMessage(event.data || {});
    this.worker.onerror = () => this.#fatal(new Error("fmap worker crashed."));
    const opened = await this.#enqueue("open", {
      protocolVersion: FMAP_PROTOCOL_VERSION, file: this.file,
      mode: this.mode,
      meta: this.meta ? rasterDescriptor(this.meta) : null,
      pageSize: this.pageSize, poolBytes: this.residentBytes, maxResultBytes: this.maxResultBytes,
      batchBytes: this.batchBytes, sparseReadThresholdBytes: this.sparseReadThresholdBytes,
      sparseReadMaxGapBytes: this.sparseReadMaxGapBytes,
      maxCoalescedOverreadRatio: this.maxCoalescedOverreadRatio,
      readConcurrency: this.concurrency, maxQueuedRequests: this.maxQueuedRequests,
      maxQueuedBytes: this.maxQueuedBytes, wasmBytes
    }, 0, {}, [wasmBytes]);
    this.residentBytes = opened.residentBytes;
    this.readySettled = true;
    this.worker.postMessage({ type: "setConcurrency", generation: this.generation, readConcurrency: this.concurrency });
    this.#pump();
    return opened;
  }

  #mergeStats(stats) {
    for (const [key, value] of Object.entries(stats || {})) {
      if (Number.isFinite(Number(value)) && !["cancelledRequests", "queuedRequests", "activeRequests", "inflightBytes"].includes(key)) {
        this.stats[key] = Number(value);
      }
    }
  }

  #updateStats() {
    this.active = [...this.pending.values()].filter((request) => !controlTypes.has(request.type)).length;
    this.stats.activeRequests = this.active;
    this.stats.inflightRequests = this.active;
    this.stats.queuedRequests = this.queue.length;
    this.stats.queuedBytes = this.queue.reduce((sum, request) => sum + request.bytes, 0);
    this.stats.inflightBytes = [...this.pending.values()].reduce((sum, request) => sum + request.bytes, 0);
    this.stats.peakQueuedBytes = Math.max(this.stats.peakQueuedBytes, this.stats.queuedBytes);
    this.stats.peakQueuedRequests = Math.max(this.stats.peakQueuedRequests, this.queue.length);
    this.stats.peakInflightBytes = Math.max(this.stats.peakInflightBytes, this.stats.inflightBytes);
    this.stats.waitingRequests = this.waitingRequests.length;
    this.stats.waitingLogicalRequests = this.logicalWaiters.length;
  }

  #settle(request, error, result) {
    if (request.settled) return;
    request.settled = true;
    request.signal?.removeEventListener("abort", request.onAbort);
    if (error) request.reject(error);
    else request.resolve(result);
  }

  #cancel(request, reason = "Obsolete fmap request.") {
    if (request.cancelled) return;
    request.cancelled = true;
    this.stats.cancelledRequests += 1;
    this.#settle(request, createAbortError(reason));
    const index = this.queue.indexOf(request);
    if (index !== -1) this.queue.splice(index, 1);
    const waitingIndex = this.waitingRequests.indexOf(request);
    if (waitingIndex !== -1) this.waitingRequests.splice(waitingIndex, 1);
    // Hold active reservations until the worker acknowledges cancellation.
    if (this.pending.has(request.id)) this.worker?.postMessage({ type: "cancel", id: request.id, generation: request.generation });
    this.#updateStats();
  }

  #cancelledByCallback(request) {
    try { return !!request.cancelledCheck?.(); }
    catch (_error) {
      this.#cancel(request, "fmap cancellation callback failed.");
      return true;
    }
  }

  #handleMessage(data) {
    const request = this.pending.get(Number(data.id));
    if (!request) return;
    this.pending.delete(request.id);
    this.#mergeStats(data.result?.stats || data.stats);
    if (!request.cancelled && this.#cancelledByCallback(request)) this.#cancel(request);
    if (request.cancelled || request.generation !== this.generation) {
      this.stats.staleResults += data.result?.buffer ? 1 : 0;
      this.#settle(request, createAbortError());
    } else if (data.error) this.#settle(request, workerError(data.error));
    else this.#settle(request, null, data.result);
    this.#updateStats();
    this.#pump();
  }

  #watchCancellation() {
    if (this.pollTimer || this.closed) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      for (const request of [...this.waitingRequests, ...this.queue, ...this.pending.values()]) {
        if (request.cancelled) continue;
        if (this.#cancelledByCallback(request)) this.#cancel(request);
        else if (now() - request.createdAt > request.maxAgeMs) this.#cancel(request, "fmap request expired.");
      }
      this.#drainLogical();
      this.#pump();
    }, 16);
  }

  #beginLogicalRequest(options = {}) {
    const logical = { ...(options || {}), groupId: ++this.logicalRequestId, generation: this.generation,
      createdAt: now(), mappingIdentity: options?.mappingId ?? 1 };
    if (logical.supersedeKey != null) {
      this.latestSupersedeGroups.set(logical.supersedeKey, logical.groupId);
      for (const request of [...this.waitingRequests, ...this.queue, ...this.pending.values()]) {
        if (request.supersedeKey === logical.supersedeKey && request.groupId !== logical.groupId) this.#cancel(request);
      }
      this.#drainLogical();
      this.#pump();
    }
    return logical;
  }

  #requireLogicalCurrent(options) {
    if (this.closed) throw createAbortError("fmap source is closed.");
    if (options.mappingIdentity === 1 && this.mapping.released) throw createAbortError("fmap mapping is unmapped or has been released.");
    if (options.generation !== undefined && options.generation !== this.generation) throw createAbortError("fmap cache cleared.");
    if (options.signal?.aborted || options.cancelled?.()) throw createAbortError();
    if (now() - options.createdAt > (options.maxAgeMs ?? (options.priority === "background" ? 1000 : Infinity))) {
      throw createAbortError("fmap request expired.");
    }
    if (options.supersedeKey != null
      && this.latestSupersedeGroups.get(options.supersedeKey) !== options.groupId) {
      this.stats.cancelledRequests += 1;
      throw createAbortError("fmap request was superseded.");
    }
  }

  #enqueue(type, fields, outputBytes, options = {}, transfer = []) {
    options ||= {};
    if (this.closed) return Promise.reject(new Error("fmap source is closed."));
    try { this.#requireLogicalCurrent(options); } catch (error) { return Promise.reject(error); }
    if (options.supersedeKey != null
      && this.latestSupersedeGroups.get(options.supersedeKey) !== options.groupId) {
      this.stats.cancelledRequests += 1;
      return Promise.reject(createAbortError("fmap request was superseded."));
    }
    const bytes = controlTypes.has(type) || type === "configureRaster" ? 0 : outputBytes + this.pageSize;
    if (outputBytes > this.maxResultBytes || bytes > this.maxInflightBytes || bytes > this.maxQueuedBytes) {
      this.stats.rejectedRequests += 1;
      return Promise.reject(new RangeError("fmap result exceeds its request budget; split the operation into smaller windows."));
    }
    for (const request of [...this.waitingRequests, ...this.queue, ...this.pending.values()]) {
      if (!request.cancelled && (this.#cancelledByCallback(request) || now() - request.createdAt > request.maxAgeMs)) {
        this.#cancel(request);
      }
    }
    if (options.supersedeKey != null) {
      for (const request of [...this.waitingRequests, ...this.queue, ...this.pending.values()]) {
        if (request.supersedeKey === options.supersedeKey && request.groupId !== options.groupId) this.#cancel(request);
      }
    }
    return new Promise((resolve, reject) => {
      const request = { id: ++this.requestId, type, generation: this.generation, fields, transfer,
        bytes, resolve, reject, priority: options.priority === "background" ? 1 : 0,
        maxAgeMs: options.maxAgeMs ?? (options.priority === "background" ? 1000 : Infinity),
        createdAt: now(), supersedeKey: options.supersedeKey, signal: options.signal,
        groupId: options.groupId, mappingIdentity: options.mappingIdentity,
        cancelledCheck: options.cancelled, cancelled: false, settled: false };
      request.onAbort = () => { this.#cancel(request); this.#pump(); };
      request.signal?.addEventListener("abort", request.onAbort, { once: true });
      this.waitingRequests.push(request);
      this.waitingRequests.sort((a, b) => a.priority - b.priority || a.id - b.id);
      this.#updateStats();
      this.#pump();
    });
  }

  #pump() {
    if (!this.worker || this.closed) return;
    // Mapping release must reach the worker even when every data execution
    // slot is occupied: it may be the operation which cancels those reads.
    for (const request of [...this.waitingRequests]) {
      if (!controlTypes.has(request.type) || (request.type !== "open" && !this.readySettled)) continue;
      this.waitingRequests.splice(this.waitingRequests.indexOf(request), 1);
      this.#dispatch(request);
    }
    this.#admitRequests();
    const foregroundLogical = this.logicalWaiters.find((waiter) => waiter.options.priority !== "background");
    if (foregroundLogical && this.logicalBytesReserved + foregroundLogical.bytes > this.maxLogicalBytes) {
      const speculative = [...this.pending.values(), ...this.queue, ...this.waitingRequests]
        .find((request) => request.priority === 1 && !request.cancelled);
      if (speculative) this.#cancel(speculative, "fmap background output yielded to foreground work.");
    }
    const foreground = [...this.queue, ...this.waitingRequests].find((request) => request.priority === 0 && request.type !== "stats");
    if (foreground && (this.active >= this.concurrency
      || foreground.bytes + this.stats.inflightBytes > this.maxInflightBytes)) {
      const speculative = [...this.pending.values()].find((request) => request.priority === 1 && !request.cancelled);
      if (speculative) this.#cancel(speculative, "fmap background work yielded to foreground work.");
    }
    while (this.queue.length) {
      const foregroundWaiting = this.queue.some((request) => request.priority === 0 && request.type !== "stats");
      const index = this.queue.findIndex((request) => (request.type === "open" || this.readySettled)
        && (!foregroundWaiting || request.priority === 0 || request.type === "stats")
        && request.bytes + this.stats.inflightBytes <= this.maxInflightBytes
        && (request.type === "stats" || (this.active < this.concurrency
          && (request.priority === 0 || this.active < Math.max(1, this.concurrency - 1)))));
      if (index === -1) break;
      const request = this.queue.splice(index, 1)[0];
      if (now() - request.createdAt > request.maxAgeMs || this.#cancelledByCallback(request)) {
        this.#cancel(request, "Obsolete fmap request.");
        continue;
      }
      this.#dispatch(request);
      this.#admitRequests();
    }
    if ([...this.waitingRequests, ...this.queue, ...this.pending.values()].some((request) => !request.cancelled
      && (request.cancelledCheck || Number.isFinite(request.maxAgeMs)))
      || this.logicalWaiters.some((waiter) => waiter.options.cancelled || Number.isFinite(waiter.options.maxAgeMs)
        || waiter.options.priority === "background")) this.#watchCancellation();
  }

  #dispatch(request) {
    this.pending.set(request.id, request);
    this.stats.queueWaitMs += now() - request.createdAt;
    this.#updateStats();
    try {
      this.worker.postMessage({ id: request.id, type: request.type, generation: request.generation,
        priority: request.priority, ...request.fields }, request.transfer);
    } catch (error) {
      this.pending.delete(request.id);
      this.#settle(request, error);
      this.#updateStats();
    }
  }

  #admitRequests() {
    while (this.waitingRequests.length) {
      const request = this.waitingRequests[0];
      if (now() - request.createdAt > request.maxAgeMs || this.#cancelledByCallback(request)) {
        this.#cancel(request);
        continue;
      }
      while (request.priority === 0 && (this.queue.length >= this.maxQueuedRequests
        || this.stats.queuedBytes + request.bytes > this.maxQueuedBytes)) {
        const speculative = this.queue.findLast((queued) => queued.priority === 1);
        if (!speculative) break;
        this.#cancel(speculative, "fmap background queue yielded to foreground work.");
      }
      if (this.queue.length >= this.maxQueuedRequests || this.stats.queuedBytes + request.bytes > this.maxQueuedBytes) break;
      this.waitingRequests.shift();
      this.queue.push(request);
      this.queue.sort((a, b) => a.priority - b.priority || a.id - b.id);
      this.#updateStats();
    }
  }

  #fatal(error) {
    for (const request of [...this.waitingRequests, ...this.queue, ...this.pending.values()]) this.#settle(request, error);
    this.waitingRequests.length = 0;
    for (const waiter of this.logicalWaiters.splice(0)) { waiter.cleanup(); waiter.reject(error); }
    this.queue.length = 0;
    this.pending.clear();
    this.#dispose();
    this.#updateStats();
  }

  #dispose() {
    this.closed = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.worker?.terminate();
    this.worker = null;
    this.file = null;
    this.size = 0;
  }

  #maxChunkValues(bytesPerValue) {
    const reservationBytes = Math.min(this.maxInflightBytes, this.maxQueuedBytes) - this.pageSize;
    const chunkBytes = Math.min(this.maxResultBytes, reservationBytes);
    const values = Math.floor(chunkBytes / bytesPerValue);
    if (values < 1) throw new RangeError("fmap request limits cannot admit one result value.");
    return values;
  }

  #reserveLogical(bytes, options) {
    if (bytes > this.maxLogicalResultBytes || bytes > this.maxLogicalBytes) {
      this.stats.rejectedRequests += 1;
      throw new RangeError("fmap logical result exceeds its bounded assembly budget.");
    }
    if (this.logicalWaiters.length || this.logicalBytesReserved + bytes > this.maxLogicalBytes) {
      return new Promise((resolve, reject) => {
        const waiter = { bytes, options, resolve, reject, cleanup: () => {} };
        const abort = () => { this.#drainLogical(); this.#pump(); };
        waiter.cleanup = () => options.signal?.removeEventListener("abort", abort);
        options.signal?.addEventListener("abort", abort, { once: true });
        this.logicalWaiters.push(waiter);
        this.logicalWaiters.sort((a, b) => (a.options.priority === "background") - (b.options.priority === "background")
          || a.options.groupId - b.options.groupId);
        this.#drainLogical();
        this.#pump();
      });
    }
    this.#chargeLogical(bytes);
    return null;
  }

  #chargeLogical(bytes) {
    this.logicalBytesReserved += bytes;
    this.stats.logicalBytesReserved = this.logicalBytesReserved;
    this.stats.peakLogicalBytes = Math.max(this.stats.peakLogicalBytes, this.logicalBytesReserved);
  }

  #drainLogical() {
    for (const waiter of [...this.logicalWaiters]) {
      try { this.#requireLogicalCurrent(waiter.options); }
      catch (error) {
        this.logicalWaiters.splice(this.logicalWaiters.indexOf(waiter), 1);
        waiter.cleanup();
        waiter.reject(error);
      }
    }
    while (this.logicalWaiters.length) {
      const waiter = this.logicalWaiters[0];
      if (this.logicalBytesReserved + waiter.bytes > this.maxLogicalBytes) break;
      this.logicalWaiters.shift();
      waiter.cleanup();
      this.#chargeLogical(waiter.bytes);
      waiter.resolve();
    }
    this.#updateStats();
  }

  #releaseLogical(bytes) {
    this.logicalBytesReserved = Math.max(0, this.logicalBytesReserved - bytes);
    this.stats.logicalBytesReserved = this.logicalBytesReserved;
    this.#drainLogical();
    this.#pump();
  }

  #cancelMapping(mappingId) {
    const error = createAbortError("fmap mapping has been released.");
    for (const waiter of [...this.logicalWaiters]) {
      if (waiter.options.mappingIdentity !== mappingId) continue;
      this.logicalWaiters.splice(this.logicalWaiters.indexOf(waiter), 1);
      waiter.cleanup();
      waiter.reject(error);
    }
    for (const request of [...this.waitingRequests, ...this.queue, ...this.pending.values()]) {
      if (request.mappingIdentity === mappingId) this.#cancel(request, error.message);
    }
    this.#updateStats();
    this.#pump();
  }

  /** Bind a validated linear TIFF raster to this same file session and pool. */
  async configureRaster(meta) {
    await this.ready;
    if (this.mode !== "range") throw new Error("fmap raster metadata is already configured.");
    assertFmapEnviMeta(meta, this.size);
    await this.#enqueue("configureRaster", { meta: rasterDescriptor(meta) }, 0);
    this.meta = meta;
    this.mode = "envi";
    this.managesWindowOutput = true;
    return this;
  }

  /** Map file bytes without loading them. Virtual bases share one aligned grid. */
  map(options) { return this.mappings.map(options); }

  async readBandWindow(meta, band, x0, y0, outW, outH, step, out = null, options = {}) {
    await this.ready;
    const window = normalizeFmapWindow(meta, x0, y0, outW, outH, step);
    const Ctor = windowCtor(meta);
    const totalValues = window.requestedW * window.requestedH;
    const outputElementBytes = out && out.length >= totalValues && Number(out.BYTES_PER_ELEMENT)
      ? Number(out.BYTES_PER_ELEMENT) : Ctor.BYTES_PER_ELEMENT;
    const logicalBytes = checkedResultBytes(window.requestedW, window.requestedH, outputElementBytes);
    const logicalOptions = this.#beginLogicalRequest(options);
    if (logicalOptions.supersedeKey != null) await Promise.resolve();
    this.#requireLogicalCurrent(logicalOptions);
    const admission = this.#reserveLogical(logicalBytes, logicalOptions);
    if (admission) await admission;
    try {
      this.#requireLogicalCurrent(logicalOptions);
      const values = out && out.length >= totalValues ? out : new Ctor(totalValues);
      if (!window.outW || !window.outH) return values;

      const bytesPerTransportValue = transportBytes(meta);
      const maxValues = this.#maxChunkValues(bytesPerTransportValue);
      if (window.outW <= maxValues) {
        const rowsPerChunk = Math.max(1, Math.floor(maxValues / window.outW));
        for (let row = 0; row < window.outH; row += rowsPerChunk) {
          const height = Math.min(rowsPerChunk, window.outH - row);
          const result = await this.#enqueue("window", {
            band, x0: window.x0, y0: window.y0 + (row * window.step), outW: window.outW,
            outH: height, requestedW: window.outW, requestedH: height, step: window.step
          }, checkedResultBytes(window.outW, height, bytesPerTransportValue), logicalOptions);
          const chunk = new (transportCtor(meta))(result.buffer);
          for (let chunkRow = 0; chunkRow < height; chunkRow += 1) {
            const srcStart = chunkRow * window.outW;
            const dstStart = (row + chunkRow) * window.requestedW;
            values.set(chunk.subarray(srcStart, srcStart + window.outW), dstStart);
          }
        }
      } else {
        for (let row = 0; row < window.outH; row += 1) {
          for (let col = 0; col < window.outW; col += maxValues) {
            const width = Math.min(maxValues, window.outW - col);
            const result = await this.#enqueue("window", {
              band, x0: window.x0 + (col * window.step), y0: window.y0 + (row * window.step),
              outW: width, outH: 1, requestedW: width, requestedH: 1, step: window.step
            }, checkedResultBytes(width, 1, bytesPerTransportValue), logicalOptions);
            values.set(new (transportCtor(meta))(result.buffer), (row * window.requestedW) + col);
          }
        }
      }
      return values;
    } finally {
      this.#releaseLogical(logicalBytes);
    }
  }

  async readSpectrumAtPixel(meta, x, y, options = {}, extraOptions = null) {
    await this.ready;
    if (typeof options !== "object" || !options) options = extraOptions || {};
    const logicalBytes = checkedResultBytes(meta.bands, 1, Float32Array.BYTES_PER_ELEMENT);
    const logicalOptions = this.#beginLogicalRequest(options);
    if (logicalOptions.supersedeKey != null) await Promise.resolve();
    this.#requireLogicalCurrent(logicalOptions);
    const admission = this.#reserveLogical(logicalBytes, logicalOptions);
    if (admission) await admission;
    try {
      this.#requireLogicalCurrent(logicalOptions);
      const values = new Float32Array(meta.bands);
      const bytesPerTransportValue = transportBytes(meta);
      const maxValues = this.#maxChunkValues(bytesPerTransportValue);
      for (let bandStart = 0; bandStart < meta.bands; bandStart += maxValues) {
        const bandCount = Math.min(maxValues, meta.bands - bandStart);
        const result = await this.#enqueue("spectrum", { x, y, bandStart, bandCount },
          checkedResultBytes(bandCount, 1, bytesPerTransportValue), logicalOptions);
        values.set(new (transportCtor(meta))(result.buffer), bandStart);
      }
      return values;
    } finally {
      this.#releaseLogical(logicalBytes);
    }
  }

  async readRange(offset, length, out = null, options = {}) {
    await this.ready;
    const start = Number(offset);
    const count = Number(length);
    const end = checkedAdd(start, count, "fmap raw range");
    if (end > this.size) throw new RangeError(`fmap raw range exceeds EOF (${end} > ${this.size}).`);
    const logicalOptions = this.#beginLogicalRequest(options);
    if (logicalOptions.supersedeKey != null) await Promise.resolve();
    this.#requireLogicalCurrent(logicalOptions);
    const admission = this.#reserveLogical(count, logicalOptions);
    if (admission) await admission;
    try {
      this.#requireLogicalCurrent(logicalOptions);
      const values = out && out.length >= count ? out : new Uint8Array(count);
      const maxValues = this.#maxChunkValues(1);
      if (!count) {
        await this.#enqueue("range", { offset: start, length: 0,
          ...(logicalOptions.mappingId != null ? {
            mappingId: logicalOptions.mappingId, virtualAddress: logicalOptions.virtualAddress
          } : {}) }, 0, logicalOptions);
      }
      for (let written = 0; written < count; written += maxValues) {
        const chunkLength = Math.min(maxValues, count - written);
        const result = await this.#enqueue("range", { offset: start + written, length: chunkLength,
          ...(logicalOptions.mappingId != null ? {
            mappingId: logicalOptions.mappingId, virtualAddress: checkedAdd(logicalOptions.virtualAddress, written, "mapped chunk address")
          } : {}) },
          chunkLength, logicalOptions);
        values.set(new Uint8Array(result.buffer), written);
      }
      return values;
    } finally {
      this.#releaseLogical(count);
    }
  }

  getStats() {
    if (!this.statsRequest) {
      const pending = this.ready.then(() => this.#enqueue("stats", {}, 0))
        .then(() => ({ ...this.stats }))
        .finally(() => { if (this.statsRequest === pending) this.statsRequest = null; });
      this.statsRequest = pending;
    }
    return this.statsRequest.then((snapshot) => ({ ...snapshot }));
  }

  estimateReadWork(meta, _band, x0, y0, outW, outH, step) {
    const window = normalizeFmapWindow(meta, x0, y0, outW, outH, step);
    const bytes = Number(meta?.dataTypeInfo?.bytes) || 1;
    const pixelStride = meta?.interleave === "bip" ? bytes * meta.bands : bytes;
    const rowBytes = window.outW ? (((window.outW - 1) * window.step * pixelStride) + bytes) : 0;
    const usefulBytes = window.outW * window.outH * bytes;
    return { estimatedBytes: rowBytes * window.outH, spanReads: window.outH,
      sparseRaw: rowBytes * window.outH > usefulBytes * 4, previewFactor: 1 };
  }

  setConcurrency(value) {
    this.concurrency = limit(value, 1);
    if (this.readySettled) {
      this.worker?.postMessage({ type: "setConcurrency", generation: this.generation, readConcurrency: this.concurrency });
    }
    this.#pump();
  }
  setMaxBytes(value) { if (Number.isSafeInteger(value) && value >= this.pageSize) this.requestedMaxBytes = value; }
  cacheBytes() { return this.closed ? 0 : this.residentBytes; }

  clear() {
    if (this.closed) return;
    // No cache/work can exist before open is acknowledged. Do not cancel the
    // initialization handshake or send controls to a not-yet-created queue.
    if (!this.readySettled) return;
    this.generation += 1;
    this.statsRequest = null;
    this.latestSupersedeGroups.clear();
    for (const request of [...this.waitingRequests, ...this.queue, ...this.pending.values()]) {
      // Cache generations retire byte reads, not mapping lifetimes. A mapping
      // control already posted precedes clear in worker message order; keep its
      // acknowledgement so a committed mapping cannot become an orphan.
      if (request.type === "mapRegion" || request.type === "unmapRegion") request.generation = this.generation;
      else this.#cancel(request, "fmap cache cleared.");
    }
    this.#drainLogical();
    this.worker.postMessage({ id: ++this.requestId, type: "clear", generation: this.generation });
    this.#updateStats();
  }

  close() {
    if (this.closed) return;
    this.generation += 1;
    this.#fatal(createAbortError("fmap source closed."));
  }
}

export function createFmapDataSource(file, meta, options = {}) { return new FmapDataSource(file, meta, options); }

/** Neutral bounded range source for format decoders such as TIFF. */
export class FmapRangeDataSource extends FmapDataSource {
  constructor(file, options = {}) {
    super(file, null, { ...options, mode: "range" });
  }
}

export function createFmapRangeDataSource(file, options = {}) {
  return new FmapRangeDataSource(file, options);
}
