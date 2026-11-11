import { describe, expect, test, vi } from "vitest";
import { createFmapDataSource } from "../../src/io/fmap/client.js";

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
    if (message.type === "clear" || message.type === "close") return;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    const respond = () => {
      this.active -= 1;
      let result = {};
      if (message.type === "open") result = { slotCount: 2, residentBytes: 8192 };
      if (message.type === "window") {
        const values = new Float32Array(message.requestedW * message.requestedH);
        values.set([1, 2, 3, 4].slice(0, values.length));
        result = { buffer: values.buffer, stats: { requestedBytes: 16, browserBytes: 8, copiedBytes: 16, usefulValues: 4 } };
      }
      if (message.type === "spectrum") result = { buffer: new Float32Array([3, 7]).buffer };
      this.onmessage?.({ data: { id: message.id, generation: message.generation, result } });
    };
    if (this.delay) setTimeout(respond, this.delay);
    else queueMicrotask(respond);
  }

  terminate() {
    this.terminated = true;
  }
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

describe("fmap client", () => {
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
    expect(worker.messages[0].wasmBytes).toBeInstanceOf(ArrayBuffer);
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
