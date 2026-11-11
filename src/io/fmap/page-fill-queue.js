function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`Invalid fmap ${label}.`);
  return value;
}

function aborted(message = "fmap page request cancelled.") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function mergeRanges(ranges) {
  const merged = [];
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function missingRanges(wanted, valid) {
  const missing = [];
  for (const range of wanted) {
    let cursor = range.start;
    for (const resident of valid) {
      if (resident.end <= cursor) continue;
      if (resident.start >= range.end) break;
      if (resident.start > cursor) missing.push({ start: cursor, end: Math.min(resident.start, range.end) });
      cursor = Math.max(cursor, resident.end);
      if (cursor >= range.end) break;
    }
    if (cursor < range.end) missing.push({ start: cursor, end: range.end });
  }
  return missing;
}

/**
 * File-session I/O queue below runnable window/spectrum/range jobs.
 *
 * C owns fixed resident slots and exact validity intervals. One active fill per
 * fpage merges consumers; a later overlap reads only the remaining holes. Each
 * delivered lease pins its slot until released, independently of other waiters.
 * No WASM view survives an asynchronous read. clear() invalidates old leases and
 * resets C; old provider reads remain charged until settled and cannot commit.
 * Admitted-waiter count/bytes and active read concurrency are separately bounded.
 * Excess faults remain lightweight parked descriptors: they own neither resident
 * slots nor I/O/output buffers, and wait for capacity rather than failing.
 * This is a per-file working set, not a whole-tab budget. See issue #20.
 */
export class FmapPageFillQueue {
  constructor({ core, fileSize, pageSize, generation = 1, concurrency = 2,
    maxQueuedRequests = 64, maxQueuedBytes = 32 * 1024 * 1024, readFile, postTask } = {}) {
    this.core = core;
    this.fileSize = integer(fileSize, "file size");
    this.pageSize = integer(pageSize, "page size", 1);
    this.generation = integer(generation, "generation");
    this.concurrency = integer(concurrency, "read concurrency", 1);
    this.maxQueuedRequests = integer(maxQueuedRequests, "page waiter limit", 1);
    this.maxQueuedBytes = integer(maxQueuedBytes, "page waiter byte limit", 1);
    if (typeof readFile !== "function") throw new TypeError("fmap requires an asynchronous file reader.");
    this.readFile = readFile;
    this.records = new Map();
    this.waiters = new Map();
    this.parked = new Map();
    this.active = new Set();
    this.closed = false;
    this.scheduled = false;
    this.nextId = 0;
    this.nextOrder = 0;
    this.stats = { pageFillReads: 0, pageFillDeduplications: 0, pageFillCacheHits: 0,
      pageFillCacheMisses: 0, pageFillFailures: 0, pageFillCancelledWaiters: 0,
      pageFillFragmentFallbacks: 0, pageFillCopiedBytes: 0, peakFillActiveReads: 0, peakFillActiveBytes: 0,
      peakFillQueueRequests: 0, peakFillQueueBytes: 0, peakFillParkedRequests: 0 };
    if (postTask) this.postTask = postTask;
    else {
      const channel = new MessageChannel();
      const callbacks = [];
      channel.port1.onmessage = () => callbacks.shift()?.();
      this.postTask = (callback) => { callbacks.push(callback); channel.port2.postMessage(null); };
      this.closeTasks = () => { callbacks.length = 0; channel.port1.close(); channel.port2.close(); };
    }
  }

  #call(name, ...args) {
    const fn = this.core?.[name];
    if (typeof fn !== "function") throw new Error(`Missing fmap page-cache export ${name}.`);
    return fn(...args);
  }

  #valid(slot, offset, length) {
    const result = Number(this.#call("fmap_range_valid", slot, offset, length));
    if (result < 0) throw new Error(`Unable to query fmap range validity (${result}).`);
    return result === 1;
  }

  #lease(slot, request) {
    const generation = this.generation;
    let released = false;
    return {
      slot, offset: request.offset, length: request.length,
      release: () => {
        if (released) return;
        released = true;
        if (generation === this.generation
            && this.#call("fmap_slot_page", slot) === BigInt(request.pageIndex)) {
          const result = Number(this.#call("fmap_release_page", slot));
          if (result !== 0) throw new Error(`Unable to release fmap page lease (${result}).`);
          this.#wake();
        }
      }
    };
  }

  request({ pageIndex, offset, length, priority = 0, generation = this.generation, requestId } = {}) {
    if (this.closed) throw aborted("fmap page queue is closed.");
    if (generation !== this.generation) throw aborted("Obsolete fmap page generation.");
    integer(pageIndex, "page index"); integer(offset, "page offset"); integer(length, "page length", 1);
    const base = integer(pageIndex * this.pageSize, "page file offset");
    const end = integer(base + offset + length, "page range end");
    if (offset + length > this.pageSize || end > this.fileSize) throw new RangeError("fmap page range exceeds its page or EOF.");
    const existing = Number(this.#call("fmap_find_page", BigInt(pageIndex)));
    if (existing >= 0 && this.#valid(existing, offset, length)) {
      const slot = Number(this.#call("fmap_acquire_page", BigInt(pageIndex)));
      if (slot < 0) throw new Error(`Unable to pin resident fmap page (${slot}).`);
      this.stats.pageFillCacheHits += 1;
      const lease = this.#lease(slot, { pageIndex, offset, length });
      return { lease, promise: Promise.resolve(lease), cancel: () => {} };
    }
    if (length > this.maxQueuedBytes) throw new RangeError("fmap page demand exceeds the admission byte limit.");
    this.stats.pageFillCacheMisses += 1;
    if (this.records.has(pageIndex) || [...this.parked.values()].some((waiter) => waiter.pageIndex === pageIndex)) {
      this.stats.pageFillDeduplications += 1;
    }
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const waiter = { id: ++this.nextId, requestId, record: null, generation, pageIndex, offset, length,
      priority: priority === 1 ? 1 : 0, resolve, reject, settled: false };
    this.parked.set(waiter.id, waiter);
    this.#admit();
    this.#syncStats();
    this.#wake();
    return { promise, cancel: () => {
      if (waiter.settled) return;
      this.stats.pageFillCancelledWaiters += 1;
      const record = waiter.record;
      this.#reject(waiter, aborted());
      if (record) this.#cleanup(record);
      this.#admit();
      this.#wake();
    } };
  }

  #remove(waiter) {
    waiter.settled = true;
    waiter.record?.waiters.delete(waiter.id);
    this.waiters.delete(waiter.id);
    this.parked.delete(waiter.id);
  }

  #admit() {
    if (this.closed) return;
    let bytes = [...this.waiters.values()].reduce((sum, waiter) => sum + waiter.length, 0);
    const candidates = [...this.parked.values()].sort((a, b) => a.priority - b.priority || a.id - b.id);
    for (const waiter of candidates) {
      // A foreground fault may displace speculative descriptors that have not
      // begun I/O. Their promises remain pending and they can be admitted later.
      while (this.waiters.size >= this.maxQueuedRequests || bytes + waiter.length > this.maxQueuedBytes) {
        const eligible = [...this.waiters.values()].filter((entry) => entry.priority > waiter.priority && !entry.record.active);
        const speculative = eligible.findLast((entry) => entry.pageIndex !== waiter.pageIndex) || eligible.at(-1);
        if (!speculative) break;
        const record = speculative.record;
        record.waiters.delete(speculative.id);
        this.waiters.delete(speculative.id);
        bytes -= speculative.length;
        speculative.record = null;
        this.parked.set(speculative.id, speculative);
        this.#cleanup(record);
      }
      if (this.waiters.size >= this.maxQueuedRequests || bytes + waiter.length > this.maxQueuedBytes) break;
      const existing = Number(this.#call("fmap_find_page", BigInt(waiter.pageIndex)));
      if (existing >= 0 && this.#valid(existing, waiter.offset, waiter.length)) {
        const slot = Number(this.#call("fmap_acquire_page", BigInt(waiter.pageIndex)));
        if (slot < 0) throw new Error(`Unable to pin resident fmap page (${slot}).`);
        this.stats.pageFillCacheHits += 1;
        const lease = this.#lease(slot, waiter);
        this.#remove(waiter);
        waiter.resolve(lease);
        continue;
      }
      let record = this.records.get(waiter.pageIndex);
      if (!record) {
        record = { pageIndex: waiter.pageIndex, generation: waiter.generation, order: ++this.nextOrder,
          active: false, forceFull: false, waiters: new Map() };
        this.records.set(waiter.pageIndex, record);
      }
      waiter.record = record;
      record.waiters.set(waiter.id, waiter);
      this.waiters.set(waiter.id, waiter);
      this.parked.delete(waiter.id);
      bytes += waiter.length;
    }
  }

  #reject(waiter, error) {
    if (waiter.settled) return;
    this.#remove(waiter);
    waiter.reject(error);
  }

  #ready(record, slot) {
    for (const waiter of [...record.waiters.values()]) {
      if (!this.#valid(slot, waiter.offset, waiter.length)) continue;
      const pinned = Number(this.#call("fmap_acquire_page", BigInt(record.pageIndex)));
      if (pinned < 0) throw new Error(`Unable to pin filled fmap page (${pinned}).`);
      const lease = this.#lease(pinned, waiter);
      this.#remove(waiter);
      waiter.resolve(lease);
    }
  }

  #ranges(slot) {
    const count = Number(this.#call("fmap_slot_range_count", slot));
    const ranges = [];
    for (let index = 0; index < count; index += 1) {
      const start = Number(this.#call("fmap_slot_range_offset", slot, index));
      ranges.push({ start, end: start + Number(this.#call("fmap_slot_range_length", slot, index)) });
    }
    return ranges;
  }

  #cleanup(record) {
    if (!record.active && !record.waiters.size && this.records.get(record.pageIndex) === record) {
      this.records.delete(record.pageIndex);
    }
  }

  #wake() {
    if (this.closed || this.scheduled || (!this.waiters.size && !this.parked.size)) return;
    this.scheduled = true;
    this.postTask(() => {
      this.scheduled = false;
      this.#pump();
    });
  }

  #pump() {
    if (this.closed) return;
    this.#admit();
    const records = [...this.records.values()].filter((record) => !record.active && record.waiters.size);
    const priority = (record) => Math.min(...[...record.waiters.values(),
      ...[...this.parked.values()].filter((waiter) => waiter.pageIndex === record.pageIndex)
    ].map((waiter) => waiter.priority));
    records.sort((a, b) => priority(a) - priority(b) || a.order - b.order);
    for (const record of records) {
      if (this.active.size >= this.concurrency) break;
      let slot = -1;
      try {
        slot = Number(this.#call("fmap_acquire_page", BigInt(record.pageIndex)));
        if (slot === -2) continue; // All slots pinned: a lease/fill completion wakes the queue.
        if (slot < 0) throw new Error(`Unable to reserve fmap fill page (${slot}).`);
        this.#ready(record, slot);
        if (!record.waiters.size) {
          this.#call("fmap_release_page", slot);
          slot = -1;
          this.#cleanup(record);
          continue;
        }
        const pageLength = Math.min(this.pageSize, this.fileSize - record.pageIndex * this.pageSize);
        const wanted = mergeRanges([...record.waiters.values()].map((waiter) => ({
          start: waiter.offset, end: waiter.offset + waiter.length
        })));
        const missing = record.forceFull ? [{ start: 0, end: pageLength }] : missingRanges(wanted, this.#ranges(slot));
        const range = missing[0];
        if (!range) throw new Error("fmap page demand has no missing or resident range.");
        const io = { record, slot, generation: this.generation, start: range.start,
          length: range.end - range.start, full: record.forceFull };
        record.active = true;
        this.active.add(io);
        this.stats.pageFillReads += 1;
        this.#syncStats();
        Promise.resolve().then(() => this.readFile(record.pageIndex * this.pageSize + io.start, io.length))
          .then((bytes) => this.#commit(io, bytes), (error) => this.#fail(io, error))
          .catch((error) => this.#fail(io, error))
          .finally(() => this.#complete(io));
        slot = -1; // The asynchronous fill now owns this reservation.
      } catch (error) {
        if (slot >= 0) this.#call("fmap_release_page", slot);
        for (const waiter of [...record.waiters.values()]) this.#reject(waiter, error);
        this.#cleanup(record);
      }
    }
    this.#syncStats();
  }

  #current(io) {
    return !this.closed && io.generation === this.generation
      && this.records.get(io.record.pageIndex) === io.record;
  }

  #commit(io, raw) {
    if (!this.#current(io)) return;
    let bytes;
    if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw);
    else if (ArrayBuffer.isView(raw)) bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    else throw new TypeError("fmap file reader must return bytes.");
    if (bytes.byteLength !== io.length) throw new Error(`Truncated fmap fill: expected ${io.length} bytes, found ${bytes.byteLength}.`);
    new Uint8Array(this.core.memory.buffer, Number(this.#call("fmap_slot_ptr", io.slot)) + io.start, io.length).set(bytes);
    this.stats.pageFillCopiedBytes += io.length;
    const result = Number(io.full
      ? this.#call("fmap_commit_page", io.slot, io.length)
      : this.#call("fmap_commit_range", io.slot, io.start, io.length));
    if (result === -8) {
      io.record.forceFull = true;
      this.stats.pageFillFragmentFallbacks += 1;
      return;
    }
    if (result !== 0) throw new Error(`Unable to commit fmap fill (${result}).`);
    io.record.forceFull = false;
    this.#ready(io.record, io.slot);
  }

  #fail(io, error) {
    if (!this.#current(io)) return;
    this.stats.pageFillFailures += 1;
    for (const waiter of [...io.record.waiters.values()]) this.#reject(waiter, error);
  }

  #complete(io) {
    this.active.delete(io);
    if (io.generation === this.generation && !this.closed) {
      this.#call("fmap_release_page", io.slot);
      io.record.active = false;
      this.#cleanup(io.record);
    }
    this.#syncStats();
    this.#wake();
  }

  #syncStats() {
    const activeBytes = [...this.active].reduce((sum, io) => sum + io.length, 0);
    const queuedBytes = [...this.waiters.values()].reduce((sum, waiter) => sum + waiter.length, 0);
    this.stats.peakFillActiveReads = Math.max(this.stats.peakFillActiveReads, this.active.size);
    this.stats.peakFillActiveBytes = Math.max(this.stats.peakFillActiveBytes, activeBytes);
    this.stats.peakFillQueueRequests = Math.max(this.stats.peakFillQueueRequests, this.waiters.size);
    this.stats.peakFillQueueBytes = Math.max(this.stats.peakFillQueueBytes, queuedBytes);
    this.stats.fillActiveReads = this.active.size;
    this.stats.fillActiveBytes = activeBytes;
    this.stats.fillQueueRequests = this.waiters.size;
    this.stats.fillQueueBytes = queuedBytes;
    this.stats.fillParkedRequests = this.parked.size;
    this.stats.peakFillParkedRequests = Math.max(this.stats.peakFillParkedRequests, this.parked.size);
  }

  getStats() { this.#syncStats(); return { ...this.stats }; }

  setConcurrency(value) {
    this.concurrency = integer(value, "read concurrency", 1);
    this.#wake();
  }

  clear(generation) {
    integer(generation, "generation");
    if (generation <= this.generation) throw new RangeError("fmap clear requires a newer generation.");
    this.generation = generation;
    for (const waiter of [...this.waiters.values(), ...this.parked.values()]) this.#reject(waiter, aborted("fmap page generation cleared."));
    this.records.clear();
    this.#call("fmap_reset");
    this.#syncStats();
  }

  close() {
    if (this.closed) return;
    this.clear(this.generation + 1);
    this.closed = true;
    this.closeTasks?.();
  }
}
