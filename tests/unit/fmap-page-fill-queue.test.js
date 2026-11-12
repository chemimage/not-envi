// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { FmapPageFillQueue } from "../../src/io/fmap/page-fill-queue.js";

const PAGE_SIZE = 4096;
let wasmBytes;

beforeAll(() => {
  wasmBytes = readFileSync(resolve("wasm/fmap/pkg/fmap_core.wasm"));
});

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function flushMicrotasks(turns = 6) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

async function harness({ slots = 4, concurrency = 2, maxQueuedRequests = 16, maxQueuedBytes = PAGE_SIZE * 16, fileSize = PAGE_SIZE * 6 } = {}) {
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  const core = instance.exports;
  expect(Number(core.fmap_init(PAGE_SIZE, slots))).toBe(0);
  const fileBytes = Uint8Array.from({ length: fileSize }, (_value, index) => (index * 17) & 0xff);
  const reads = [];
  const tasks = [];
  const readFile = vi.fn((offset, length) => {
    const pending = deferred();
    reads.push({ offset, length, ...pending });
    return pending.promise;
  });
  const queue = new FmapPageFillQueue({
    core,
    fileSize: fileBytes.byteLength,
    pageSize: PAGE_SIZE,
    generation: 1,
    concurrency,
    maxQueuedRequests,
    maxQueuedBytes,
    readFile,
    postTask: (callback) => tasks.push(callback)
  });
  const runTasks = async (limit = 100) => {
    let turns = 0;
    while (tasks.length) {
      if (++turns > limit) throw new Error("fmap fill queue did not quiesce");
      tasks.shift()();
      await flushMicrotasks();
    }
  };
  const finishRead = async (read = reads.find((entry) => !entry.finished)) => {
    if (!read) throw new Error("No pending fmap read");
    read.finished = true;
    read.resolve(fileBytes.slice(read.offset, read.offset + read.length));
    await flushMicrotasks();
    await runTasks();
  };
  const failRead = async (error, read = reads.find((entry) => !entry.finished)) => {
    if (!read) throw new Error("No pending fmap read");
    read.finished = true;
    read.reject(error);
    await flushMicrotasks();
    await runTasks();
  };
  const leaseBytes = (lease) => Array.from(new Uint8Array(
    core.memory.buffer,
    Number(core.fmap_slot_ptr(lease.slot)) + lease.offset,
    lease.length
  ));
  return { core, fileBytes, reads, tasks, readFile, queue, runTasks, finishRead, failRead, leaseBytes };
}

function settled(promise) {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error })
  );
}

describe("FmapPageFillQueue", () => {
  test.each([
    ["a truncated ArrayBuffer", () => new ArrayBuffer(15), /Truncated/],
    ["a non-byte result", () => ({ length: 16 }), /must return bytes/]
  ])("rejects shared consumers on %s and permits a later retry", async (_name, result, message) => {
    const h = await harness();
    const first = h.queue.request({ pageIndex: 0, offset: 0, length: 16 });
    const second = h.queue.request({ pageIndex: 0, offset: 0, length: 16 });
    const outcomes = [settled(first.promise), settled(second.promise)];
    await h.runTasks();
    h.reads[0].finished = true; h.reads[0].resolve(result());
    await flushMicrotasks(); await h.runTasks();
    for (const outcome of outcomes) expect((await outcome).error.message).toMatch(message);
    expect(h.queue.getStats()).toMatchObject({ fillActiveReads: 0, fillQueueRequests: 0, fillLiveDemands: 0, pageFillFailures: 1 });
    expect(h.core.fmap_pinned_bytes()).toBe(0);
    const retry = h.queue.request({ pageIndex: 0, offset: 0, length: 16 });
    await h.runTasks(); await h.finishRead();
    const lease = await retry.promise;
    expect(h.leaseBytes(lease)).toEqual(Array.from(h.fileBytes.subarray(0, 16)));
    lease.release(); h.queue.close();
  });

  test("reacquires WASM memory after allocation growth while a provider read is pending", async () => {
    const h = await harness();
    const request = h.queue.request({ pageIndex: 0, offset: 0, length: 16 });
    await h.runTasks();
    const buffer = h.core.memory.buffer;
    for (let id = 1n; id <= 1000n; id++) expect(h.core.fmap_map_region(id * 8192n, 4096n, 0n, id)).toBe(0);
    expect(h.core.memory.buffer).not.toBe(buffer);
    await h.finishRead();
    const lease = await request.promise;
    expect(h.leaseBytes(lease)).toEqual(Array.from(h.fileBytes.subarray(0, 16)));
    lease.release(); h.queue.close();
  });

  test("dense fills stop at EOF and retain exact caller bounds", async () => {
    const h = await harness({ fileSize: PAGE_SIZE + 13 });
    const request = h.queue.request({ pageIndex: 1, offset: 10, length: 3, fillBytes: PAGE_SIZE });
    await h.runTasks();
    expect(h.reads[0]).toMatchObject({ offset: PAGE_SIZE, length: 13 });
    await h.finishRead();
    const lease = await request.promise;
    expect(h.leaseBytes(lease)).toEqual(Array.from(h.fileBytes.subarray(PAGE_SIZE + 10)));
    lease.release(); h.queue.close();
  });

  test("dense hints fetch adjacent channel bytes once while plain sparse requests stay exact", async () => {
    const h = await harness();
    const row = h.queue.request({ pageIndex: 0, offset: 100, length: 382, fillBytes: 4096 });
    await h.runTasks();
    expect(h.reads[0]).toMatchObject({ offset: 0, length: 4096 });
    await h.finishRead();
    const lease = await row.promise;
    expect(h.leaseBytes(lease)).toEqual(Array.from(h.fileBytes.subarray(100, 482)));
    lease.release();
    const tail = h.queue.request({ pageIndex: 0, offset: 482, length: 2 });
    expect(tail.lease).toBeTruthy(); tail.lease.release();
    const sparse = h.queue.request({ pageIndex: 1, offset: 17, length: 1 });
    await h.runTasks();
    expect(h.reads[1]).toMatchObject({ offset: PAGE_SIZE + 17, length: 1 });
    await h.finishRead(); (await sparse.promise).release();
    expect(h.core.fmap_pinned_bytes()).toBe(0);
    expect(() => h.queue.request({ pageIndex: 0, offset: 0, length: 1, fillBytes: PAGE_SIZE * 2 })).toThrow(/grain/);
    h.queue.close();
  });

  test("deduplicates overlapping waiters and reads only a missing tail", async () => {
    const h = await harness({ concurrency: 2 });
    const first = h.queue.request({ pageIndex: 0, offset: 0, length: 64, priority: 1, generation: 1, requestId: 1 });
    await h.runTasks();
    expect(h.reads.map(({ offset, length }) => ({ offset, length }))).toEqual([{ offset: 0, length: 64 }]);

    const overlap = h.queue.request({ pageIndex: 0, offset: 32, length: 64, priority: 0, generation: 1, requestId: 2 });
    expect(h.reads).toHaveLength(1);
    await h.finishRead(h.reads[0]);
    expect(h.reads.map(({ offset, length }) => ({ offset, length }))).toEqual([
      { offset: 0, length: 64 },
      { offset: 64, length: 32 }
    ]);
    await h.finishRead(h.reads[1]);

    const [firstLease, overlapLease] = await Promise.all([first.promise, overlap.promise]);
    expect(h.leaseBytes(firstLease)).toEqual(Array.from(h.fileBytes.subarray(0, 64)));
    expect(h.leaseBytes(overlapLease)).toEqual(Array.from(h.fileBytes.subarray(32, 96)));
    firstLease.release();
    overlapLease.release();
    const stats = h.queue.getStats();
    expect(stats.pageFillReads).toBe(2);
    expect(stats.pageFillDeduplications).toBeGreaterThanOrEqual(1);
    expect(stats.fillActiveReads).toBe(0);
    expect(Number(h.core.fmap_pinned_bytes())).toBe(0);
    h.queue.close();
  });

  test("promotes a shared fill to its highest-priority consumer", async () => {
    const h = await harness({ concurrency: 1 });
    const pageOne = h.queue.request({ pageIndex: 1, offset: 0, length: 16, priority: 1, generation: 1, requestId: 1 });
    const pageZeroBackground = h.queue.request({ pageIndex: 0, offset: 0, length: 16, priority: 1, generation: 1, requestId: 2 });
    const pageZeroForeground = h.queue.request({ pageIndex: 0, offset: 8, length: 8, priority: 0, generation: 1, requestId: 3 });
    await h.runTasks();

    expect(h.reads[0]).toMatchObject({ offset: 0, length: 16 });
    await h.finishRead(h.reads[0]);
    const [backgroundLease, foregroundLease] = await Promise.all([pageZeroBackground.promise, pageZeroForeground.promise]);
    backgroundLease.release();
    foregroundLease.release();
    expect(h.reads[1]).toMatchObject({ offset: PAGE_SIZE, length: 16 });
    await h.finishRead(h.reads[1]);
    (await pageOne.promise).release();
    h.queue.close();
  });

  test("cancels one waiter without discarding a shared fill", async () => {
    const h = await harness();
    const cancelled = h.queue.request({ pageIndex: 0, offset: 0, length: 32, generation: 1, requestId: 1 });
    const survivor = h.queue.request({ pageIndex: 0, offset: 0, length: 32, generation: 1, requestId: 2 });
    const cancelledOutcome = settled(cancelled.promise);
    cancelled.cancel();
    await h.runTasks();
    expect(h.reads).toHaveLength(1);
    await h.finishRead();

    expect((await cancelledOutcome).error).toMatchObject({ name: "AbortError" });
    const lease = await survivor.promise;
    expect(h.leaseBytes(lease)).toEqual(Array.from(h.fileBytes.subarray(0, 32)));
    lease.release();
    expect(h.queue.getStats().pageFillCancelledWaiters).toBe(1);
    h.queue.close();
  });

  test("drops a queued fill after its last waiter cancels", async () => {
    const h = await harness({ concurrency: 1 });
    const active = h.queue.request({ pageIndex: 0, offset: 0, length: 32, generation: 1, requestId: 1 });
    await h.runTasks();
    const queued = h.queue.request({ pageIndex: 1, offset: 0, length: 32, generation: 1, requestId: 2 });
    const queuedOutcome = settled(queued.promise);
    queued.cancel();
    await h.runTasks();
    await h.finishRead();
    (await active.promise).release();

    expect((await queuedOutcome).error).toMatchObject({ name: "AbortError" });
    expect(h.reads).toHaveLength(1);
    expect(h.queue.getStats()).toMatchObject({ fillQueueRequests: 0, fillQueueBytes: 0, fillActiveReads: 0 });
    h.queue.close();
  });

  test("bounds active reads and keeps completed leases pinned before admitting an all-pinned fill", async () => {
    const h = await harness({ slots: 2, concurrency: 2 });
    const first = h.queue.request({ pageIndex: 0, offset: 0, length: 32, generation: 1, requestId: 1 });
    const second = h.queue.request({ pageIndex: 1, offset: 0, length: 32, generation: 1, requestId: 2 });
    const third = h.queue.request({ pageIndex: 2, offset: 0, length: 32, generation: 1, requestId: 3 });
    await h.runTasks();
    expect(h.reads).toHaveLength(2);
    expect(h.queue.getStats().fillActiveReads).toBe(2);
    expect(Number(h.core.fmap_pinned_bytes())).toBe(PAGE_SIZE * 2);

    await h.finishRead(h.reads[0]);
    const firstLease = await first.promise;
    expect(h.reads).toHaveLength(2);
    expect(Number(h.core.fmap_pinned_bytes())).toBe(PAGE_SIZE * 2);
    firstLease.release();
    await h.runTasks();
    expect(h.reads).toHaveLength(3);

    await h.finishRead(h.reads[1]);
    await h.finishRead(h.reads[2]);
    (await second.promise).release();
    (await third.promise).release();
    const stats = h.queue.getStats();
    expect(stats.peakFillActiveReads).toBe(2);
    expect(stats.peakFillActiveBytes).toBeLessThanOrEqual(64);
    expect(Number(h.core.fmap_pinned_bytes())).toBe(0);
    h.queue.close();
  });

  test("clear rejects old waiters, charges active I/O through completion, and prevents stale commit", async () => {
    const h = await harness({ concurrency: 1 });
    const stale = h.queue.request({ pageIndex: 0, offset: 0, length: 16, generation: 1, requestId: 1 });
    const staleOutcome = settled(stale.promise);
    await h.runTasks();
    h.queue.clear(2);
    expect((await staleOutcome).error).toMatchObject({ name: "AbortError" });
    expect(h.queue.getStats().fillActiveReads).toBe(1);
    await h.finishRead();
    expect(h.queue.getStats().fillActiveReads).toBe(0);

    const fresh = h.queue.request({ pageIndex: 0, offset: 0, length: 16, generation: 2, requestId: 2 });
    await h.runTasks();
    expect(h.reads).toHaveLength(2);
    h.reads[1].finished = true;
    h.reads[1].resolve(Uint8Array.from({ length: 16 }, () => 0x7b));
    await flushMicrotasks();
    await h.runTasks();
    const freshLease = await fresh.promise;
    expect(h.leaseBytes(freshLease)).toEqual(Array.from({ length: 16 }, () => 0x7b));
    freshLease.release();
    h.queue.close();
  });

  test("cleans up a failed fill and permits an exact retry", async () => {
    const h = await harness({ concurrency: 1 });
    const failed = h.queue.request({ pageIndex: 0, offset: 12, length: 20, generation: 1, requestId: 1 });
    const failedOutcome = settled(failed.promise);
    await h.runTasks();
    await h.failRead(new Error("disk read failed"));
    expect((await failedOutcome).error).toMatchObject({ message: "disk read failed" });
    expect(h.queue.getStats()).toMatchObject({ fillActiveReads: 0, fillActiveBytes: 0, pageFillFailures: 1 });
    expect(Number(h.core.fmap_pinned_bytes())).toBe(0);

    const retry = h.queue.request({ pageIndex: 0, offset: 12, length: 20, generation: 1, requestId: 2 });
    await h.runTasks();
    expect(h.reads).toHaveLength(2);
    expect(h.reads[1]).toMatchObject({ offset: 12, length: 20 });
    await h.finishRead(h.reads[1]);
    const lease = await retry.promise;
    expect(h.leaseBytes(lease)).toEqual(Array.from(h.fileBytes.subarray(12, 32)));
    lease.release();
    h.queue.close();
  });

  test("returns an immediate pinned lease for a warm valid range", async () => {
    const h = await harness();
    const cold = h.queue.request({ pageIndex: 0, offset: 100, length: 24, generation: 1, requestId: 1 });
    await h.runTasks();
    await h.finishRead();
    (await cold.promise).release();
    const readsAfterCold = h.reads.length;

    const warm = h.queue.request({ pageIndex: 0, offset: 104, length: 8, generation: 1, requestId: 2 });
    expect(warm.lease).toBeTruthy();
    expect(await warm.promise).toBe(warm.lease);
    expect(h.reads).toHaveLength(readsAfterCold);
    expect(h.leaseBytes(warm.lease)).toEqual(Array.from(h.fileBytes.subarray(104, 112)));
    warm.lease.release();
    expect(h.queue.getStats().pageFillCacheHits).toBeGreaterThanOrEqual(1);
    h.queue.close();
  });

  test("falls back to one full-page read when exact validity fragments overflow", async () => {
    const h = await harness({ slots: 1, concurrency: 1 });
    const slot = Number(h.core.fmap_acquire_page(0n));
    expect(slot).toBeGreaterThanOrEqual(0);
    for (let index = 0; index < 64; index += 1) {
      expect(Number(h.core.fmap_commit_range(slot, index * 2, 1))).toBe(0);
    }
    expect(Number(h.core.fmap_slot_range_count(slot))).toBe(64);
    expect(Number(h.core.fmap_release_page(slot))).toBe(0);

    const request = h.queue.request({ pageIndex: 0, offset: 128, length: 1, generation: 1, requestId: 1 });
    await h.runTasks();
    expect(h.reads[0]).toMatchObject({ offset: 128, length: 1 });
    await h.finishRead(h.reads[0]);
    expect(h.reads[1]).toMatchObject({ offset: 0, length: PAGE_SIZE });
    await h.finishRead(h.reads[1]);

    const lease = await request.promise;
    expect(h.leaseBytes(lease)).toEqual([h.fileBytes[128]]);
    lease.release();
    expect(h.queue.getStats().pageFillFragmentFallbacks).toBe(1);
    expect(Number(h.core.fmap_slot_range_count(lease.slot))).toBe(1);
    h.queue.close();
  });

  test("parks excess faults and completes them within admitted count and byte limits", async () => {
    const h = await harness({ slots: 1, concurrency: 2, maxQueuedRequests: 1, maxQueuedBytes: 12 });
    const requests = Array.from({ length: 6 }, (_v, pageIndex) => h.queue.request({ pageIndex, offset: 0, length: 8 }));
    expect(h.queue.getStats()).toMatchObject({ fillQueueRequests: 1, fillQueueBytes: 8, fillParkedRequests: 5 });
    expect(h.readFile).not.toHaveBeenCalled();
    expect(Number(h.core.fmap_pinned_bytes())).toBe(0);
    await h.runTasks();
    for (let index = 0; index < requests.length; index += 1) {
      expect(h.reads).toHaveLength(index + 1);
      await h.finishRead(h.reads[index]);
      const lease = await requests[index].promise;
      expect(h.leaseBytes(lease)).toEqual(Array.from(h.fileBytes.subarray(index * PAGE_SIZE, index * PAGE_SIZE + 8)));
      lease.release();
      await h.runTasks();
    }
    expect(h.queue.getStats()).toMatchObject({ fillQueueRequests: 0, fillQueueBytes: 0, fillParkedRequests: 0,
      peakFillQueueRequests: 1, peakFillQueueBytes: 8, peakFillParkedRequests: 5 });
    expect(Number(h.core.fmap_pinned_bytes())).toBe(0);
    h.queue.close();
  });

  test("cancels parked faults before any read or resident reservation", async () => {
    const h = await harness({ maxQueuedRequests: 1 });
    const active = h.queue.request({ pageIndex: 0, offset: 0, length: 8 });
    const parked = h.queue.request({ pageIndex: 1, offset: 0, length: 8 });
    const outcome = settled(parked.promise);
    parked.cancel();
    expect((await outcome).error).toMatchObject({ name: "AbortError" });
    expect(h.queue.getStats().fillParkedRequests).toBe(0);
    await h.runTasks();
    await h.finishRead();
    (await active.promise).release();
    await h.runTasks();
    expect(h.reads).toHaveLength(1);
    h.queue.close();
  });

  test("byte capacity parks a demand even when descriptor count has capacity", async () => {
    const h = await harness({ maxQueuedRequests: 4, maxQueuedBytes: 12, concurrency: 1 });
    const first = h.queue.request({ pageIndex: 0, offset: 0, length: 8 });
    const second = h.queue.request({ pageIndex: 0, offset: 8, length: 5 });
    expect(h.queue.getStats()).toMatchObject({ fillQueueRequests: 1, fillQueueBytes: 8, fillParkedRequests: 1 });
    await h.runTasks();
    expect(h.reads).toHaveLength(1);
    await h.finishRead();
    (await first.promise).release();
    await h.runTasks();
    expect(h.reads[1]).toMatchObject({ offset: 8, length: 5 });
    await h.finishRead();
    (await second.promise).release();
    expect(h.queue.getStats().peakFillQueueBytes).toBeLessThanOrEqual(12);
    h.queue.close();
  });

  test("foreground promotion preserves a same-page admitted demand for one merged read", async () => {
    const h = await harness({ maxQueuedRequests: 2, concurrency: 1 });
    const otherPage = h.queue.request({ pageIndex: 1, offset: 0, length: 16, priority: 1 });
    const background = h.queue.request({ pageIndex: 0, offset: 0, length: 16, priority: 1 });
    const foreground = h.queue.request({ pageIndex: 0, offset: 8, length: 8, priority: 0 });
    await h.runTasks();
    expect(h.reads[0]).toMatchObject({ offset: 0, length: 16 });
    await h.finishRead();
    for (const lease of await Promise.all([background.promise, foreground.promise])) lease.release();
    await h.runTasks();
    expect(h.reads[1]).toMatchObject({ offset: PAGE_SIZE, length: 16 });
    await h.finishRead();
    (await otherPage.promise).release();
    expect(h.reads).toHaveLength(2);
    h.queue.close();
  });

  test("clear and close reject parked faults and never revive them", async () => {
    for (const operation of ["clear", "close"]) {
      const h = await harness({ maxQueuedRequests: 1 });
      const active = h.queue.request({ pageIndex: 0, offset: 0, length: 8 });
      const parked = h.queue.request({ pageIndex: 1, offset: 0, length: 8 });
      const outcomes = [settled(active.promise), settled(parked.promise)];
      await h.runTasks();
      if (operation === "clear") h.queue.clear(2);
      else h.queue.close();
      for (const outcome of outcomes) expect((await outcome).error).toMatchObject({ name: "AbortError" });
      expect(h.queue.getStats()).toMatchObject({ fillQueueRequests: 0, fillParkedRequests: 0, fillActiveReads: 1 });
      await h.finishRead();
      expect(h.reads).toHaveLength(1);
      expect(h.queue.getStats().fillActiveReads).toBe(0);
      h.queue.close();
    }
  });

  test("foreground parked work displaces unstarted background work without cancelling it", async () => {
    const h = await harness({ concurrency: 1, maxQueuedRequests: 1, maxQueuedBytes: 16 });
    const background = h.queue.request({ pageIndex: 1, offset: 0, length: 16, priority: 1 });
    const foreground = h.queue.request({ pageIndex: 0, offset: 0, length: 16, priority: 0 });
    await h.runTasks();
    expect(h.reads[0]).toMatchObject({ offset: 0, length: 16 });
    await h.finishRead();
    (await foreground.promise).release();
    await h.runTasks();
    expect(h.reads[1]).toMatchObject({ offset: PAGE_SIZE, length: 16 });
    await h.finishRead();
    (await background.promise).release();
    expect(h.queue.getStats().pageFillCancelledWaiters).toBe(0);
    h.queue.close();
  });

  test("a parked overlapping demand reuses the completed fill without another read", async () => {
    const h = await harness({ concurrency: 1, maxQueuedRequests: 1 });
    const background = h.queue.request({ pageIndex: 0, offset: 0, length: 32, priority: 1 });
    await h.runTasks();
    const foreground = h.queue.request({ pageIndex: 0, offset: 8, length: 16, priority: 0 });
    expect(h.queue.getStats().fillParkedRequests).toBe(1);
    await h.finishRead();
    const leases = await Promise.all([background.promise, foreground.promise]);
    expect(h.reads).toHaveLength(1);
    expect(h.queue.getStats().pageFillDeduplications).toBe(1);
    for (const lease of leases) lease.release();
    h.queue.close();
  });

  test("rejects a demand that cannot ever fit its admission byte limit", async () => {
    const h = await harness({ maxQueuedBytes: 12 });
    expect(() => h.queue.request({ pageIndex: 0, offset: 0, length: 13 })).toThrow(/admission byte limit/i);
    expect(h.readFile).not.toHaveBeenCalled();
    expect(h.queue.getStats()).toMatchObject({ fillQueueRequests: 0, fillParkedRequests: 0 });
    h.queue.close();
  });
});
