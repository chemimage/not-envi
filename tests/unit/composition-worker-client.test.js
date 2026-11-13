import { describe, expect, test, vi } from "vitest";
import { createCompositionWorkerClient } from "../../src/render/composition-worker-client.js";

function fixture(options = {}) {
  const sent = [], fallback = vi.fn(() => ({ fallback: true }));
  const worker = { postMessage: (message, transfer) => sent.push({ message, transfer }), terminate: vi.fn() };
  const client = createCompositionWorkerClient({ fallback, workerFactory: () => worker, ...options });
  const rasters = [10, 20, 30].map((value, index) => ({ compositionId: index + 1, revision: 1,
    previousRevision: 0, dirtyRects: [{ x: 0, y: 0, w: 2, h: 2 }], w: 2, h: 2,
    dataF32: new Float32Array(4).fill(value) }));
  const respond = (index, extra = {}) => {
    const message = sent[index].message;
    const bitmap = { close: vi.fn() };
    worker.onmessage({ data: { id: message.id, bitmap, planes: message.planes.map((plane) => ({
      id: plane.id, w: plane.w, h: plane.h, revision: plane.revision })), ...extra } });
    return bitmap;
  };
  return { client, sent, fallback, worker, rasters, respond };
}

describe("composition worker client", () => {
  test("copies owned full/dirty data without detaching renderer arrays", async () => {
    const { client, rasters, sent, respond } = fixture();
    const first = client.compose(rasters, []);
    expect(sent[0].transfer).toHaveLength(3);
    expect(sent[0].message.planes[0].patches[0].values.buffer).not.toBe(rasters[0].dataF32.buffer);
    respond(0); await first;
    rasters[0].dataF32[1] = 99; rasters[0].revision = 2; rasters[0].previousRevision = 1;
    rasters[0].dirtyRects = [{ x: 1, y: 0, w: 1, h: 1 }];
    const second = client.compose(rasters, []);
    expect(sent[1].message.planes.map((plane) => plane.patches.length)).toEqual([1, 0, 0]);
    expect([...sent[1].message.planes[0].patches[0].values]).toEqual([99]);
    expect(client.stats.transferredBytes).toBe(52);
    expect(rasters[0].dataF32.byteLength).toBe(16);
    respond(1); await second; client.dispose();
  });

  test("latest keyed work supersedes active results, bounds queues and closes stale bitmaps", async () => {
    const { client, rasters, sent, respond } = fixture();
    const first = client.compose(rasters, []); const firstRejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = client.compose(rasters, []); const secondRejected = expect(second).rejects.toMatchObject({ name: "AbortError" });
    const third = client.compose(rasters, []);
    await firstRejected; await secondRejected;
    expect(sent).toHaveLength(1);
    expect(respond(0).close).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(2);
    respond(1); await third;
    expect(client.stats.cancelled).toBe(2); client.dispose();
  });

  test("queued revisions pack against the completed active revision and preserve immutable fallback data", async () => {
    const { client, rasters, sent, respond, fallback } = fixture();
    const initial = client.compose(rasters, []); respond(0); await initial;
    rasters[0].dataF32[0] = 40; rasters[0].revision = 2; rasters[0].previousRevision = 1;
    rasters[0].dirtyRects = [{ x: 0, y: 0, w: 1, h: 1 }];
    const active = client.compose(rasters, [], {}, { key: "panel1" });
    rasters[0].dataF32[0] = 50; rasters[0].revision = 3; rasters[0].previousRevision = 2;
    const queued = client.compose(rasters, [], {}, { key: "panel2" });
    rasters[0].dataF32[0] = 70;
    respond(1); await active;
    expect(sent[2].message.planes.map(plane => plane.full)).toEqual([false, false, false]);
    expect(sent[2].message.planes.map(plane => plane.patches.length)).toEqual([1, 0, 0]);
    expect(sent[2].message.planes[0].patches[0].values[0]).toBe(50);
    respond(2, { error: "controlled failure", bitmap: undefined }); await queued;
    expect(fallback.mock.calls[0][0][0].dataF32[0]).toBe(50);
    client.dispose();
  });

  test("abort and dispose retire queued/active requests and worker resources", async () => {
    const { client, rasters, worker } = fixture();
    const controller = new AbortController();
    const active = client.compose(rasters, [], {}, { signal: controller.signal });
    const rejected = expect(active).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await rejected;
    const queued = client.compose(rasters, [], {}, { key: "second" });
    const queuedRejected = expect(queued).rejects.toMatchObject({ name: "AbortError" });
    client.dispose(); await queuedRejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(client.stats.queuedBytes).toBe(0);
    await expect(client.compose(rasters, [])).rejects.toMatchObject({ name: "AbortError" });
  });

  test("worker failures fall back from owned snapshots and timeouts disable broken workers", async () => {
    const { client, rasters, fallback, worker } = fixture({ timeoutMs: 5 });
    const pending = client.compose(rasters, []);
    rasters[0].dataF32[0] = 250;
    await expect(pending).resolves.toEqual({ fallback: true });
    expect(fallback.mock.calls[0][0][0].dataF32[0]).toBe(10);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(client.usingWorker()).toBe(false); client.dispose();
  });

  test("pending views and copied transfer bytes stay bounded", async () => {
    const { client, rasters, respond } = fixture({ maxBytes: 96 });
    const active = client.compose(rasters, [], {}, { key: "active" });
    const old = client.compose(rasters, [], {}, { key: "old" });
    const oldRejected = expect(old).rejects.toMatchObject({ name: "AbortError" });
    const second = client.compose(rasters, [], {}, { key: "second" });
    const newest = client.compose(rasters, [], {}, { key: "newest" });
    await oldRejected;
    expect(client.stats.queuedBytes).toBe(0);
    expect(client.stats.queuedSnapshotBytes).toBe(96);
    expect(client.stats.peakQueuedBytes).toBeLessThanOrEqual(96);
    respond(0); await active; respond(1); await second; respond(2); await newest;
    expect(client.stats.queuedBytes).toBe(0); client.dispose();
  });

  test("oversized views use the local fallback without allocating worker copies", async () => {
    const { client, rasters, sent, fallback } = fixture({ maxBytes: 32 });
    await client.compose(rasters, []);
    expect(sent).toHaveLength(0);
    expect(fallback).toHaveBeenCalledOnce();
    expect(client.stats.transferredBytes).toBe(0); client.dispose();
  });

  test("tone bursts allocate no queued transport and pack no unchanged pixels at dispatch", async () => {
    const { client, rasters, sent, respond } = fixture();
    const initial = client.compose(rasters, []); respond(0); await initial;
    const before = client.stats.packedBytes;
    const jobs = Array.from({ length: 12 }, () => client.compose(rasters, []).then(() => "ok", error => error.name));
    expect(client.stats.packedBytes).toBe(before);
    expect(client.stats.queuedBytes).toBe(0);
    respond(1); respond(2);
    expect(await Promise.all(jobs)).toEqual([...Array(11).fill("AbortError"), "ok"]);
    expect(client.stats.packedBytes).toBe(before);
    expect(sent.at(-1).transfer).toHaveLength(0);
    client.dispose();
  });

  test("eviction acknowledgements force a full queued snapshot instead of stale patches", async () => {
    const { client, rasters, sent, respond } = fixture();
    const initial = client.compose(rasters, []); respond(0); await initial;
    const active = client.compose(rasters, [], {}, { key: "a" });
    const pending = client.compose(rasters, [], {}, { key: "b" });
    respond(1, { planes: [] }); await active;
    expect(sent[2].message.planes.every(plane => plane.full)).toBe(true);
    respond(2); await pending; client.dispose();
  });

  test("queued dirty rectangles are frozen before mutable renderer metadata changes", async () => {
    const { client, rasters, sent, respond } = fixture();
    const initial = client.compose(rasters, []); respond(0); await initial;
    const active = client.compose(rasters, [], {}, { key: "a" });
    Object.assign(rasters[0], { revision: 2, previousRevision: 1, dirtyRects: [{ x: 1, y: 0, w: 1, h: 1 }] });
    rasters[0].dataF32[1] = 99;
    const pending = client.compose(rasters, [], {}, { key: "b" });
    rasters[0].dirtyRects[0].x = 0;
    respond(1); await active;
    expect(sent[2].message.planes[0].patches[0].x).toBe(1);
    expect([...sent[2].message.planes[0].patches[0].values]).toEqual([99]);
    respond(2); await pending; client.dispose();
  });
});
