import { describe, expect, test, vi } from "vitest";
import { createFmapDataSource, createFmapRangeDataSource } from "../../src/io/fmap/client.js";

function meta() {
  return {
    samples: 2,
    lines: 2,
    bands: 2,
    headerOffset: 0,
    interleave: "bsq",
    dataType: 4,
    littleEndian: true,
    dataTypeInfo: { bytes: 4 }
  };
}

class FakeFmapWorker {
  constructor({ delay = 0 } = {}) {
    this.delay = delay;
    this.onmessage = null;
    this.onerror = null;
    this.messages = [];
    this.active = 0;
    this.maxActive = 0;
    this.terminated = false;
  }

  postMessage(message) {
    this.messages.push(message);
    if (message.type === "clear" || message.type === "close" || message.type === "setConcurrency") return;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    const respond = () => {
      this.active -= 1;
      let result = {};
      if (message.type === "open") {
        this.meta = message.meta;
        result = { slotCount: message.poolBytes / message.pageSize, residentBytes: message.poolBytes };
      }
      if (message.type === "configureRaster") this.meta = message.meta;
      if (message.type === "window") {
        const Ctor = Number(this.meta?.dataType) === 4 ? Float32Array : Float64Array;
        const values = new Ctor(message.requestedW * message.requestedH);
        values.set([1, 2, 3, 4].slice(0, values.length));
        result = { buffer: values.buffer, stats: { requestedBytes: 16, browserBytes: 8, copiedBytes: 16, usefulValues: 4 } };
      }
      if (message.type === "spectrum") {
        const Ctor = Number(this.meta?.dataType) === 4 ? Float32Array : Float64Array;
        result = { buffer: new Ctor([3, 7].slice(0, message.bandCount ?? 2)).buffer };
      }
      if (message.type === "range") {
        result = { buffer: Uint8Array.from({ length: message.length }, (_v, i) => message.offset + i).buffer };
      }
      this.onmessage?.({ data: { id: message.id, generation: message.generation, result } });
    };
    if (this.delay) setTimeout(respond, this.delay);
    else queueMicrotask(respond);
  }

  terminate() {
    this.terminated = true;
  }
}

class ManualWorker {
  messages = [];
  postMessage(message) {
    this.messages.push(message);
    if (message.type === "open") queueMicrotask(() => this.respond(message, { residentBytes: 8192 }));
  }
  respond(message, result = { buffer: new Float32Array([3, 7]).buffer }) {
    this.onmessage({ data: { id: message.id, generation: message.generation, result } });
  }
  terminate() {}
  requests() { return this.messages.filter((message) => message.type === "spectrum" || message.type === "window"); }
}

function createSource(worker, options = {}) {
  const file = new Blob([new Uint8Array(32)]);
  return createFmapDataSource(file, meta(), {
    wasmBytes: new Uint8Array([0, 97, 115, 109]),
    workerFactory: () => worker,
    pageSize: 4096,
    poolBytes: 8192,
    ...options
  });
}

function createTypedSource(worker, typedMeta, options = {}) {
  const bytes = typedMeta.samples * typedMeta.lines * typedMeta.bands * typedMeta.dataTypeInfo.bytes;
  return createFmapDataSource(new Blob([new Uint8Array(bytes)]), typedMeta, {
    wasmBytes: new Uint8Array([0, 97, 115, 109]), workerFactory: () => worker,
    pageSize: 4096, poolBytes: 8192, ...options
  });
}

describe("fmap client", () => {
  test("binds raster metadata to an existing range worker without creating another pool", async () => {
    const worker = new FakeFmapWorker();
    const source = createFmapRangeDataSource(new Blob([new Uint8Array(32)]), {
      wasmBytes: new Uint8Array([0, 97, 115, 109]), workerFactory: () => worker,
      pageSize: 4096, poolBytes: 8192
    });
    try {
      await source.configureRaster({ ...meta(), dataTypeInfo: { bytes: 4, ctor: Float32Array } });
      expect(source.managesWindowOutput).toBe(true);
      expect(Array.from(await source.readBandWindow(source.meta, 0, 0, 0, 2, 2, 1))).toEqual([1, 2, 3, 4]);
      expect(worker.messages.filter((message) => message.type === "open")).toHaveLength(1);
      expect(worker.messages.filter((message) => message.type === "configureRaster")).toHaveLength(1);
      await expect(source.configureRaster(meta())).rejects.toThrow("already configured");
    } finally { source.close(); }
  });

  test("clear before a delayed open leaves initialization and later reads usable", async () => {
    const worker = new ManualWorker();
    worker.postMessage = (message) => worker.messages.push(message);
    const source = createSource(worker);
    source.clear();
    expect(worker.messages.map((message) => message.type)).toEqual(["open"]);
    worker.respond(worker.messages[0], { residentBytes: 4096 });
    await source.ready;
    const read = source.readSpectrumAtPixel(meta(), 0, 0);
    await Promise.resolve();
    worker.respond(worker.requests()[0]);
    expect(Array.from(await read)).toEqual([3, 7]);
    source.close();
  });

  test("coalesces concurrent stats polls into one pending worker message", async () => {
    const worker = new ManualWorker();
    const source = createSource(worker);
    await source.ready;
    const reads = Array.from({ length: 100 }, () => source.getStats());
    await Promise.resolve();
    const messages = worker.messages.filter((message) => message.type === "stats");
    expect(messages).toHaveLength(1);
    worker.respond(messages[0], { stats: { browserBytes: 37 } });
    const snapshots = await Promise.all(reads);
    snapshots[0].browserBytes = 99;
    expect(snapshots[1].browserBytes).toBe(37);
    source.close();
  });

  test("a smaller speculative read cannot leapfrog a foreground read blocked by bytes", async () => {
    const worker = new ManualWorker();
    const source = createSource(worker, { concurrency: 4, maxInflightBytes: 8208 });
    await source.ready;
    const first = source.readSpectrumAtPixel(meta(), 0, 0);
    await Promise.resolve();
    const foreground = source.readBandWindow(meta(), 0, 0, 0, 2, 2, 1);
    const background = source.readSpectrumAtPixel(meta(), 1, 0, { priority: "background" });
    await Promise.resolve();
    expect(worker.requests()).toHaveLength(1);
    worker.respond(worker.requests()[0]);
    await first;
    expect(worker.requests().map((message) => message.type)).toEqual(["spectrum", "window"]);
    worker.respond(worker.requests()[1], { buffer: new Float32Array([1, 2, 3, 4]).buffer });
    await foreground;
    expect(worker.requests().map((message) => message.type)).toEqual(["spectrum", "window", "spectrum"]);
    worker.respond(worker.requests()[2]);
    await background;
    source.close();
  });

  test("a throwing cancellation predicate settles the read and releases its reservation", async () => {
    const worker = new ManualWorker();
    const source = createSource(worker);
    await source.ready;
    let fail = false;
    const read = source.readSpectrumAtPixel(meta(), 0, 0, { cancelled: () => {
      if (fail) throw new Error("predicate failed");
      return false;
    } });
    const outcome = read.catch((error) => error);
    await Promise.resolve();
    fail = true;
    worker.respond(worker.requests()[0]);
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(source.stats.logicalBytesReserved).toBe(0);
    expect(source.stats.activeRequests).toBe(0);
    source.close();
  });

  test("defers read-concurrency updates until the asynchronous open is acknowledged", async () => {
    const worker = new ManualWorker();
    const source = createSource(worker);
    source.setConcurrency(5);
    expect(worker.messages.filter((message) => message.type === "setConcurrency")).toHaveLength(0);
    await source.ready;
    expect(worker.messages.filter((message) => message.type === "setConcurrency")).toEqual([
      { type: "setConcurrency", generation: 1, readConcurrency: 5 }
    ]);
    source.close();
  });

  test.each([[32, 4096], [4097, 8192], [12289, 8192]])(
    "allocates a bounded page-rounded pool for a %i-byte file",
    async (fileBytes, allocatedBytes) => {
      const worker = new FakeFmapWorker();
      const source = createFmapRangeDataSource(new Blob([new Uint8Array(fileBytes)]), {
        wasmBytes: new Uint8Array([0, 97, 115, 109]), workerFactory: () => worker,
        pageSize: 4096, poolBytes: 8192
      });
      try {
        await source.ready;
        expect(worker.messages.find((message) => message.type === "open").poolBytes).toBe(allocatedBytes);
        expect(source.cacheBytes()).toBe(allocatedBytes);
        expect(source.maxBytes).toBe(8192);
      } finally { source.close(); }
    }
  );

  test("waits through more than 64 demands while admitted count and bytes stay bounded", async () => {
    const worker = new ManualWorker();
    const source = createSource(worker, { concurrency: 1, maxQueuedRequests: 1, maxQueuedBytes: 4104, maxResultBytes: 16 });
    await source.ready;
    const reads = Array.from({ length: 100 }, () => source.readSpectrumAtPixel(meta(), 0, 0));
    await Promise.resolve();
    expect(source.stats.queuedRequests).toBe(1);
    expect(source.stats.queuedBytes).toBe(4104);
    expect(source.stats.waitingRequests).toBe(98);
    expect(worker.requests()).toHaveLength(1);
    for (let index = 0; index < reads.length; index += 1) {
      worker.respond(worker.requests()[index]);
      expect(Array.from(await reads[index])).toEqual([3, 7]);
    }
    expect(source.stats.peakQueuedRequests).toBe(1);
    expect(source.stats.peakQueuedBytes).toBe(4104);
    expect(source.stats.waitingRequests).toBe(0);
    expect(source.stats.rejectedRequests).toBe(0);
    expect(source.stats.inflightBytes).toBe(0);
    source.close();
  });

  test("waits for logical output capacity before allocating a result and gives foreground precedence", async () => {
    let allocations = 0;
    class Output extends Float32Array { constructor(length) { super(length); allocations += 1; } }
    const rasterMeta = { ...meta(), dataTypeInfo: { bytes: 4, ctor: Output } };
    const worker = new ManualWorker();
    const source = createTypedSource(worker, rasterMeta, { concurrency: 1, maxLogicalBytes: 16 });
    await source.ready;
    const first = source.readBandWindow(rasterMeta, 0, 0, 0, 2, 2, 1);
    const background = source.readBandWindow(rasterMeta, 0, 0, 0, 2, 2, 1, null, { priority: "background" });
    const foreground = source.readBandWindow(rasterMeta, 1, 0, 0, 2, 2, 1);
    await Promise.resolve();
    expect(allocations).toBe(1);
    expect(source.stats.waitingLogicalRequests).toBe(2);
    expect(source.stats.logicalBytesReserved).toBe(16);
    worker.respond(worker.requests()[0], { buffer: new Float32Array(4).buffer });
    await first;
    await Promise.resolve();
    expect(worker.requests()[1].band).toBe(1);
    expect(allocations).toBe(2);
    worker.respond(worker.requests()[1], { buffer: new Float32Array(4).buffer });
    await foreground;
    await Promise.resolve();
    worker.respond(worker.requests()[2], { buffer: new Float32Array(4).buffer });
    await background;
    expect(source.stats.peakLogicalBytes).toBe(16);
    expect(source.stats.logicalBytesReserved).toBe(0);
    source.close();
  });

  test("control stats bypass a saturated data queue without consuming execution bytes", async () => {
    const worker = new ManualWorker();
    const source = createSource(worker, { concurrency: 1, maxQueuedRequests: 1, maxQueuedBytes: 4104 });
    await source.ready;
    const reads = Array.from({ length: 3 }, () => source.readSpectrumAtPixel(meta(), 0, 0));
    await Promise.resolve();
    const before = source.stats.inflightBytes;
    const stats = source.getStats();
    await Promise.resolve();
    const message = worker.messages.find((request) => request.type === "stats");
    expect(message).toBeDefined();
    expect(source.stats.activeRequests).toBe(1);
    expect(source.stats.inflightBytes).toBe(before);
    worker.respond(message, {});
    await stats;
    for (let index = 0; index < reads.length; index += 1) {
      worker.respond(worker.requests()[index]);
      await reads[index];
    }
    source.close();
  });

  test("rejects a single impossible logical reservation instead of waiting forever", async () => {
    const worker = new ManualWorker();
    const source = createSource(worker, { maxLogicalBytes: 4 });
    await source.ready;
    await expect(source.readSpectrumAtPixel(meta(), 0, 0)).rejects.toThrow(/assembly budget/);
    expect(source.stats.waitingLogicalRequests).toBe(0);
    expect(worker.requests()).toEqual([]);
    source.close();
  });

  test("an aborted descriptor beyond the admitted queue never reaches the worker", async () => {
    const worker = new ManualWorker();
    const source = createSource(worker, { concurrency: 1, maxQueuedRequests: 1 });
    await source.ready;
    const first = source.readSpectrumAtPixel(meta(), 0, 0);
    const second = source.readSpectrumAtPixel(meta(), 1, 0);
    const controller = new AbortController();
    const waiting = source.readSpectrumAtPixel(meta(), 1, 1, { signal: controller.signal });
    const outcome = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    expect(source.stats.waitingRequests).toBe(1);
    controller.abort();
    await outcome;
    expect(source.stats.waitingRequests).toBe(0);
    worker.respond(worker.requests()[0]);
    await first;
    worker.respond(worker.requests()[1]);
    await second;
    expect(worker.requests()).toHaveLength(2);
    source.close();
  });

  test.each(["abort", "clear", "close", "supersede", "callback"])("cancels a logical descriptor waiting for capacity: %s", async (kind) => {
    const worker = new ManualWorker();
    const source = createSource(worker, { concurrency: 1, maxLogicalBytes: 8 });
    await source.ready;
    const active = source.readSpectrumAtPixel(meta(), 0, 0);
    const activeOutcome = active.catch((error) => error);
    const controller = new AbortController();
    let cancelled = false;
    const options = { signal: controller.signal, cancelled: () => cancelled, supersedeKey: "waiting" };
    const waiting = source.readSpectrumAtPixel(meta(), 1, 0, options);
    const outcome = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    await Promise.resolve();
    expect(source.stats.waitingLogicalRequests).toBe(1);
    let replacement;
    if (kind === "abort") controller.abort();
    if (kind === "clear") source.clear();
    if (kind === "close") source.close();
    if (kind === "supersede") replacement = source.readSpectrumAtPixel(meta(), 1, 1, { supersedeKey: "waiting" });
    if (kind === "callback") cancelled = true;
    await outcome;
    expect(worker.requests()).toHaveLength(1);
    if (kind !== "close") worker.respond(worker.requests()[0]);
    await activeOutcome;
    if (replacement) {
      await Promise.resolve();
      worker.respond(worker.requests()[1]);
      await replacement;
    }
    expect(source.stats.waitingLogicalRequests).toBe(0);
    source.close();
  });

  test("assembles oversized windows from bounded chunks and accounts logical output", async () => {
    const worker = new FakeFmapWorker();
    const source = createSource(worker, { maxResultBytes: 8, maxInflightBytes: 4104, maxLogicalResultBytes: 64 });
    await source.ready;

    const destination = new Float32Array(9);
    const values = await source.readBandWindow(meta(), 0, 0, 0, 3, 3, 1, destination, { supersedeKey: "viewport" });

    expect(values).toBeInstanceOf(Float32Array);
    expect(Array.from(values)).toEqual([1, 2, 0, 1, 2, 0, 0, 0, 0]);
    const chunks = worker.messages.filter((message) => message.type === "window");
    expect(chunks).toHaveLength(2);
    expect(chunks.every((message) => message.requestedW * message.requestedH * 4 <= 8)).toBe(true);
    expect(source.stats.peakLogicalBytes).toBe(36);
    expect(source.stats.logicalBytesReserved).toBe(0);
    source.close();
  });

  test("rejects logical output above its assembly cap before worker dispatch", async () => {
    const worker = new FakeFmapWorker();
    const source = createSource(worker, { maxLogicalResultBytes: 8 });
    await source.ready;

    await expect(source.readBandWindow(meta(), 0, 0, 0, 2, 2, 1)).rejects.toThrow(/assembly budget/);
    expect(worker.messages.filter((message) => message.type === "window")).toHaveLength(0);
    expect(source.stats.logicalBytesReserved).toBe(0);
    source.close();
  });

  test("neutral range source returns owned bytes and chunks at the result cap", async () => {
    const worker = new FakeFmapWorker();
    const source = createFmapRangeDataSource(new Blob([new Uint8Array(32)]), {
      wasmBytes: new Uint8Array([0, 97, 115, 109]), workerFactory: () => worker,
      pageSize: 4096, poolBytes: 8192, maxResultBytes: 5, maxInflightBytes: 4101
    });
    await source.ready;

    const values = await source.readRange(3, 12);

    expect(Array.from(values)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(worker.messages.filter((message) => message.type === "range")).toHaveLength(3);
    await expect(source.readRange(30, 3)).rejects.toThrow(/EOF/);
    source.close();
  });

  test("keeps cancelled active bytes reserved until ACK and isolates queued aborts", async () => {
    const worker = new ManualWorker();
    const source = createSource(worker, { concurrency: 2, maxInflightBytes: 4104 });
    await source.ready;
    const activeAbort = new AbortController();
    const queuedAbort = new AbortController();
    const active = source.readSpectrumAtPixel(meta(), 0, 0, { signal: activeAbort.signal });
    const queued = source.readSpectrumAtPixel(meta(), 1, 0, { signal: queuedAbort.signal });
    await Promise.resolve();
    queuedAbort.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    activeAbort.abort();
    await expect(active).rejects.toMatchObject({ name: "AbortError" });
    expect(source.stats.inflightBytes).toBe(4104);
    const newest = source.readSpectrumAtPixel(meta(), 1, 1);
    await Promise.resolve();
    expect(worker.requests()).toHaveLength(1);
    worker.respond(worker.requests()[0]);
    expect(worker.requests()).toHaveLength(2);
    worker.respond(worker.requests()[1]);
    await newest;
    expect(source.stats.peakInflightBytes).toBeLessThanOrEqual(4104);
    source.close();
  });

  test("dispatches foreground ahead of background and supersedes only matching keys", async () => {
    const worker = new ManualWorker();
    const source = createSource(worker, { concurrency: 1 });
    await source.ready;
    const active = source.readSpectrumAtPixel(meta(), 0, 0);
    const background = source.readSpectrumAtPixel(meta(), 1, 0, { priority: "background" });
    const obsolete = source.readSpectrumAtPixel(meta(), 1, 1, { supersedeKey: "panel-1" });
    await Promise.resolve();
    const latest = source.readSpectrumAtPixel(meta(), 0, 1, { supersedeKey: "panel-1" });
    await expect(obsolete).rejects.toMatchObject({ name: "AbortError" });
    worker.respond(worker.requests()[0]);
    await active;
    expect(worker.requests()[1]).toMatchObject({ x: 0, y: 1, priority: 0 });
    worker.respond(worker.requests()[1]);
    await latest;
    expect(worker.requests()[2]).toMatchObject({ x: 1, y: 0, priority: 1 });
    worker.respond(worker.requests()[2]);
    await background;
    source.close();
  });

  test("a replacement reclaims the superseded logical-result reservation", async () => {
    const worker = new ManualWorker();
    const source = createSource(worker, { concurrency: 1, maxLogicalResultBytes: 8, maxLogicalBytes: 8 });
    await source.ready;
    const first = source.readSpectrumAtPixel(meta(), 0, 0, { supersedeKey: "probe" });
    const latest = source.readSpectrumAtPixel(meta(), 1, 1, { supersedeKey: "probe" });

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(source.stats.logicalBytesReserved).toBe(8);
    await Promise.resolve();
    expect(worker.requests()).toHaveLength(1);
    worker.respond(worker.requests()[0]);
    await latest;
    expect(source.stats.logicalBytesReserved).toBe(0);
    source.close();
  });

  test("foreground preempts background blocked by the byte limit and waits for its ACK", async () => {
    const worker = new ManualWorker();
    const source = createSource(worker, { concurrency: 2, maxInflightBytes: 4104 });
    await source.ready;
    const background = source.readSpectrumAtPixel(meta(), 0, 0, { priority: "background" });
    await Promise.resolve();
    const foreground = source.readSpectrumAtPixel(meta(), 1, 0);
    await expect(background).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.requests()).toHaveLength(1);
    expect(worker.messages.at(-1).type).toBe("cancel");
    expect(source.stats.inflightBytes).toBe(4104);
    worker.respond(worker.requests()[0]);
    expect(worker.requests()).toHaveLength(2);
    worker.respond(worker.requests()[1]);
    await foreground;
    expect(source.stats.inflightBytes).toBe(0);
    source.close();
  });

  test("diagnostic snapshots do not preempt an active background job", async () => {
    const worker = new ManualWorker();
    const source = createSource(worker, { concurrency: 1 });
    await source.ready;
    const background = source.readSpectrumAtPixel(meta(), 0, 0, { priority: "background" });
    await Promise.resolve();
    const snapshot = source.getStats();
    await Promise.resolve();
    expect(worker.messages.some((message) => message.type === "cancel")).toBe(false);
    const statsMessage = worker.messages.find((message) => message.type === "stats");
    worker.respond(statsMessage, { stats: { browserBytes: 4 } });
    expect((await snapshot).activeRequests).toBe(1);
    worker.respond(worker.requests()[0]);
    await background;
    source.close();
  });

  test("reclaims obsolete queued work before admitting a new viewport", async () => {
    const worker = new ManualWorker();
    const source = createSource(worker, { concurrency: 1, maxQueuedRequests: 1 });
    await source.ready;
    let obsolete = false;
    const active = source.readSpectrumAtPixel(meta(), 0, 0);
    const oldView = source.readSpectrumAtPixel(meta(), 1, 0, { cancelled: () => obsolete });
    await Promise.resolve();
    obsolete = true;
    const newView = source.readSpectrumAtPixel(meta(), 0, 1);
    await expect(oldView).rejects.toMatchObject({ name: "AbortError" });
    worker.respond(worker.requests()[0]);
    await active;
    expect(worker.requests()[1]).toMatchObject({ x: 0, y: 1 });
    worker.respond(worker.requests()[1]);
    await newView;
    expect(source.stats.rejectedRequests).toBe(0);
    source.close();
  });

  test("expires background work without leaking reservations and closes fatally crashed workers", async () => {
    vi.useFakeTimers();
    try {
      const worker = new ManualWorker();
      const source = createSource(worker, { concurrency: 1 });
      await vi.advanceTimersByTimeAsync(0);
      await source.ready;
      const active = source.readSpectrumAtPixel(meta(), 0, 0);
      const expired = source.readSpectrumAtPixel(meta(), 1, 0, { priority: "background", maxAgeMs: 5 });
      const rejected = expect(expired).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(20);
      await rejected;
      expect(worker.requests()).toHaveLength(1);
      const failed = expect(active).rejects.toThrow(/crashed/);
      worker.onerror();
      await failed;
      expect(source.closed).toBe(true);
      expect(source.stats.inflightBytes).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  test("opens a user Blob and exposes BSQ Float32 window and spectrum operations", async () => {
    const worker = new FakeFmapWorker();
    const source = createSource(worker);
    await source.ready;

    const destination = new Float32Array(4);
    expect(await source.readBandWindow(meta(), 1, 0, 0, 2, 2, 1, destination)).toBe(destination);
    expect(Array.from(destination)).toEqual([1, 2, 3, 4]);
    expect(Array.from(await source.readSpectrumAtPixel(meta(), 1, 1))).toEqual([3, 7]);
    expect(source.stats.browserBytes).toBe(8);
    expect(worker.messages[0].file).toBeInstanceOf(Blob);
    expect(worker.messages[0].protocolVersion).toBe(1);
    expect(worker.messages[0].maxCoalescedOverreadRatio).toBe(14);
    expect(worker.messages[0].wasmBytes).toBeInstanceOf(ArrayBuffer);
  });

  test.each([
    [1, 1, Uint8Array], [2, 2, Int16Array], [3, 4, Int32Array], [4, 4, Float32Array],
    [5, 8, Float64Array], [12, 2, Uint16Array], [13, 4, Uint32Array],
    [14, 8, Float64Array], [15, 8, Float64Array]
  ])("data type %i returns the released backend window type", async (dataType, bytes, Expected) => {
    const worker = new FakeFmapWorker();
    const typedMeta = { ...meta(), dataType, dataTypeInfo: { bytes, ctor: [14, 15].includes(dataType) ? null : Expected }, interleave: "bip" };
    const source = createTypedSource(worker, typedMeta);
    await source.ready;

    const values = await source.readBandWindow(typedMeta, 0, 0, 0, 2, 2, 1);

    expect(values).toBeInstanceOf(Expected);
    expect(Array.from(values)).toEqual([1, 2, 3, 4]);
    expect(await source.readSpectrumAtPixel(typedMeta, 0, 0)).toBeInstanceOf(Float32Array);
    source.close();
  });

  test("uses Float64 windows when metadata has no native constructor", async () => {
    const worker = new FakeFmapWorker();
    const typedMeta = { ...meta(), dataType: 1, dataTypeInfo: { bytes: 1 } };
    const source = createTypedSource(worker, typedMeta);
    await source.ready;
    expect(await source.readBandWindow(typedMeta, 0, 0, 0, 2, 2, 1)).toBeInstanceOf(Float64Array);
    source.close();
  });

  test("bounds aggregate worker requests by source concurrency", async () => {
    const worker = new FakeFmapWorker({ delay: 5 });
    const source = createSource(worker, { concurrency: 1 });
    await source.ready;
    await Promise.all([
      source.readSpectrumAtPixel(meta(), 0, 0),
      source.readSpectrumAtPixel(meta(), 1, 0),
      source.readSpectrumAtPixel(meta(), 0, 1)
    ]);
    expect(worker.maxActive).toBe(1);
  });

  test("clear rejects active work and discards its late result", async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeFmapWorker({ delay: 10 });
      const source = createSource(worker);
      const ready = source.ready;
      await vi.advanceTimersByTimeAsync(10);
      await ready;
      const pending = source.readSpectrumAtPixel(meta(), 0, 0);
      await Promise.resolve();
      source.clear();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(10);
      expect(source.generation).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("requires a real WASM artifact and releases the worker on close", async () => {
    const file = new Blob([new Uint8Array(32)]);
    expect(() => createFmapDataSource(file, meta(), { workerFactory: () => new FakeFmapWorker() }))
      .toThrow(/WASM artifact is unavailable/);

    const worker = new FakeFmapWorker();
    const source = createSource(worker);
    await source.ready;
    source.close();
    expect(worker.terminated).toBe(true);
    await expect(source.readSpectrumAtPixel(meta(), 0, 0)).rejects.toThrow(/closed/);
  });
});
