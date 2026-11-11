import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const workerState = vi.hoisted(() => ({
  instances: [],
  postMessage: null
}));

vi.mock("../../src/io/fmap/tiff-codecs.worker.js?worker&inline", () => ({
  default: class FakeCodecWorker {
    constructor() {
      this.terminated = false;
      this.onmessage = null;
      this.onerror = null;
      workerState.instances.push(this);
    }

    postMessage(message, transfers) {
      return workerState.postMessage?.call(this, message, transfers);
    }

    terminate() {
      this.terminated = true;
    }
  }
}));

import { decodeBoundedTiffBlock } from "../../src/io/fmap/tiff-codecs.js";

const originalWorker = globalThis.Worker;

beforeEach(() => {
  globalThis.Worker = class WorkerAvailable {};
  workerState.instances.length = 0;
  workerState.postMessage = null;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalWorker === undefined) delete globalThis.Worker;
  else globalThis.Worker = originalWorker;
});

describe("bounded TIFF codec worker lifecycle", () => {
  test("terminates the worker and polling timer when postMessage throws synchronously", async () => {
    const clearTimer = vi.spyOn(globalThis, "clearInterval");
    workerState.postMessage = () => { throw new Error("transfer rejected"); };

    const promise = decodeBoundedTiffBlock(
      { Compression: 32773 },
      Uint8Array.from([0, 42]),
      1,
      { cancelled: () => false }
    );

    await expect(promise).rejects.toThrow("transfer rejected");
    expect(workerState.instances).toHaveLength(1);
    expect(workerState.instances[0].terminated).toBe(true);
    expect(clearTimer).toHaveBeenCalledTimes(1);
  });

  test("an additional generation signal immediately terminates an active worker", async () => {
    const request = new AbortController();
    const generation = new AbortController();
    const promise = decodeBoundedTiffBlock(
      { Compression: 8 },
      Uint8Array.from([1, 2, 3]),
      10,
      { signal: request.signal, signals: [generation.signal] }
    );

    expect(workerState.instances).toHaveLength(1);
    expect(workerState.instances[0].terminated).toBe(false);
    generation.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(workerState.instances[0].terminated).toBe(true);
  });

  test("does not post work when a generation signal is already aborted", async () => {
    const generation = new AbortController();
    generation.abort();
    const post = vi.fn();
    workerState.postMessage = post;

    await expect(decodeBoundedTiffBlock(
      { Compression: 8 },
      Uint8Array.from([1, 2, 3]),
      10,
      { signals: [generation.signal] }
    )).rejects.toMatchObject({ name: "AbortError" });

    expect(post).not.toHaveBeenCalled();
    expect(workerState.instances).toHaveLength(0);
  });

  test("a throwing cancellation poll also terminates the worker and timer", async () => {
    const clearTimer = vi.spyOn(globalThis, "clearInterval");
    let polls = 0;
    const promise = decodeBoundedTiffBlock(
      { Compression: 8 },
      Uint8Array.from([1, 2, 3]),
      10,
      { cancelled: () => {
        polls += 1;
        if (polls > 1) throw new Error("stale generation");
        return false;
      } }
    );

    await expect(promise).rejects.toThrow("stale generation");
    expect(workerState.instances[0].terminated).toBe(true);
    expect(clearTimer).toHaveBeenCalledTimes(1);
  });
});
