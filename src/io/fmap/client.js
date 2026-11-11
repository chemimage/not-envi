import fmapWorkerSource from "./fmap.worker.js?raw";
import {
  FMAP_PROTOCOL_VERSION, assertFmapBsqFloat32Meta, checkedResultBytes,
  createAbortError, normalizeFmapWindow
} from "./protocol.js";

let nextSourceId = 1;
const now = () => performance.now();

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

/**
 * A per-open BSQ Float32 source backed by a dedicated C/WASM worker.
 *
 * The selected File remains the backing store. The worker owns resident pages;
 * callers receive owned Float32 results, never views into evictable WASM pages.
 * Queue and active-byte limits are per source, not a whole-application budget.
 * Results above maxResultBytes must be split by the caller.
 *
 * Window/spectrum options accept signal, cancelled(), priority, supersedeKey,
 * and maxAgeMs. Cancellation rejects immediately, but an active reservation is
 * released only after a worker reply. clear() advances the source generation;
 * close() terminates the worker. setMaxBytes() records a requested budget;
 * shrinking allocated WASM memory requires worker recreation.
 *
 * Status and follow-up work: https://github.com/chemimage/Hyve/issues/20
 */
export class FmapDataSource {
  constructor(file, meta, options = {}) {
    if (!(file instanceof Blob)) throw new TypeError("fmap requires a user-selected File or Blob.");
    assertFmapBsqFloat32Meta(meta, file.size);
    this.pageSize = limit(options.pageSize, 256 * 1024, 4096);
    this.maxBytes = limit(options.poolBytes, 64 * 1024 * 1024, this.pageSize);
    this.maxResultBytes = limit(options.maxResultBytes, 4 * 1024 * 1024);
    this.maxInflightBytes = limit(options.maxInflightBytes, 8 * 1024 * 1024, this.pageSize + 4);
    this.maxQueuedBytes = limit(options.maxQueuedBytes, 32 * 1024 * 1024);
    this.maxQueuedRequests = limit(options.maxQueuedRequests, 64);
    this.batchBytes = Math.min(this.pageSize, limit(options.batchBytes, 64 * 1024));
    this.sparseReadThresholdBytes = limit(options.sparseReadThresholdBytes, Math.min(32 * 1024, this.pageSize / 8), 0);
    this.sparseReadMaxGapBytes = limit(options.sparseReadMaxGapBytes, 4096, 0);
    this.file = file;
    this.meta = meta;
    this.size = file.size;
    this.ownerId = `fmap:${nextSourceId++}`;
    this.chunkSize = this.pageSize;
    this.residentBytes = Math.floor(this.maxBytes / this.pageSize) * this.pageSize;
    this.requestedMaxBytes = this.maxBytes;
    this.concurrency = limit(options.concurrency, 2);
    this.generation = 1;
    this.closed = false;
    this.worker = null;
    this.workerUrl = "";
    this.requestId = 0;
    this.active = 0;
    this.queue = [];
    this.pending = new Map();
    this.pollTimer = null;
    this.stats = { requestedBytes: 0, browserBytes: 0, copiedBytes: 0, usefulValues: 0,
      cacheHits: 0, cacheMisses: 0, cacheEvictions: 0, sparseReads: 0,
      cancelledRequests: 0, rejectedRequests: 0, staleResults: 0,
      queuedRequests: 0, activeRequests: 0, queuedBytes: 0, inflightBytes: 0,
      peakQueuedBytes: 0, peakInflightBytes: 0, peakQueuedRequests: 0, queueWaitMs: 0 };
    this.workerFactory = options.workerFactory;
    const wasmBytes = cloneWasmBytes(options.wasmBytes);
    this.ready = this.#open(wasmBytes).catch((error) => { this.#fatal(error); throw error; });
  }

  #createWorker() {
    if (this.workerFactory) return this.workerFactory();
    if (typeof Worker === "undefined" || typeof URL.createObjectURL !== "function") {
      throw new Error("fmap requires dedicated Web Worker support.");
    }
    this.workerUrl = URL.createObjectURL(new Blob([fmapWorkerSource], { type: "text/javascript" }));
    return new Worker(this.workerUrl);
  }

  async #open(wasmBytes) {
    this.worker = this.#createWorker();
    this.worker.onmessage = (event) => this.#handleMessage(event.data || {});
    this.worker.onerror = () => this.#fatal(new Error("fmap worker crashed."));
    const opened = await this.#enqueue("open", {
      protocolVersion: FMAP_PROTOCOL_VERSION, file: this.file,
      meta: { samples: this.meta.samples, lines: this.meta.lines, bands: this.meta.bands,
        headerOffset: this.meta.headerOffset, littleEndian: this.meta.littleEndian },
      pageSize: this.pageSize, poolBytes: this.maxBytes, maxResultBytes: this.maxResultBytes,
      batchBytes: this.batchBytes, sparseReadThresholdBytes: this.sparseReadThresholdBytes,
      sparseReadMaxGapBytes: this.sparseReadMaxGapBytes, wasmBytes
    }, 0, {}, [wasmBytes]);
    this.residentBytes = opened.residentBytes;
    this.readySettled = true;
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
    this.active = [...this.pending.values()].filter((request) => request.type !== "stats").length;
    this.stats.activeRequests = this.active;
    this.stats.inflightRequests = this.active;
    this.stats.queuedRequests = this.queue.length;
    this.stats.queuedBytes = this.queue.reduce((sum, request) => sum + request.bytes, 0);
    this.stats.inflightBytes = [...this.pending.values()].reduce((sum, request) => sum + request.bytes, 0);
    this.stats.peakQueuedBytes = Math.max(this.stats.peakQueuedBytes, this.stats.queuedBytes);
    this.stats.peakQueuedRequests = Math.max(this.stats.peakQueuedRequests, this.queue.length);
    this.stats.peakInflightBytes = Math.max(this.stats.peakInflightBytes, this.stats.inflightBytes);
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
    // Hold active reservations until the worker acknowledges cancellation.
    if (this.pending.has(request.id)) this.worker?.postMessage({ type: "cancel", id: request.id, generation: request.generation });
    this.#updateStats();
  }

  #handleMessage(data) {
    const request = this.pending.get(Number(data.id));
    if (!request) return;
    this.pending.delete(request.id);
    this.#mergeStats(data.result?.stats || data.stats);
    if (!request.cancelled && request.cancelledCheck?.()) this.#cancel(request);
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
      for (const request of [...this.queue, ...this.pending.values()]) {
        if (request.cancelled) continue;
        if (request.cancelledCheck?.()) this.#cancel(request);
        else if (now() - request.createdAt > request.maxAgeMs) this.#cancel(request, "fmap request expired.");
      }
      this.#pump();
    }, 16);
  }

  #enqueue(type, fields, outputBytes, options = {}, transfer = []) {
    options ||= {};
    if (this.closed) return Promise.reject(new Error("fmap source is closed."));
    if (options.signal?.aborted || options.cancelled?.()) return Promise.reject(createAbortError());
    const bytes = type === "open" || type === "stats" ? 0 : outputBytes + this.pageSize;
    if (outputBytes > this.maxResultBytes || bytes > this.maxInflightBytes) {
      this.stats.rejectedRequests += 1;
      return Promise.reject(new RangeError("fmap result exceeds its request budget; split the operation into smaller windows."));
    }
    for (const request of [...this.queue, ...this.pending.values()]) {
      if (!request.cancelled && (request.cancelledCheck?.() || now() - request.createdAt > request.maxAgeMs)) {
        this.#cancel(request);
      }
    }
    if (options.supersedeKey != null) {
      for (const request of [...this.queue, ...this.pending.values()]) {
        if (request.supersedeKey === options.supersedeKey) this.#cancel(request);
      }
    }
    if (options.priority !== "background") {
      while (this.queue.length >= this.maxQueuedRequests || this.stats.queuedBytes + bytes > this.maxQueuedBytes) {
        const speculative = this.queue.findLast((request) => request.priority === 1);
        if (!speculative) break;
        this.#cancel(speculative, "fmap background queue yielded to foreground work.");
      }
    }
    if (this.queue.length >= this.maxQueuedRequests || this.stats.queuedBytes + bytes > this.maxQueuedBytes) {
      this.stats.rejectedRequests += 1;
      return Promise.reject(createAbortError("fmap request queue is full."));
    }
    return new Promise((resolve, reject) => {
      const request = { id: ++this.requestId, type, generation: this.generation, fields, transfer,
        bytes, resolve, reject, priority: options.priority === "background" ? 1 : 0,
        maxAgeMs: options.maxAgeMs ?? (options.priority === "background" ? 1000 : Infinity),
        createdAt: now(), supersedeKey: options.supersedeKey, signal: options.signal,
        cancelledCheck: options.cancelled, cancelled: false, settled: false };
      request.onAbort = () => { this.#cancel(request); this.#pump(); };
      request.signal?.addEventListener("abort", request.onAbort, { once: true });
      this.queue.push(request);
      this.queue.sort((a, b) => a.priority - b.priority || a.id - b.id);
      this.#updateStats();
      this.#pump();
    });
  }

  #pump() {
    if (!this.worker || this.closed) return;
    const foreground = this.queue.find((request) => request.priority === 0 && request.type !== "stats");
    if (foreground && (this.active >= this.concurrency
      || foreground.bytes + this.stats.inflightBytes > this.maxInflightBytes)) {
      const speculative = [...this.pending.values()].find((request) => request.priority === 1 && !request.cancelled);
      if (speculative) this.#cancel(speculative, "fmap background work yielded to foreground work.");
    }
    while (this.queue.length) {
      const index = this.queue.findIndex((request) => (request.type === "open" || this.readySettled)
        && request.bytes + this.stats.inflightBytes <= this.maxInflightBytes
        && (request.type === "stats" || (this.active < this.concurrency
          && (request.priority === 0 || this.active < Math.max(1, this.concurrency - 1)))));
      if (index === -1) break;
      const request = this.queue.splice(index, 1)[0];
      if (now() - request.createdAt > request.maxAgeMs || request.cancelledCheck?.()) {
        this.#cancel(request, "Obsolete fmap request.");
        continue;
      }
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
    if ([...this.queue, ...this.pending.values()].some((request) => !request.cancelled
      && (request.cancelledCheck || Number.isFinite(request.maxAgeMs)))) this.#watchCancellation();
  }

  #fatal(error) {
    for (const request of [...this.queue, ...this.pending.values()]) this.#settle(request, error);
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
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.worker = null;
    this.workerUrl = "";
    this.file = null;
    this.size = 0;
  }

  async readBandWindow(meta, band, x0, y0, outW, outH, step, out = null, options = {}) {
    await this.ready;
    const window = normalizeFmapWindow(meta, x0, y0, outW, outH, step);
    const result = await this.#enqueue("window", { band, ...window }, checkedResultBytes(window.requestedW, window.requestedH), options);
    const values = new Float32Array(result.buffer);
    if (out && out.length >= values.length) { out.set(values); return out; }
    return values;
  }

  async readSpectrumAtPixel(meta, x, y, options = {}, extraOptions = null) {
    await this.ready;
    if (typeof options !== "object" || !options) options = extraOptions || {};
    const result = await this.#enqueue("spectrum", { x, y }, checkedResultBytes(meta.bands), options);
    return new Float32Array(result.buffer);
  }

  async getStats() {
    await this.ready;
    await this.#enqueue("stats", {}, 0);
    return { ...this.stats };
  }

  estimateReadWork(meta, _band, x0, y0, outW, outH, step) {
    const window = normalizeFmapWindow(meta, x0, y0, outW, outH, step);
    const rowBytes = window.outW ? (((window.outW - 1) * window.step) + 1) * 4 : 0;
    return { estimatedBytes: rowBytes * window.outH, spanReads: window.outH,
      sparseRaw: window.step > 1, previewFactor: 1 };
  }

  setConcurrency(value) { this.concurrency = limit(value, 1); this.#pump(); }
  setMaxBytes(value) { if (Number.isSafeInteger(value) && value >= this.pageSize) this.requestedMaxBytes = value; }
  cacheBytes() { return this.closed ? 0 : this.residentBytes; }

  clear() {
    if (this.closed) return;
    this.generation += 1;
    for (const request of [...this.queue, ...this.pending.values()]) this.#cancel(request, "fmap cache cleared.");
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
