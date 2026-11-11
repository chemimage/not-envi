// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, test, vi } from "vitest";
import workerSource from "../../src/io/fmap/fmap.worker.js?raw";

const wasmBytes = readFileSync(resolve("wasm/fmap/pkg/fmap_core.wasm"));

async function workerHarness() {
  const tasks = [];
  const replies = [];
  const reads = [];
  class MemoryBlob {
    constructor(values) { this.bytes = new Uint8Array(values.buffer); this.size = this.bytes.length; }
    slice(start, end) { return { bytes: this.bytes.slice(start, end), start }; }
  }
  class Reader {
    readAsArrayBuffer(blob) { reads.push(blob.start); return blob.bytes.buffer; }
  }
  class Channel {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = { postMessage: (data) => tasks.push(() => this.port1.onmessage({ data })) };
    }
  }
  const timer = vi.fn(() => { throw new Error("Worker batches must not depend on nested timers."); });
  const self = { postMessage: (message) => replies.push(message) };
  runInNewContext(workerSource, {
    self, Blob: MemoryBlob, FileReaderSync: Reader, MessageChannel: Channel,
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
  const turn = () => { expect(tasks.length).toBeGreaterThan(0); tasks.shift()(); };
  const drain = () => {
    let turns = 0;
    while (tasks.length) { if (++turns > 2048) throw new Error("Worker failed to drain its queue."); turn(); }
  };
  return { tasks, replies, reads, timer, send, window, turn, drain, values };
}

test("worker drains admitted jobs autonomously with one outstanding wake-up", async () => {
  const h = await workerHarness();
  await h.window(2);
  await h.window(3);
  expect(h.tasks).toHaveLength(1);
  h.drain();
  expect(h.replies.map((reply) => reply.id)).toEqual([2, 3]);
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
  h.turn();
  expect(h.reads.length).toBeGreaterThan(0);
  expect(h.replies).toHaveLength(0);
  await h.send({ id: 3, type: "spectrum", priority: 0, x: 0, y: 0, bandStart: 0, bandCount: 1 });
  expect(h.tasks).toHaveLength(1);
  h.turn();
  expect(h.replies.map((reply) => reply.id)).toEqual([3]);
  expect(new Float32Array(h.replies[0].result.buffer)[0]).toBe(0.25);
  await h.send({ id: 2, type: "cancel" });
  const readsAtCancel = h.reads.length;
  h.drain();
  expect(h.replies.find((reply) => reply.id === 2).error.name).toBe("AbortError");
  expect(h.reads).toHaveLength(readsAtCancel);
  expect(h.timer).not.toHaveBeenCalled();
});

test("clear cancels queued generations while a pending wake-up can service new work", async () => {
  const h = await workerHarness();
  await h.window(2);
  h.turn();
  await h.send({ id: 10, type: "clear", generation: 2 });
  expect(h.replies.find((reply) => reply.id === 2).error.name).toBe("AbortError");
  await h.send({ id: 3, type: "spectrum", generation: 2, priority: 0,
    x: 0, y: 0, bandStart: 0, bandCount: 1 });
  expect(h.tasks).toHaveLength(1);
  h.drain();
  const fresh = h.replies.find((reply) => reply.id === 3);
  expect(fresh.generation).toBe(2);
  expect(new Float32Array(fresh.result.buffer)[0]).toBe(0.25);
  expect(fresh.result.stats.pinnedBytes).toBe(0);
});
