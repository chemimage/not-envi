import { describe, expect, test } from "vitest";
import { createPyramidCompositionClient } from "../../src/render/pyramid-composition-client.js";
import { createPyramidCompositionEngine } from "../../src/render/workers/pyramid-composition.worker.js";
import { computeHistogram } from "../../src/render/display-math.js";

function job(viewKey = "view", value = 20, key = "1:0") {
  const tile = { level: 0, w: 4, data: new Float32Array(16).fill(value) };
  return { key, viewKey, geometry: { w: 4, h: 4, idealLevel: 0 }, uint8: true, requiredPixels: 16,
    operations: [{ tile, key: "tile", rect: { x: 0, y: 0, w: 4, h: 4 },
      factor: 1, originX: 0, originY: 0, tileX: 0, tileY: 0 }] };
}

function harness() {
  const engine = createPyramidCompositionEngine();
  const sent = [];
  const worker = { terminated: false, postMessage: (message, transfer) => sent.push({ message, transfer }),
    terminate() { this.terminated = true; } };
  const client = createPyramidCompositionClient(4096, { workerFactory: () => worker });
  const flush = () => {
    const { message } = sent.shift();
    const result = engine.compose(message);
    worker.onmessage({ data: { id: message.id, result } });
    return result;
  };
  return { engine, worker, client, sent, flush };
}

describe("pyramid composition worker boundary", () => {
  test("worker snapshots preserve plane and source ownership, skip acknowledged inputs, and retain exact statistics", async () => {
    const h = harness(), input = job();
    const firstPromise = h.client.compose(input);
    expect(h.client.stats.mode).toBe("worker");
    expect(h.sent[0].message.operations[0].tile.data.buffer).not.toBe(input.operations[0].tile.data.buffer);
    expect(h.sent[0].transfer).toContain(h.sent[0].message.operations[0].tile.data.buffer);
    h.flush(); const first = await firstPromise;
    expect(first.histogramStats).toEqual(computeHistogram(input.operations[0].tile.data));
    expect(first.data).not.toBe(h.engine.cache.peek(input.key, input.viewKey).data);
    expect(input.operations[0].tile.data.byteLength).toBe(64);
    const again = h.client.compose(input);
    expect(h.sent[0].message.operations).toEqual([]);
    h.flush(); const second = await again;
    expect(second.compositionId).toBe(first.compositionId);
    expect(second.revision).toBe(first.revision);
    expect(second.changedPixels).toBe(0);
    expect(second.dirtyRects).toEqual([]);
    const changed = h.client.compose(job("view", 80));
    h.flush(); const third = await changed;
    expect(first.data.every((value) => value === 20)).toBe(true);
    expect(third.data.every((value) => value === 80)).toBe(true);
    expect(third.revision).toBe(second.revision + 1);
    h.client.dispose();
  });

  test("only the latest queued scope is copied and obsolete results cannot resolve", async () => {
    const h = harness();
    const settle = (promise) => promise.then(() => "resolved", (error) => error.name);
    const first = settle(h.client.compose(job("old", 1)));
    const middle = settle(h.client.compose(job("middle", 2)));
    const latest = h.client.compose(job("latest", 3));
    expect(h.sent).toHaveLength(1);
    expect(await first).toBe("AbortError");
    expect(await middle).toBe("AbortError");
    h.flush();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].message.viewKey).toBe("latest");
    h.flush(); expect((await latest).data[0]).toBe(3);
    expect(h.client.stats.inputBytes).toBe(128);
    expect(h.client.stats.cancelledJobs).toBe(2);
    h.client.dispose();
  });

  test("worker failure replays unacknowledged inputs using an explicit local fallback", async () => {
    const h = harness(), input = job("view", 70);
    const promise = h.client.compose(input);
    h.worker.onerror(new Error("worker crashed"));
    const result = await promise;
    expect(result.data[0]).toBe(70);
    expect(h.client.stats.mode).toBe("sync");
    expect(h.client.stats.fallbackReason).toBe("worker crashed");
    expect(h.worker.terminated).toBe(true);
    expect(input.operations[0].tile.data[0]).toBe(70);
    h.client.dispose();
  });

  test("clear aborts active and queued jobs, frees mirrors and never reuses old composition identities", async () => {
    const h = harness();
    const old = h.client.compose(job()); h.flush();
    const oldId = (await old).compositionId;
    const active = h.client.compose(job("a")).catch((error) => error.name);
    const queued = h.client.compose(job("b", 2, "2:0")).catch((error) => error.name);
    h.client.clear();
    expect(await active).toBe("AbortError"); expect(await queued).toBe("AbortError");
    expect(h.client.bytes).toBe(0); expect(h.client.entries.size).toBe(0);
    h.sent.length = 0;
    const next = h.client.compose(job()); h.flush();
    expect((await next).compositionId).not.toBe(oldId);
    h.client.dispose();
    await expect(h.client.compose(job())).rejects.toMatchObject({ name: "AbortError" });
  });

  test("per-view eviction and budget changes retire worker mirrors and source-skip records", async () => {
    const h = harness();
    h.client.setLimit(80); // Exactly one 4x4 data + quality plane in the worker.
    const first = h.client.compose({ ...job("a", 1, "1:0"), uint8: false }); h.flush(); await first;
    const second = h.client.compose({ ...job("b", 2, "2:0"), uint8: false }); h.flush(); await second;
    expect(h.client.peek("1:0", "a")).toBeNull();
    expect(h.client.peek("2:0", "b").data[0]).toBe(2);
    expect(h.client.bytes).toBe(64);
    h.client.setLimit(0); expect(h.client.bytes).toBe(0);
    h.client.dispose();
  });

  test("budget eviction during an unchanged reply retries a snapshot without disabling the worker", async () => {
    const h = harness(), input = job();
    const first = h.client.compose(input); h.flush(); await first;
    const unchanged = h.client.compose(input);
    expect(h.sent[0].message.operations).toEqual([]);
    h.client.setLimit(0);
    expect(h.client.bytes).toBe(0);
    expect(h.flush().data).toBeNull();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].message.knownRevision).toBeNull();
    h.flush();
    expect((await unchanged).data.every((value) => value === 20)).toBe(true);
    expect(h.client.stats.snapshotRetries).toBe(1);
    expect(h.client.stats.mode).toBe("worker");
    expect(h.worker.terminated).toBe(false);
    expect(h.client.bytes).toBe(0);
    h.client.dispose();
  });
});
