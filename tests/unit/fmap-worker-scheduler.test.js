// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, test, vi } from "vitest";
import workerSource from "../../src/io/fmap/fmap.worker.js?raw";
import { FmapPageFillQueue } from "../../src/io/fmap/page-fill-queue.js";
import { createReduction, REDUCTION_BYTES } from "../../src/io/fmap/reduction.js";
import { createSourceReadMonitor } from "../../src/core/source-read-monitor.js";

const wasmBytes = readFileSync(resolve("wasm/fmap/pkg/fmap_core.wasm"));

async function workerHarness() {
  const tasks = [];
  const replies = [];
  const reads = [];
  class MemoryBlob {
    constructor(values) { this.bytes = new Uint8Array(values.buffer); this.size = this.bytes.length; }
    slice(start, end) {
      return { arrayBuffer: async () => { reads.push(start); return this.bytes.slice(start, end).buffer; } };
    }
  }
  class Channel {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = { postMessage: (data) => tasks.push(() => this.port1.onmessage({ data })) };
    }
  }
  const timer = vi.fn(() => { throw new Error("Worker batches must not depend on nested timers."); });
  const self = { postMessage: (message) => replies.push(message) };
  class Queue extends FmapPageFillQueue {
    constructor(options) { super({ ...options, postTask: (callback) => tasks.push(callback) }); }
  }
  // Evaluate the worker against real WASM with a deterministic task dispatcher.
  // Production uses Vite's bundled module worker; its dependencies are injected.
  runInNewContext(workerSource.replace(/^import .*;\r?\n/gm, ""), {
    self, Blob: MemoryBlob, FmapPageFillQueue: Queue, MessageChannel: Channel,
    createReduction, REDUCTION_BYTES, createSourceReadMonitor: () => createSourceReadMonitor({ now: () => 0 }),
    WebAssembly, Uint8Array, Float32Array, Float64Array, DataView,
    performance: { now: () => 0 }, setTimeout: timer
  });
  const values = Float32Array.from({ length: 512 * 512 }, (_v, index) => index + 0.25);
  const send = (message) => self.onmessage({ data: { generation: 1, ...message } });
  await send({ id: 1, type: "open", protocolVersion: 1, file: new MemoryBlob(values), wasmBytes,
    meta: { samples: 512, lines: 512, bands: 1, headerOffset: 0, interleave: "bsq",
      dataType: 4, bytesPerValue: 4, littleEndian: true },
    pageSize: 4096, poolBytes: 8192, maxResultBytes: 1024 * 1024, batchBytes: 4096,
    sparseReadThresholdBytes: 32768, sparseReadMaxGapBytes: 4096, maxCoalescedOverreadRatio: 14 });
  expect(replies[0].error).toBeUndefined();
  replies.length = 0;
  const window = (id, priority = 1) => send({ id, type: "window", priority,
    band: 0, x0: 0, y0: 0, outW: 512, outH: 512, requestedW: 512, requestedH: 512, step: 1 });
  const turn = async () => {
    expect(tasks.length).toBeGreaterThan(0);
    tasks.shift()();
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  };
  const drain = async () => {
    let turns = 0;
    while (tasks.length) { if (++turns > 4096) throw new Error("Worker failed to drain its queue."); await turn(); }
  };
  return { tasks, replies, reads, timer, send, window, turn, drain, values };
}

test("worker drains admitted jobs autonomously with one outstanding wake-up", async () => {
  const h = await workerHarness();
  await h.window(2);
  await h.window(3);
  expect(h.tasks).toHaveLength(1);
  await h.drain();
  expect(h.replies.map((reply) => reply.id).sort()).toEqual([2, 3]);
  for (const reply of h.replies) {
    expect(reply.error).toBeUndefined();
    expect(new Float32Array(reply.result.buffer)).toEqual(h.values);
    expect(reply.result.stats.pinnedBytes).toBe(0);
  }
  expect(h.timer).not.toHaveBeenCalled();
  expect(h.tasks).toHaveLength(0);
});

test("new foreground work runs between background batches and cancellation removes unfinished work", async () => {
  const h = await workerHarness();
  await h.window(2);
  await h.turn();
  await h.turn();
  expect(h.reads.length).toBeGreaterThan(0);
  expect(h.replies).toHaveLength(0);
  await h.send({ id: 3, type: "spectrum", priority: 0, x: 0, y: 0, bandStart: 0, bandCount: 1 });
  expect(h.tasks).toHaveLength(1);
  await h.turn();
  expect(h.replies.map((reply) => reply.id)).toEqual([3]);
  expect(new Float32Array(h.replies[0].result.buffer)[0]).toBe(0.25);
  await h.send({ id: 2, type: "cancel" });
  const readsAtCancel = h.reads.length;
  await h.drain();
  expect(h.replies.find((reply) => reply.id === 2).error.name).toBe("AbortError");
  expect(h.reads).toHaveLength(readsAtCancel);
  expect(h.timer).not.toHaveBeenCalled();
});

test("clear cancels queued generations while pending wake-ups can service new work", async () => {
  const h = await workerHarness();
  await h.window(2);
  await h.turn();
  await h.send({ id: 10, type: "clear", generation: 2 });
  expect(h.replies.find((reply) => reply.id === 2).error.name).toBe("AbortError");
  await h.send({ id: 3, type: "spectrum", generation: 2, priority: 0,
    x: 0, y: 0, bandStart: 0, bandCount: 1 });
  expect(h.tasks.length).toBeLessThanOrEqual(2); // At most one wake-up per scheduling layer.
  await h.drain();
  const fresh = h.replies.find((reply) => reply.id === 3);
  expect(fresh.generation).toBe(2);
  expect(new Float32Array(fresh.result.buffer)[0]).toBe(0.25);
  expect(fresh.result.stats.pinnedBytes).toBe(0);
});

test("interleaved reductions own compact results and cancelled reductions release leases", async () => {
  const h = await workerHarness();
  const reduce = id => h.send({ id, type: "reduce", band: 0, x0: 0, y0: 0,
    outW: 512, outH: 512, requestedW: 512, requestedH: 512, step: 1, bins: 0 });
  await reduce(2);
  await reduce(3);
  await h.turn();
  await h.turn();
  await h.send({ id: 2, type: "cancel" });
  await h.drain();
  expect(h.replies.find(reply => reply.id === 2).error.name).toBe("AbortError");
  const result = h.replies.find(reply => reply.id === 3);
  expect(result.error).toBeUndefined();
  const values = new Float64Array(result.result.buffer);
  expect(values.length).toBe(261);
  expect(Array.from(values.subarray(0, 3))).toEqual([0.25, 262143.25, 262144]);
  expect(result.result.stats.pinnedBytes).toBe(0);
});
