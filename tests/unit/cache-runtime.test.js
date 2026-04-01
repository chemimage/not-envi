import { afterEach, describe, expect, test, vi } from "vitest";
import { createCacheRuntime } from "../../src/app/cache-runtime.js";

const originalDeviceMemory = navigator.deviceMemory;
const originalPerformanceMemory = performance.memory;

afterEach(() => {
  Object.defineProperty(navigator, "deviceMemory", {
    configurable: true,
    value: originalDeviceMemory
  });
  Object.defineProperty(performance, "memory", {
    configurable: true,
    value: originalPerformanceMemory
  });
});

describe("cache runtime", () => {
  test("setIOParallel toggles state and updates dataset concurrency", () => {
    const dsA = { ds: { setConcurrency: vi.fn() }, pyramid: {} };
    const dsB = { ds: { concurrency: 0 }, pyramid: {} };
    const state = { datasets: [dsA, dsB], ioParallel: true };
    const updatePerf = vi.fn();
    const updatePyramidInflight = vi.fn();

    const cache = createCacheRuntime({
      state,
      clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
      updatePerf,
      updatePyramidInflight,
      getIOConcurrencyMax: () => 4
    });

    const ioOff = cache.setIOParallel(false);
    expect(ioOff).toBe(1);
    expect(state.ioParallel).toBe(false);
    expect(dsA.ds.setConcurrency).toHaveBeenCalledWith(1);
    expect(dsB.ds.concurrency).toBe(1);
    expect(updatePyramidInflight).toHaveBeenCalledTimes(2);

    const ioOn = cache.setIOParallel(true);
    expect(ioOn).toBe(4);
    expect(state.ioParallel).toBe(true);
  });

  test("recomputeCacheBudgets applies per-dataset chunk and pyramid limits", () => {
    const setMaxBytes = vi.fn();
    const state = {
      datasets: [
        { ds: { chunkSize: 1024, setMaxBytes }, pyramid: { limitBytes: 0 } }
      ],
      ioParallel: true
    };
    const cache = createCacheRuntime({
      state,
      clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
      updatePerf: () => {},
      updatePyramidInflight: () => {},
      getIOConcurrencyMax: () => 2
    });

    cache.recomputeCacheBudgets();
    expect(setMaxBytes).toHaveBeenCalledTimes(1);
    expect(state.datasets[0].chunkBudgetBytes).toBeGreaterThan(0);
    expect(state.datasets[0].pyramidBudgetBytes).toBeGreaterThan(0);
    expect(state.datasets[0].pyramid.limitBytes).toBe(state.datasets[0].pyramidBudgetBytes);
  });

  test("reads cache fraction from config", () => {
    const cache = createCacheRuntime({
      state: { datasets: [], ioParallel: true },
      clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
      appConfig: { cache: { maxSystemMemoryFraction: 0.2 } },
      updatePerf: () => {},
      updatePyramidInflight: () => {},
      getIOConcurrencyMax: () => 2
    });
    expect(cache.cacheBudget.fracOfAvailable).toBeCloseTo(0.2);
  });

  test("records detected cache budget basis details", () => {
    Object.defineProperty(navigator, "deviceMemory", {
      configurable: true,
      value: 8
    });
    Object.defineProperty(performance, "memory", {
      configurable: true,
      value: { jsHeapSizeLimit: 2 * 1024 * 1024 * 1024 }
    });

    const state = {
      datasets: [
        { ds: { chunkSize: 1024, setMaxBytes: vi.fn() }, pyramid: { limitBytes: 0 } }
      ],
      ioParallel: true
    };
    const cache = createCacheRuntime({
      state,
      clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
      updatePerf: () => {},
      updatePyramidInflight: () => {},
      getIOConcurrencyMax: () => 2
    });

    cache.recomputeCacheBudgets();
    expect(cache.cacheBudget.detectedHeapLimitBytes).toBe(2 * 1024 * 1024 * 1024);
    expect(cache.cacheBudget.detectedDeviceMemoryBytes).toBe(8 * 1024 * 1024 * 1024);
    expect(cache.cacheBudget.detectedBudgetBasisBytes).toBe(2 * 1024 * 1024 * 1024);
  });
});
