import { clamp } from "./utils.js";

export class BlobDataSource {
  constructor(file) {
    this.file = file;
    this.size = file.size;
    this.bytesRead = 0;
  }

  async read(offset, length) {
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLength = Math.max(0, Number(length) || 0);
    const end = Math.min(this.size, safeOffset + safeLength);
    const slice = this.file.slice(safeOffset, end);
    const ab = await blobToArrayBuffer(slice);
    const u8 = new Uint8Array(ab);
    this.bytesRead += u8.byteLength;
    return u8;
  }
}

export class ChunkCacheDataSource {
  constructor(source, options = {}) {
    this.source = source;
    this.size = source.size;
    this.chunkSize = Math.max(64 * 1024, Number(options.chunkSize) || (1 << 20));
    this.maxBytes = Math.max(this.chunkSize * 2, Number(options.maxBytes) || (256 * 1024 * 1024));

    const hc = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : 4;
    this.concurrency = clamp(Number(options.concurrency) || clamp(Math.floor(hc / 2) + 1, 1, 8), 1, 8);

    this.cache = new Map();
    this.inflight = new Map();
    this.cacheSizeBytes = 0;
    this.bytesRead = 0;
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
      this.concurrency = clamp(Math.floor(v), 1, 8);
    }
  }

  clear() {
    this.cache.clear();
    this.inflight.clear();
    this.cacheSizeBytes = 0;
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
    }
  }

  async #loadChunk(chunkIndex) {
    const offset = chunkIndex * this.chunkSize;
    const len = Math.min(this.chunkSize, this.size - offset);
    const u8 = await this.source.read(offset, len);
    this.bytesRead += u8.byteLength;
    return u8;
  }

  async #getChunk(chunkIndex) {
    const key = String(chunkIndex);
    const got = this.cache.get(key);
    if (got) {
      this.#touch(key);
      return got.u8;
    }

    const inflight = this.inflight.get(key);
    if (inflight) return inflight;

    const p = this.#loadChunk(chunkIndex).then((u8) => {
      const again = this.cache.get(key);
      if (!again) {
        this.cache.set(key, { u8, bytes: u8.byteLength });
        this.cacheSizeBytes += u8.byteLength;
      }
      this.#touch(key);
      this.#evictIfNeeded();
      this.inflight.delete(key);
      return u8;
    }).catch((err) => {
      this.inflight.delete(key);
      throw err;
    });

    this.inflight.set(key, p);
    return p;
  }

  async read(offset, length) {
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLength = Math.max(0, Number(length) || 0);
    if (safeLength <= 0) return new Uint8Array(0);

    const end = safeOffset + safeLength;
    const first = Math.floor(safeOffset / this.chunkSize);
    const last = Math.floor((end - 1) / this.chunkSize);

    if (first === last) {
      const chunk = await this.#getChunk(first);
      const base = first * this.chunkSize;
      const startIn = safeOffset - base;
      return chunk.subarray(startIn, startIn + safeLength);
    }

    const out = new Uint8Array(safeLength);
    const idxs = [];
    for (let ci = first; ci <= last; ci += 1) idxs.push(ci);

    const chunks = new Array(idxs.length);
    let next = 0;
    const worker = async () => {
      while (true) {
        const i = next++;
        if (i >= idxs.length) break;
        chunks[i] = await this.#getChunk(idxs[i]);
      }
    };

    const nWorkers = Math.min(this.concurrency, idxs.length);
    const workers = [];
    for (let i = 0; i < nWorkers; i += 1) workers.push(worker());
    await Promise.all(workers);

    let outPos = 0;
    for (let i = 0; i < idxs.length; i += 1) {
      const ci = idxs[i];
      const chunk = chunks[i];
      const base = ci * this.chunkSize;
      const start = Math.max(safeOffset, base);
      const stop = Math.min(end, base + chunk.byteLength);
      const sIn = start - base;
      const n = stop - start;
      out.set(chunk.subarray(sIn, sIn + n), outPos);
      outPos += n;
    }

    return out;
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
