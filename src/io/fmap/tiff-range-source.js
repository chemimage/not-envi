function safeBytes(value, label) {
  const bytes = Number(value || 0);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError(`${label} must be a non-negative safe integer.`);
  return bytes;
}

function abortError(message = "TIFF fmap operation aborted.") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export class FmapTiffDataSource {
  constructor(rangeSource, options = {}) {
    if (!rangeSource || typeof rangeSource.readRange !== "function") {
      throw new TypeError("TIFF fmap requires a bounded range source.");
    }
    this.source = rangeSource;
    this.size = safeBytes(rangeSource.size, "TIFF file size");
    this.ownerId = String(rangeSource.ownerId || "tiff-fmap");
    this.isFmap = true;
    this.pageSize = Number(rangeSource.pageSize) || Number(rangeSource.chunkSize) || (256 * 1024);
    this.chunkSize = this.pageSize;
    this.maxBytes = Number(rangeSource.maxBytes) || Number(options.poolBytes) || 0;
    this.concurrency = Math.max(1, Math.floor(Number(options.concurrency) || Number(rangeSource.concurrency) || 1));
    this.maxWorkingSetBytes = safeBytes(options.maxWorkingSetBytes ?? (32 * 1024 * 1024), "TIFF fmap working-set limit");
    this.maxLogicalResultBytes = safeBytes(
      options.maxLogicalResultBytes ?? rangeSource.maxLogicalResultBytes ?? (128 * 1024 * 1024),
      "TIFF fmap logical-result limit"
    );
    this.maxWindowResultBytes = this.maxLogicalResultBytes;
    this.maxRetainedBytes = safeBytes(options.maxRetainedBytes ?? this.maxWorkingSetBytes, "TIFF fmap retained-backing limit");
    this.maxQueuedReservations = Math.max(1, Math.floor(Number(options.maxQueuedReservations) || 64));
    this.maxQueuedReservationBytes = safeBytes(options.maxQueuedReservationBytes ?? (this.maxWorkingSetBytes * 2), "TIFF fmap queued reservation limit");
    this.ready = Promise.resolve(rangeSource.ready).then(() => this);
    this.closed = false;
    this.nextReservationId = 0;
    this.activeReservations = new Map();
    this.retainedReservations = new Map();
    this.waiters = [];
    this.grantedBytes = 0;
    this.generation = 0;
    this.stats = {
      requestedBytes: 0, bytesRead: 0, readCalls: 0, readIntoCalls: 0, visitPagesCalls: 0,
      encodedBytes: 0, decodedReservedBytes: 0, scratchReservedBytes: 0,
      activeReservationBytes: 0, retainedBackingBytes: 0, peakReservationBytes: 0,
      peakRetainedBackingBytes: 0, queuedReservations: 0, queuedReservationBytes: 0,
      rejectedReservations: 0, cancelledReservations: 0, blockReads: 0
    };
  }

  async reserveWorkingSet({ encodedBytes = 0, decodedBytes = 0, scratchBytes = 0, codec = "unknown", signal = null, cancelled = null } = {}) {
    await this.ready;
    if (this.closed) throw new Error("TIFF fmap range source is closed.");
    const encoded = safeBytes(encodedBytes, "TIFF encoded reservation");
    const decoded = safeBytes(decodedBytes, "TIFF decoded reservation");
    const scratch = safeBytes(scratchBytes, "TIFF decoder scratch reservation");
    const total = encoded + decoded + scratch;
    if (!Number.isSafeInteger(total)) throw new RangeError("TIFF block working set exceeds the browser's exact integer range.");
    if (total > this.maxWorkingSetBytes) {
      this.stats.rejectedReservations += 1;
      throw new Error(
        `TIFF ${String(codec)} block requires ${total} bytes (${encoded} encoded + ${decoded} decoded + ${scratch} scratch), `
        + `exceeding the ${this.maxWorkingSetBytes}-byte fmap working-set limit. `
        + "Use a supported overview or re-encode with smaller tiles/strips."
      );
    }
    if (signal?.aborted || cancelled?.()) throw abortError();
    const generation = this.generation;
    if (this.#activeBytes() + this.grantedBytes + total > this.maxWorkingSetBytes) {
      await this.#waitForCapacity(total, signal, cancelled);
      this.grantedBytes = Math.max(0, this.grantedBytes - total);
    }
    if (this.closed) throw new Error("TIFF fmap range source is closed.");
    if (generation !== this.generation || signal?.aborted || cancelled?.()) throw abortError();
    const id = ++this.nextReservationId;
    const record = { id, total, encoded, decoded, scratch, state: "active" };
    this.activeReservations.set(id, record);
    this.stats.encodedBytes += encoded;
    this.stats.decodedReservedBytes += decoded;
    this.stats.scratchReservedBytes += scratch;
    this.#syncStats();
    let settled = false;
    return {
      retain: (backingBytes = decoded) => {
        if (settled || record.state !== "active" || !this.activeReservations.has(id)) return;
        const backing = safeBytes(backingBytes, "TIFF retained backing allocation");
        if (backing > record.total) {
          throw new Error(`TIFF retained backing allocation ${backing} exceeds its ${record.total}-byte reservation.`);
        }
        const retained = this.#retainedBytes();
        if (retained + backing > this.maxRetainedBytes) {
          throw new Error(
            `TIFF decoded backing would require ${retained + backing} bytes, exceeding the `
            + `${this.maxRetainedBytes}-byte retained-backing limit.`
          );
        }
        this.activeReservations.delete(id);
        record.state = "retained";
        record.backing = backing;
        this.retainedReservations.set(id, record);
        this.#syncStats();
        this.#drainWaiters();
      },
      release: () => {
        if (settled) return;
        settled = true;
        this.activeReservations.delete(id);
        this.retainedReservations.delete(id);
        this.#syncStats();
        this.#drainWaiters();
      }
    };
  }

  async leaseRange(offset, length, options = {}) {
    const start = safeBytes(offset, "TIFF range offset");
    const bytes = safeBytes(length, "TIFF range length");
    if (!Number.isSafeInteger(start + bytes) || start + bytes > this.size) {
      throw new Error(`TIFF range exceeds EOF: requested ${start}+${bytes}, file size ${this.size}.`);
    }
    const lease = await this.reserveWorkingSet({
      encodedBytes: bytes,
      decodedBytes: options.decodedBytes ?? bytes,
      scratchBytes: options.scratchBytes ?? 0,
      codec: options.codec,
      signal: options.signal,
      cancelled: options.cancelled
    });
    try {
      const raw = await this.source.readRange(start, bytes, null, options);
      this.stats.requestedBytes += bytes;
      this.stats.bytesRead += bytes;
      this.stats.readCalls += 1;
      this.stats.blockReads += 1;
      this.#syncSourceStats();
      return { raw, retain: lease.retain, release: lease.release };
    } catch (error) {
      lease.release();
      if (error?.name === "AbortError") this.stats.cancelledReservations += 1;
      throw error;
    }
  }

  async read(offset, length, options = {}) {
    const lease = await this.leaseRange(offset, length, { ...options, decodedBytes: options.decodedBytes ?? length });
    try { return lease.raw; } finally { lease.release(); }
  }

  async readInto(offset, destination, destinationOffset = 0, length = null, options = {}) {
    this.stats.readIntoCalls += 1;
    const targetOffset = Math.max(0, Math.floor(Number(destinationOffset) || 0));
    const available = Math.max(0, Number(destination?.byteLength || 0) - targetOffset);
    const count = length == null ? available : Math.min(available, safeBytes(length, "TIFF read length"));
    const bytes = await this.read(offset, count, options);
    destination.set(bytes, targetOffset);
    return bytes.byteLength;
  }

  async visitPages(offset, length, visitor, options = {}) {
    this.stats.visitPagesCalls += 1;
    const bytes = await this.read(offset, length, options);
    await visitor(bytes, offset);
    return bytes.byteLength;
  }

  setConcurrency(value) {
    this.concurrency = Math.max(1, Math.floor(Number(value) || 1));
    this.source?.setConcurrency?.(this.concurrency);
  }

  setMaxBytes(value) {
    if (Number.isSafeInteger(Number(value)) && Number(value) > 0) this.source?.setMaxBytes?.(Number(value));
  }

  setMaxRetainedBytes(value) {
    this.maxRetainedBytes = safeBytes(value, "TIFF fmap retained-backing limit");
  }

  cacheBytes() { return Number(this.source?.cacheBytes?.()) || 0; }

  async getStats() {
    await this.ready;
    const sourceStats = typeof this.source?.getStats === "function" ? await this.source.getStats() : this.source?.stats;
    this.#syncSourceStats(sourceStats);
    return { ...this.stats, isFmap: true };
  }

  /** Bind an accepted linear TIFF layout to the shared numeric fmap planner. */
  async configureRaster(meta) {
    await this.ready;
    if (typeof this.source?.configureRaster !== "function") {
      throw new Error("TIFF fmap range source cannot configure raster metadata.");
    }
    await this.source.configureRaster(meta);
    this.managesWindowOutput = true;
    this.readBandWindow = this.source.readBandWindow.bind(this.source);
    this.readBandWindowBIP = this.readBandWindow;
    return this;
  }

  clear() {
    this.source?.clear?.();
    this.generation += 1;
    for (const waiter of this.waiters.splice(0)) {
      waiter.cleanup();
      waiter.reject(abortError("TIFF fmap cache cleared."));
    }
    for (const record of this.activeReservations.values()) record.state = "cleared";
    for (const record of this.retainedReservations.values()) record.state = "cleared";
    this.activeReservations.clear();
    this.retainedReservations.clear();
    this.grantedBytes = 0;
    this.#syncStats();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.clear();
    this.source?.close?.();
    this.source = null;
    this.size = 0;
  }

  #activeBytes() {
    let bytes = 0;
    for (const record of this.activeReservations.values()) bytes += record.total;
    return bytes;
  }

  #retainedBytes() {
    let bytes = 0;
    for (const record of this.retainedReservations.values()) bytes += record.backing || 0;
    return bytes;
  }

  #waitForCapacity(bytes, signal, cancelled) {
    const queuedBytes = this.waiters.reduce((sum, waiter) => sum + waiter.bytes, 0);
    if (this.waiters.length >= this.maxQueuedReservations || queuedBytes + bytes > this.maxQueuedReservationBytes) {
      this.stats.rejectedReservations += 1;
      return Promise.reject(abortError("TIFF fmap reservation queue is full."));
    }
    return new Promise((resolve, reject) => {
      const waiter = { bytes, resolve, reject, signal, cleanup: () => {} };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        this.stats.cancelledReservations += 1;
        waiter.cleanup();
        this.#syncStats();
        reject(abortError());
      };
      const timer = typeof cancelled === "function"
        ? setInterval(() => { if (cancelled()) onAbort(); }, 16)
        : null;
      waiter.cleanup = () => {
        signal?.removeEventListener?.("abort", onAbort);
        if (timer != null) clearInterval(timer);
      };
      signal?.addEventListener?.("abort", onAbort, { once: true });
      this.waiters.push(waiter);
      this.#syncStats();
    });
  }

  #drainWaiters() {
    while (this.waiters.length) {
      const waiter = this.waiters[0];
      if (this.#activeBytes() + this.grantedBytes + waiter.bytes > this.maxWorkingSetBytes) break;
      this.waiters.shift();
      this.grantedBytes += waiter.bytes;
      waiter.cleanup();
      waiter.resolve();
      break;
    }
    this.#syncStats();
  }

  #syncStats() {
    const active = this.#activeBytes();
    const retained = this.#retainedBytes();
    this.stats.activeReservationBytes = active + this.grantedBytes;
    this.stats.retainedBackingBytes = retained;
    this.stats.peakReservationBytes = Math.max(this.stats.peakReservationBytes, active + retained + this.grantedBytes);
    this.stats.peakRetainedBackingBytes = Math.max(this.stats.peakRetainedBackingBytes, retained);
    this.stats.queuedReservations = this.waiters.length;
    this.stats.queuedReservationBytes = this.waiters.reduce((sum, waiter) => sum + waiter.bytes, 0);
  }

  #syncSourceStats(explicit = null) {
    const stats = explicit || this.source?.stats || {};
    const queueKeys = Object.keys(stats).filter((key) => /^(pageFill|fillActive|fillQueue|peakFill)/.test(key));
    for (const key of ["browserBytes", "copiedBytes", "cacheHits", "cacheMisses", "cacheEvictions", "residentBytes", "pinnedBytes", "batches", "workerCancelledRequests", ...queueKeys]) {
      const value = Number(stats?.[key]);
      if (Number.isFinite(value)) this.stats[key] = value;
    }
  }
}

export async function createFmapTiffDataSource(file, options = {}) {
  if (typeof options.createRangeSource !== "function") throw new Error("TIFF fmap range factory is unavailable.");
  const source = new FmapTiffDataSource(options.createRangeSource(file, options), options);
  await source.ready;
  return source;
}
