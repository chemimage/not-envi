import fmapWorkerSource from "./fmap.worker.js?raw";
import {
  FMAP_PROTOCOL_VERSION,
  assertFmapBsqFloat32Meta,
  createAbortError,
  normalizeFmapWindow
} from "./protocol.js";

let nextSourceId = 1;

function errorFromWorker(raw) {
  const error = new Error(String(raw?.message || "fmap worker request failed"));
  error.name = String(raw?.name || "Error");
  return error;
}

function cloneWasmBytes(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes.slice(0);
  if (ArrayBuffer.isView(bytes)) return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return null;
}

export class FmapDataSource {
  constructor(file, meta, options = {}) {
    if (!(file instanceof Blob)) throw new TypeError("fmap requires a user-selected File or Blob.");
    assertFmapBsqFloat32Meta(meta, file.size);
    this.file = file;
    this.meta = meta;
    this.size = file.size;
    this.ownerId = `fmap:${nextSourceId++}`;
    this.pageSize = Math.max(4096, Math.floor(Number(options.pageSize) || (64 * 1024)));
    this.maxBytes = Math.max(this.pageSize, Math.floor(Number(options.poolBytes) || (64 * 1024 * 1024)));
    this.residentBytes = this.maxBytes;
    this.requestedMaxBytes = this.maxBytes;
    this.concurrency = Math.max(1, Math.floor(Number(options.concurrency) || 2));
    this.generation = 1;
    this.closed = false;
    this.worker = null;
    this.workerUrl = "";
    this.requestId = 0;
    this.active = 0;
    this.queue = [];
    this.pending = new Map();
    this.stats = {
      requestedBytes: 0,
      browserBytes: 0,
      copiedBytes: 0,
      usefulValues: 0,
      cacheHits: 0,
      cacheMisses: 0,
      cacheEvictions: 0,
      queuedRequests: 0,
      activeRequests: 0
    };
    this.workerFactory = options.workerFactory || null;
    const wasmBytes = cloneWasmBytes(options.wasmBytes);
    if (!wasmBytes) throw new Error("fmap WASM artifact is unavailable.");
    this.ready = this.#open(wasmBytes);
  }

  #createWorker() {
    if (this.workerFactory) return this.workerFactory();
    if (
      typeof Worker === "undefined"
      || typeof Blob === "undefined"
      || typeof URL === "undefined"
      || typeof URL.createObjectURL !== "function"
      || !String(fmapWorkerSource || "").trim()
    ) {
      throw new Error("fmap requires dedicated Web Worker support.");
    }
    const blob = new Blob([String(fmapWorkerSource)], { type: "text/javascript" });
    this.workerUrl = URL.createObjectURL(blob);
    return new Worker(this.workerUrl);
  }

  async #open(wasmBytes) {
    this.worker = this.#createWorker();
    this.worker.onmessage = (event) => this.#handleMessage(event?.data || {});
    this.worker.onerror = (event) => this.#failAll(event instanceof Error ? event : new Error("fmap worker crashed."));
    const opened = await this.#enqueue("open", {
      protocolVersion: FMAP_PROTOCOL_VERSION,
      file: this.file,
      meta: {
        samples: this.meta.samples,
        lines: this.meta.lines,
        bands: this.meta.bands,
        headerOffset: this.meta.headerOffset,
        littleEndian: this.meta.littleEndian
      },
      pageSize: this.pageSize,
      poolBytes: this.maxBytes,
      wasmBytes
    }, [wasmBytes], true);
    const residentBytes = Number(opened?.residentBytes);
    if (Number.isFinite(residentBytes) && residentBytes > 0) this.residentBytes = residentBytes;
    return opened;
  }

  #handleMessage(data) {
    const id = Number(data.id);
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    this.active = Math.max(0, this.active - 1);
    this.#updateQueueStats();
    if (data.error) request.reject(errorFromWorker(data.error));
    else if (request.generation !== this.generation && request.type !== "open") request.reject(createAbortError("Stale fmap result discarded."));
    else {
      if (data.result?.stats) this.#mergeStats(data.result.stats);
      request.resolve(data.result);
    }
    this.#pump();
  }

  #mergeStats(stats) {
    for (const key of ["requestedBytes", "browserBytes", "copiedBytes", "usefulValues", "cacheHits", "cacheMisses", "cacheEvictions"]) {
      const value = Number(stats?.[key]);
      if (Number.isFinite(value)) this.stats[key] = value;
    }
  }

  #updateQueueStats() {
    this.stats.queuedRequests = this.queue.length;
    this.stats.activeRequests = this.active;
  }

  #enqueue(type, fields = {}, transfer = [], beforeReady = false) {
    if (this.closed) return Promise.reject(new Error("fmap source is closed."));
    return new Promise((resolve, reject) => {
      this.queue.push({
        id: ++this.requestId,
        type,
        generation: this.generation,
        fields,
        transfer,
        beforeReady,
        resolve,
        reject
      });
      this.#updateQueueStats();
      this.#pump();
    });
  }

  #pump() {
    if (!this.worker) return;
    while (this.active < this.concurrency && this.queue.length) {
      const request = this.queue[0];
      if (!request.beforeReady && this.ready && !this.readySettled) {
        this.ready.then(() => {
          this.readySettled = true;
          this.#pump();
        }, (error) => this.#failAll(error));
        return;
      }
      this.queue.shift();
      if (request.generation !== this.generation) {
        request.reject(createAbortError());
        continue;
      }
      this.active += 1;
      this.pending.set(request.id, request);
      this.#updateQueueStats();
      try {
        this.worker.postMessage({
          id: request.id,
          type: request.type,
          generation: request.generation,
          ...request.fields
        }, request.transfer);
      } catch (error) {
        this.pending.delete(request.id);
        this.active = Math.max(0, this.active - 1);
        request.reject(error);
      }
    }
  }

  #failAll(error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    for (const request of this.queue.splice(0)) request.reject(failure);
    for (const request of this.pending.values()) request.reject(failure);
    this.pending.clear();
    this.active = 0;
    this.#updateQueueStats();
  }

  async readBandWindow(meta, band, x0, y0, outW, outH, step, out = null) {
    await this.ready;
    this.readySettled = true;
    const window = normalizeFmapWindow(meta, x0, y0, outW, outH, step);
    const result = await this.#enqueue("window", { band, ...window });
    const values = new Float32Array(result.buffer);
    if (out && out.length >= values.length) {
      out.set(values);
      return out;
    }
    return values;
  }

  async readSpectrumAtPixel(meta, x, y) {
    await this.ready;
    this.readySettled = true;
    const result = await this.#enqueue("spectrum", { x, y });
    return new Float32Array(result.buffer);
  }

  estimateReadWork(meta, _band, x0, y0, outW, outH, step) {
    const window = normalizeFmapWindow(meta, x0, y0, outW, outH, step);
    const rowBytes = window.outW > 0 ? (((window.outW - 1) * window.step) + 1) * 4 : 0;
    return {
      estimatedBytes: rowBytes * window.outH,
      spanReads: window.outH,
      sparseRaw: window.step > 1,
      previewFactor: 1
    };
  }

  setConcurrency(value) {
    this.concurrency = Math.max(1, Math.floor(Number(value) || 1));
    this.#pump();
  }

  setMaxBytes(value) {
    const next = Math.floor(Number(value));
    if (Number.isFinite(next) && next >= this.pageSize) this.requestedMaxBytes = next;
  }

  cacheBytes() {
    return this.closed ? 0 : this.residentBytes;
  }

  clear() {
    if (this.closed) return;
    this.generation += 1;
    const error = createAbortError("fmap cache cleared.");
    for (const request of this.queue.splice(0)) request.reject(error);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.active = 0;
    this.worker?.postMessage({ id: ++this.requestId, type: "clear", generation: this.generation });
    this.#updateQueueStats();
  }

  close() {
    if (this.closed) return;
    this.generation += 1;
    this.closed = true;
    this.#failAll(createAbortError("fmap source closed."));
    try { this.worker?.postMessage({ id: ++this.requestId, type: "close", generation: this.generation }); } catch (_error) {}
    try { this.worker?.terminate(); } catch (_error) {}
    if (this.workerUrl) {
      try { URL.revokeObjectURL(this.workerUrl); } catch (_error) {}
    }
    this.worker = null;
    this.workerUrl = "";
    this.file = null;
    this.size = 0;
  }
}

export function createFmapDataSource(file, meta, options = {}) {
  return new FmapDataSource(file, meta, options);
}
