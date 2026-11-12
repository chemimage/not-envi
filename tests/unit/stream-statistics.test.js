import { describe, expect, test, vi } from "vitest";
import { ANALYSIS_BATCH_VALUES, createAnalysisBudget, createAnalysisPlan } from "../../src/core/analysis-batches.js";
import { streamStatistics } from "../../src/core/stream-statistics.js";
import { computeHistogram } from "../../src/render/display-math.js";
import { createFloat32ScratchPool } from "../../src/core/float-scratch.js";

function region(x0, y0, outW, outH, tool = "rect") {
  return { bounds: { x0, y0 }, outW, outH, selection: { tool, points: [] } };
}

describe("streaming statistics", () => {
  test.each([1, 4])("matches an independent overlapping-region reference for type %i", async (dataType) => {
    const regions = [region(0, 0, 180, 160), region(40, 20, 180, 160, "shape")];
    const contains = (_selection, x, y) => x + y < 310;
    const step = 2;
    const plan = createAnalysisPlan(regions, step, contains);
    const valueAt = (x, y) => (x % 17 === 0 ? NaN : dataType === 1 ? (x + y) % 256 : (x - y) / 3);
    const reference = new Map();
    for (const item of regions) for (let y = 0; y < item.outH; y++) for (let x = 0; x < item.outW; x++) {
      const ix = item.bounds.x0 + x * step, iy = item.bounds.y0 + y * step;
      if (item.selection.tool === "shape" && !contains(null, ix + step / 2, iy + step / 2)) continue;
      reference.set(`${ix},${iy}`, Math.fround(valueAt(ix, iy)));
    }
    let maxBatch = 0, reads = 0;
    const progress = [];
    const budget = createAnalysisBudget(512 * 1024);
    const result = await streamStatistics({ ds: { meta: { dataType }, ds: {} }, band: 0, plan, histogram: true,
      reserve: (...args) => budget.reserve(...args), onProgress: (p) => progress.push(p),
      readWindow: async (batch) => {
        reads++;
        maxBatch = Math.max(maxBatch, batch.outW * batch.outH);
        const data = new Float32Array(batch.outW * batch.outH);
        for (let y = 0; y < batch.outH; y++) for (let x = 0; x < batch.outW; x++) {
          data[y * batch.outW + x] = valueAt(batch.x0 + x * step, batch.y0 + y * step);
        }
        return { data, release() {} };
      } });
    const expected = computeHistogram(Float32Array.from(reference.values()));
    expect(result.bins).toEqual(expected.bins);
    for (const key of ["min", "max", "count", "mean", "stdDev", "rms", "p1", "p99"]) expect(result[key]).toBeCloseTo(expected[key], 7);
    expect(result.sampleCount).toBe(reference.size);
    expect(result.complete).toBe(true);
    expect(maxBatch).toBeLessThanOrEqual(ANALYSIS_BATCH_VALUES);
    expect(progress.at(-1).completed).toBe(progress.at(-1).total);
    expect(new Set(progress.map((p) => p.phase))).toEqual(new Set(dataType === 1 ? ["statistics"] : ["range", "histogram"]));
    expect(reads).toBeGreaterThan(1);
    expect(budget.stats()).toMatchObject({ activeBytes: 0, peakBytes: 512 * 1024, queued: 0 });
  });

  test("holds reservations through a canceled provider's settlement and publishes no completed batch", async () => {
    const budget = createAnalysisBudget(512 * 1024);
    let cancel = false, finish;
    const progress = vi.fn();
    const promise = streamStatistics({ ds: { meta: {}, ds: {} }, band: 0,
      plan: createAnalysisPlan([region(0, 0, 10, 10)], 1), cancelled: () => cancel,
      reserve: (...args) => budget.reserve(...args), onProgress: progress,
      readWindow: () => new Promise((resolve) => { finish = () => resolve({ data: new Float32Array(100), release() {} }); }) });
    const outcome = promise.catch((error) => error.name);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    cancel = true;
    expect(budget.stats().activeBytes).toBe(512 * 1024);
    finish();
    expect(await outcome).toBe("AbortError");
    expect(budget.stats().activeBytes).toBe(0);
    expect(progress.mock.calls.every(([p]) => p.completed === 0)).toBe(true);
  });

  test("waits for admission before building a mask and cancels without starting I/O", async () => {
    const budget = createAnalysisBudget(512 * 1024);
    const release = await budget.reserve(512 * 1024);
    let cancel = false;
    const contains = vi.fn(() => true), readWindow = vi.fn();
    const result = streamStatistics({ ds: { meta: {}, ds: {} }, band: 0,
      plan: createAnalysisPlan([region(0, 0, 100, 100, "shape")], 1, contains),
      cancelled: () => cancel, readWindow, reserve: (...args) => budget.reserve(...args) }).catch((error) => error.name);
    await Promise.resolve();
    expect(contains).not.toHaveBeenCalled();
    cancel = true;
    release();
    expect(await result).toBe("AbortError");
    expect(readWindow).not.toHaveBeenCalled();
    expect(budget.stats()).toMatchObject({ activeBytes: 0, queued: 0 });
  });

  test("repeated varied-size batches cannot grow the retained scratch pool beyond its byte cap", () => {
    const pool = createFloat32ScratchPool({ maxRetainedBytes: 131072, maxRetainedElements: 16384 });
    for (let round = 0; round < 3; round++) for (let size = 100; size < 16384; size += 101) {
      pool.release(pool.acquire(size));
      expect(pool.stats().retainedBytes).toBeLessThanOrEqual(131072);
    }
    pool.clear();
    expect(pool.stats().retainedBytes).toBe(0);
  });

  test("moments use the compact source-side operation without raster transport or histogram passes", async () => {
    const reduceStatisticsWindow = vi.fn(async (_meta, _band, _x, _y, w, h, _step, options) => {
      expect(options.bins).toBe(0);
      return { min: 3, max: 3, count: w * h, sum: w * h * 3, sumSq: w * h * 9 };
    });
    const readWindow = vi.fn();
    const plan = createAnalysisPlan([region(0, 0, 200, 200)], 1);
    const result = await streamStatistics({ ds: { meta: { dataType: 4 }, ds: { reduceStatisticsWindow } },
      band: 0, plan, readWindow });
    expect(result.count).toBe(40000);
    expect(result.sum).toBe(120000);
    expect(reduceStatisticsWindow).toHaveBeenCalledTimes(plan.batchCount);
    expect(readWindow).not.toHaveBeenCalled();
  });

  test("progress remains pending while calculation is running and errors release the lease", async () => {
    const budget = createAnalysisBudget(512 * 1024);
    let finish;
    const progress = vi.fn();
    const source = { reduceStatisticsWindow: () => new Promise((_resolve, reject) => { finish = () => reject(new Error("calculation failed")); }) };
    const outcome = streamStatistics({ ds: { meta: { dataType: 4 }, ds: source }, band: 0,
      plan: createAnalysisPlan([region(0, 0, 20, 20)], 1), onProgress: progress,
      reserve: (...args) => budget.reserve(...args) }).catch((error) => error.message);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(progress.mock.calls.at(-1)[0].completed).toBe(0);
    expect(budget.stats().activeBytes).toBe(512 * 1024);
    finish();
    expect(await outcome).toBe("calculation failed");
    expect(progress.mock.calls.every(([p]) => p.completed === 0)).toBe(true);
    expect(budget.stats().activeBytes).toBe(0);
  });

  test("concurrent datasets share the transient budget and rejected queued jobs never allocate masks", async () => {
    const budget = createAnalysisBudget(512 * 1024);
    const releases = [];
    const readWindow = vi.fn(() => new Promise((resolve) => releases.push(() => resolve({
      data: new Float32Array(100).fill(1), release() {}
    }))));
    const contains = vi.fn(() => true);
    const plan = createAnalysisPlan([region(0, 0, 10, 10, "shape")], 1, contains);
    const cancelled = [false, false, false];
    const jobs = cancelled.map((_value, i) => streamStatistics({ ds: { meta: {}, ds: {} }, band: 0,
      plan, readWindow, cancelled: () => cancelled[i], reserve: (...args) => budget.reserve(...args) })
      .catch((error) => error.name));
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(budget.stats()).toMatchObject({ activeBytes: 512 * 1024, queued: 2 });
    expect(contains).toHaveBeenCalledTimes(100);
    cancelled[1] = true;
    releases.shift()();
    await vi.waitFor(() => expect(readWindow).toHaveBeenCalledTimes(2));
    releases.shift()();
    const results = await Promise.all(jobs);
    expect(results[0].count).toBe(100);
    expect(results[1]).toBe("AbortError");
    expect(results[2].count).toBe(100);
    expect(budget.stats()).toMatchObject({ activeBytes: 0, peakBytes: 512 * 1024, queued: 0 });
  });
});
