import { clamp } from "./utils.js";
import { APP_CONFIG, resolveHardwareConcurrencyLimit } from "../app/config.js";
import { cancelSharedTasks, scheduleSharedTask } from "./shared-scheduler.js";

let nextDataSourceOwnerId = 1;

function resolveOwnerId(source, options = {}) {
  const explicit = String(options?.ownerId || "").trim();
  if (explicit) return explicit;
  return `datasource:${nextDataSourceOwnerId++}`;
}

function normalizeRange(size, offset, length) {
  const sourceSize = Math.max(0, Number(size) || 0);
  const start = Math.max(0, Math.trunc(Number(offset) || 0));
  const requested = Math.max(0, Math.trunc(Number(length) || 0));
  if (start >= sourceSize || requested <= 0) return { offset: start, length: 0 };
  return {
    offset: start,
    length: Math.min(requested, sourceSize - start)
  };
}

export class BlobDataSource {
  constructor(file, options = {}) {
    this.file = file;
    this.size = file.size;
    this.ownerId = resolveOwnerId({ file }, options);
    this.bytesRead = 0;
    this.stats = createDataSourceStats();
    this.closed = false;
  }

  async read(offset, length) {
    if (this.closed || !this.file) throw new Error("Data source closed");
    const range = normalizeRange(this.size, offset, length);
    const safeOffset = range.offset;
    const safeLength = range.length;
    if (safeLength <= 0) return new Uint8Array(0);
    const end = safeOffset + safeLength;
    const slice = this.file.slice(safeOffset, end);
    const ab = await blobToArrayBuffer(slice);
    const u8 = new Uint8Array(ab);
    this.bytesRead += u8.byteLength;
    this.stats.readCalls += 1;
    this.stats.bytesRead = this.bytesRead;
    return u8;
  }

  async readInto(offset, dest, destOffset = 0, length = null) {
    if (this.closed || !this.file) throw new Error("Data source closed");
    if (!dest || typeof dest.byteLength !== "number") return 0;
    this.stats.readIntoCalls += 1;
    const dstOffset = Math.max(0, Number(destOffset) || 0);
    const maxLen = Math.max(0, dest.byteLength - dstOffset);
    const wantLen = length == null ? maxLen : Math.max(0, Math.min(maxLen, Number(length) || 0));
    if (wantLen <= 0) return 0;
    const u8 = await this.read(offset, wantLen);
    dest.set(u8, dstOffset);
    return u8.byteLength;
  }

  async visitPages(offset, length, visitor) {
    if (this.closed || !this.file) throw new Error("Data source closed");
    const range = normalizeRange(this.size, offset, length);
    const safeOffset = range.offset;
    const safeLength = range.length;
    if (safeLength <= 0 || typeof visitor !== "function") return 0;
    this.stats.visitPagesCalls += 1;
    const u8 = await this.read(safeOffset, safeLength);
    await visitor(u8, safeOffset);
    return u8.byteLength;
  }

  close() {
    this.closed = true;
    this.file = null;
    this.size = 0;
  }
}

export class ChunkCacheDataSource {
  constructor(source, options = {}) {
    this.source = source;
    this.size = source.size;
    this.ownerId = resolveOwnerId(source, options);
    this.chunkSize = Math.max(
      APP_CONFIG.dataSource.minChunkSizeBytes,
      Number(options.chunkSize) || APP_CONFIG.dataSource.defaultChunkSizeBytes
    );
    this.maxBytes = Math.max(
      this.chunkSize * 2,
      Number(options.maxBytes) || APP_CONFIG.dataSource.defaultMaxBytes
    );

    const defaultConcurrency = resolveHardwareConcurrencyLimit({
      fraction: APP_CONFIG.io.hardwareCoreFraction,
      min: APP_CONFIG.io.hardwareParallelMin,
      max: APP_CONFIG.io.maxConcurrency
    });
    this.concurrency = clamp(
      Number(options.concurrency) || defaultConcurrency,
      APP_CONFIG.io.minConcurrency,
      APP_CONFIG.io.maxConcurrency
    );

    this.cache = new Map();
    this.inflight = new Map();
    this.cacheSizeBytes = 0;
    this.bytesRead = 0;
    this.stats = createDataSourceStats();
    this.closed = false;
    this.generation = 0;
    this.activeLoads = 0;
    this.loadWaiters = [];
  }

  setMaxBytes(bytes) {
    const b = Number(bytes);
    if (Number.isFinite(b) && b > this.chunkSize) {
      this.maxBytes = b;
      this.#evictIfNeeded();
    }
  }

  setConcurrency(n) {
    const v = Number(n);
    if (Number.isFinite(v)) {
      this.concurrency = clamp(
        Math.floor(v),
        APP_CONFIG.io.minConcurrency,
        APP_CONFIG.io.maxConcurrency
      );
    }
  }

  clear() {
    this.generation += 1;
    this.cache.clear();
    this.inflight.clear();
    this.cacheSizeBytes = 0;
    this.stats.cacheBytes = 0;
  }

  cacheBytes() {
    return this.cacheSizeBytes;
  }

  #touch(key) {
    const ent = this.cache.get(key);
    if (!ent) return;
    this.cache.delete(key);
    this.cache.set(key, ent);
  }

  #evictIfNeeded() {
    while (this.cacheSizeBytes > this.maxBytes && this.cache.size) {
      const oldestKey = this.cache.keys().next().value;
      const ent = this.cache.get(oldestKey);
      this.cache.delete(oldestKey);
      this.cacheSizeBytes -= ent.bytes;
      this.stats.cacheEvictions += 1;
    }
    this.stats.cacheBytes = this.cacheSizeBytes;
  }

  async #loadChunk(chunkIndex) {
    if (this.closed || !this.source) throw new Error("Data source closed");
    const offset = chunkIndex * this.chunkSize;
    const len = Math.max(0, Math.min(this.chunkSize, this.size - offset));
    if (len <= 0) return new Uint8Array(0);
    const source = this.source;
    const u8 = await this.#withLoadPermit(() => (
      scheduleSharedTask(this.ownerId, () => source.read(offset, len))
    ));
    this.bytesRead += u8.byteLength;
    this.stats.bytesRead = this.bytesRead;
    return u8;
  }

  async #getChunk(chunkIndex) {
    const key = String(chunkIndex);
    const got = this.cache.get(key);
    if (got) {
      this.stats.cacheHits += 1;
      this.#touch(key);
      return got.u8;
    }

    const inflight = this.inflight.get(key);
    if (inflight) return inflight;
    this.stats.cacheMisses += 1;

    const generation = this.generation;
    const p = this.#loadChunk(chunkIndex).then((u8) => {
      if (this.closed || generation !== this.generation) {
        if (this.inflight.get(key) === p) this.inflight.delete(key);
        return u8;
      }
      const again = this.cache.get(key);
      if (!again) {
        this.cache.set(key, { u8, bytes: u8.byteLength });
        this.cacheSizeBytes += u8.byteLength;
      }
      this.#touch(key);
      this.#evictIfNeeded();
      this.stats.cacheBytes = this.cacheSizeBytes;
      if (this.inflight.get(key) === p) this.inflight.delete(key);
      return u8;
    }).catch((err) => {
      if (this.inflight.get(key) === p) this.inflight.delete(key);
      throw err;
    });

    this.inflight.set(key, p);
    return p;
  }

  async #withLoadPermit(task) {
    if (this.closed) throw new Error("Data source closed");
    if (this.activeLoads >= this.concurrency) {
      await new Promise((resolve, reject) => this.loadWaiters.push({ resolve, reject }));
    }
    if (this.closed) throw new Error("Data source closed");
    this.activeLoads += 1;
    try {
      return await task();
    } finally {
      this.activeLoads = Math.max(0, this.activeLoads - 1);
      const waiter = this.loadWaiters.shift();
      if (waiter) waiter.resolve();
    }
  }

  async visitPages(offset, length, visitor) {
    if (this.closed || !this.source) throw new Error("Data source closed");
    const range = normalizeRange(this.size, offset, length);
    const safeOffset = range.offset;
    const safeLength = range.length;
    if (safeLength <= 0 || typeof visitor !== "function") return 0;
    this.stats.visitPagesCalls += 1;

    const end = safeOffset + safeLength;
    const first = Math.floor(safeOffset / this.chunkSize);
    const last = Math.floor((end - 1) / this.chunkSize);

    if (first === last) {
      const chunk = await this.#getChunk(first);
      const base = first * this.chunkSize;
      const startIn = safeOffset - base;
      const view = chunk.slice(startIn, startIn + safeLength);
      await visitor(view, safeOffset);
      return view.byteLength;
    }

    let visited = 0;
    for (let ci = first; ci <= last; ci += 1) {
      const chunk = await this.#getChunk(ci);
      const base = ci * this.chunkSize;
      const start = Math.max(safeOffset, base);
      const stop = Math.min(end, base + chunk.byteLength);
      if (stop <= start) break;
      const sIn = start - base;
      const view = chunk.slice(sIn, sIn + (stop - start));
      await visitor(view, start);
      visited += view.byteLength;
    }
    return visited;
  }

  async readInto(offset, dest, destOffset = 0, length = null) {
    if (this.closed || !this.source) throw new Error("Data source closed");
    if (!dest || typeof dest.byteLength !== "number") return 0;
    this.stats.readIntoCalls += 1;
    const dstOffset = Math.max(0, Number(destOffset) || 0);
    const maxLen = Math.max(0, dest.byteLength - dstOffset);
    const requested = length == null ? maxLen : Math.max(0, Math.min(maxLen, Number(length) || 0));
    const wantLen = normalizeRange(this.size, offset, requested).length;
    if (wantLen <= 0) return 0;

    let writeOffset = dstOffset;
    let total = 0;
    await this.visitPages(offset, wantLen, async (view) => {
      dest.set(view, writeOffset);
      writeOffset += view.byteLength;
      total += view.byteLength;
    });
    return total;
  }

  async read(offset, length) {
    if (this.closed || !this.source) throw new Error("Data source closed");
    const range = normalizeRange(this.size, offset, length);
    const safeOffset = range.offset;
    const safeLength = range.length;
    if (safeLength <= 0) return new Uint8Array(0);
    this.stats.readCalls += 1;

    const out = new Uint8Array(safeLength);
    const bytesRead = await this.readInto(safeOffset, out, 0, safeLength);
    return bytesRead === out.byteLength ? out : out.slice(0, bytesRead);
  }

  close() {
    this.closed = true;
    this.clear();
    this.size = 0;
    const closeError = new Error("Data source closed");
    for (const waiter of this.loadWaiters.splice(0)) waiter.reject(closeError);
    cancelSharedTasks(this.ownerId);
    const base = this.source;
    this.source = null;
    if (base && typeof base.close === "function") {
      try { base.close(); } catch (_err) {}
    }
  }
}

async function blobToArrayBuffer(blobLike) {
  if (blobLike && typeof blobLike.arrayBuffer === "function") {
    return blobLike.arrayBuffer();
  }

  // Browser/JSDOM fallback.
  if (typeof FileReader !== "undefined") {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(fr.error || new Error("Failed reading blob"));
      fr.onload = () => resolve(fr.result);
      fr.readAsArrayBuffer(blobLike);
    });
  }

  // Works in modern runtimes even when Blob doesn't expose arrayBuffer directly.
  // Keep this after FileReader because some test runtimes stringify unknown blobs here.
  if (typeof Response !== "undefined") {
    const res = new Response(blobLike);
    return res.arrayBuffer();
  }

  throw new Error("No blob reader available in this runtime.");
}

function createDataSourceStats() {
  return {
    bytesRead: 0,
    readCalls: 0,
    readIntoCalls: 0,
    visitPagesCalls: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheEvictions: 0,
    cacheBytes: 0
  };
}
