import { afterEach, describe, expect, test, vi } from "vitest";
import { createAreaReductionWorkerClient } from "../../src/app/area-reduction-worker-client.js";

describe("area-reduction-worker-client", () => {
  const OriginalWorker = globalThis.Worker;
  const originalCreateObjectURL = globalThis.URL.createObjectURL;
  const originalRevokeObjectURL = globalThis.URL.revokeObjectURL;

  afterEach(() => {
    if (OriginalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = OriginalWorker;

    if (originalCreateObjectURL === undefined) delete globalThis.URL.createObjectURL;
    else globalThis.URL.createObjectURL = originalCreateObjectURL;

    if (originalRevokeObjectURL === undefined) delete globalThis.URL.revokeObjectURL;
    else globalThis.URL.revokeObjectURL = originalRevokeObjectURL;

    vi.restoreAllMocks();
  });

  test("falls back to local reduction when Worker is unavailable", async () => {
    delete globalThis.Worker;

    const client = createAreaReductionWorkerClient();
    const out = await client.reduce(new Float32Array([1, 2, Number.NaN, 4]), Uint32Array.from([0, 1, 2, 3]));

    expect(client.usingWorker()).toBe(false);
    expect(out).toEqual({ sum: 7, sumSq: 21, count: 3 });
  });

  test("uses the inline worker when it responds in time", async () => {
    class FakeWorker {
      constructor() {
        this.onmessage = null;
        this.onerror = null;
      }

      postMessage(msg) {
        const values = new Float32Array(msg.valuesBuffer);
        let sum = 0;
        let sumSq = 0;
        let count = 0;
        for (let i = 0; i < msg.indices.length; i += 1) {
          const v = values[msg.indices[i]];
          if (!Number.isFinite(v)) continue;
          sum += v;
          sumSq += (v * v);
          count += 1;
        }
        setTimeout(() => {
          if (this.onmessage) this.onmessage({ data: { id: msg.id, sum, sumSq, count } });
        }, 0);
      }

      terminate() {}
    }

    globalThis.Worker = FakeWorker;
    globalThis.URL.createObjectURL = vi.fn(() => "blob:area-worker");
    globalThis.URL.revokeObjectURL = vi.fn(() => {});

    const client = createAreaReductionWorkerClient({ timeoutMs: 50 });
    const out = await client.reduce(new Float32Array([1, 2, 3]), Uint32Array.from([0, 2]));

    expect(client.usingWorker()).toBe(true);
    expect(globalThis.URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ sum: 4, sumSq: 10, count: 2 });
  });

  test("falls back locally when the worker times out", async () => {
    class FakeWorker {
      constructor() {
        this.onmessage = null;
        this.onerror = null;
      }

      postMessage() {}

      terminate() {}
    }

    globalThis.Worker = FakeWorker;
    globalThis.URL.createObjectURL = vi.fn(() => "blob:area-worker");
    globalThis.URL.revokeObjectURL = vi.fn(() => {});

    const client = createAreaReductionWorkerClient({ timeoutMs: 1 });
    const out = await client.reduce(new Float32Array([2, 5, Number.NaN]), Uint32Array.from([0, 1, 2]));

    expect(out).toEqual({ sum: 7, sumSq: 29, count: 2 });
    expect(client.usingWorker()).toBe(false);
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
});
