function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`Invalid fmap ${label}.`);
  return value;
}

function aborted(message = "fmap page request cancelled.") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

const STAT_NAMES = [
  "pageFillReads", "pageFillDeduplications", "pageFillCacheHits", "pageFillCacheMisses",
  "pageFillFailures", "pageFillCancelledWaiters", "pageFillFragmentFallbacks", "pageFillCopiedBytes",
  "peakFillActiveReads", "peakFillActiveBytes", "peakFillQueueRequests", "peakFillQueueBytes",
  "fillActiveReads", "fillActiveBytes", "fillQueueRequests", "fillQueueBytes", "fillParkedRequests",
  "peakFillParkedRequests", "fillMetadataBytes", "fillLiveDemands", "peakFillLiveDemands"
];

/** Browser I/O / Promise adapter for the C file-session fill state machine.
 * C owns descriptors, priority, admission, range planning, reservations and
 * leases. JS retains only opaque IDs with callbacks and bounded read commands.
 * Every read settles through C, including cancellation and clear/close. No
 * WASM memory view crosses an await or a metadata-allocation call.
 */
export class FmapPageFillQueue {
  constructor({ core, fileSize, pageSize, generation = 1, concurrency = 2,
    maxQueuedRequests = 64, maxQueuedBytes = 32 * 1024 * 1024, readFile, postTask } = {}) {
    this.core = core;
    this.fileSize = integer(fileSize, "file size");
    this.pageSize = integer(pageSize, "page size", 1, 0xffffffff);
    this.generation = integer(generation, "generation");
    this.concurrency = integer(concurrency, "read concurrency", 1, 0xffffffff);
    this.maxQueuedRequests = integer(maxQueuedRequests, "page waiter limit", 1, 0xffffffff);
    this.maxQueuedBytes = integer(maxQueuedBytes, "page waiter byte limit", 1, 0xffffffff);
    if (typeof readFile !== "function") throw new TypeError("fmap requires an asynchronous file reader.");
    if (Number(core.fmap_page_size()) !== pageSize) throw new RangeError("fmap page size does not match the C pool.");
    this.readFile = readFile;
    this.callbacks = new Map();
    this.closed = false;
    this.scheduled = false;
    const status = Number(core.fmap_fill_init(BigInt(fileSize), concurrency, maxQueuedRequests, maxQueuedBytes));
    if (status !== 0) throw new Error(`Unable to initialize fmap fill policy (${status}).`);
    if (postTask) this.postTask = postTask;
    else {
      const channel = new MessageChannel();
      const callbacks = [];
      channel.port1.onmessage = () => callbacks.shift()?.();
      this.postTask = (callback) => { callbacks.push(callback); channel.port2.postMessage(null); };
      this.closeTasks = () => { callbacks.length = 0; channel.port1.close(); channel.port2.close(); };
    }
  }

  #lease(id, slot, offset, length) {
    let released = false;
    return { slot, offset, length, release: () => {
      if (released) return;
      released = true;
      this.core.fmap_fill_release(id);
      this.#wake();
    } };
  }

  #events(failureId = 0, failure) {
    let pointer;
    while ((pointer = Number(this.core.fmap_fill_event()))) {
      // Copy the snapshot before another C call; memory may grow on submission.
      const event = new DataView(this.core.memory.buffer, pointer, 24);
      const id = event.getUint32(0, true), slot = event.getUint32(4, true);
      const offset = event.getUint32(8, true), length = event.getUint32(12, true);
      const status = event.getInt32(16, true), cause = event.getUint32(20, true);
      const callback = this.callbacks.get(id);
      this.callbacks.delete(id);
      if (!callback) {
        if (status === 0) this.core.fmap_fill_release(id);
        continue;
      }
      if (status === 0) {
        callback.lease = this.#lease(id, slot, offset, length);
        callback.resolve(callback.lease);
      } else callback.reject(status === -9 ? aborted() : (cause === failureId && failure)
        || new Error(`fmap fill failed (${status}).`));
    }
  }

  request({ pageIndex, offset, length, fillBytes = 0, priority = 0, generation = this.generation } = {}) {
    if (this.closed) throw aborted("fmap page queue is closed.");
    if (generation !== this.generation) throw aborted("Obsolete fmap page generation.");
    integer(pageIndex, "page index"); integer(offset, "page offset"); integer(length, "page length", 1);
    integer(fillBytes, "fill grain");
    if (fillBytes > this.pageSize) throw new RangeError("fmap fill grain exceeds one page.");
    const base = integer(pageIndex * this.pageSize, "page file offset");
    const end = integer(base + offset + length, "page range end");
    if (offset + length > this.pageSize || end > this.fileSize) throw new RangeError("fmap page range exceeds its page or EOF.");
    const id = Number(this.core.fmap_fill_submit(BigInt(pageIndex), offset, length, fillBytes, priority === 1 ? 1 : 0));
    if (id === -4) throw new RangeError("fmap page demand exceeds the admission byte limit.");
    if (id <= 0) throw new Error(`Unable to submit fmap page demand (${id}).`);
    const callback = {};
    const promise = new Promise((resolve, reject) => { callback.resolve = resolve; callback.reject = reject; });
    this.callbacks.set(id, callback);
    this.#events();
    this.#wake();
    return { lease: callback.lease, promise, cancel: () => {
      this.core.fmap_fill_cancel(id);
      this.#events();
      this.#wake();
    } };
  }

  #wake() {
    if (this.closed || this.scheduled || !this.callbacks.size) return;
    this.scheduled = true;
    this.postTask(() => { this.scheduled = false; this.#pump(); });
  }

  #pump() {
    if (this.closed) return;
    let pointer;
    while ((pointer = Number(this.core.fmap_fill_poll()))) {
      const command = new DataView(this.core.memory.buffer, pointer, 24);
      const id = command.getUint32(0, true), length = command.getUint32(12, true);
      const offset = Number(command.getBigUint64(16, true));
      Promise.resolve().then(() => this.readFile(offset, length))
        .then((raw) => this.#complete(id, length, raw), (error) => this.#complete(id, length, null, error));
    }
    this.#events();
  }

  #complete(id, length, raw, error) {
    let success = false;
    try {
      // Stale reads settle their charged command but cannot obtain a write
      // pointer, even if the returned bytes are malformed.
      const pointer = Number(this.core.fmap_fill_prepare(id));
      if (pointer && !error) {
        let bytes;
        if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw);
        else if (ArrayBuffer.isView(raw)) bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
        else throw new TypeError("fmap file reader must return bytes.");
        if (bytes.byteLength !== length) throw new Error(`Truncated fmap fill: expected ${length} bytes, found ${bytes.byteLength}.`);
        new Uint8Array(this.core.memory.buffer, pointer, length).set(bytes);
        success = true;
      }
    } catch (cause) { error = cause; }
    this.core.fmap_fill_complete(id, success ? 1 : 0);
    this.#events(id, error);
    this.#wake();
  }

  getStats() {
    return Object.fromEntries(STAT_NAMES.map((name, index) => [name, Number(this.core.fmap_fill_stat(index))]));
  }

  setConcurrency(value) {
    this.concurrency = integer(value, "read concurrency", 1, 0xffffffff);
    this.core.fmap_fill_concurrency(value);
    this.#wake();
  }

  clear(generation) {
    integer(generation, "generation");
    if (generation <= this.generation) throw new RangeError("fmap clear requires a newer generation.");
    this.generation = generation;
    this.core.fmap_fill_clear();
    this.#events();
  }

  close() {
    if (this.closed) return;
    this.clear(this.generation + 1);
    this.closed = true;
    this.closeTasks?.();
  }
}
