import { APP_CONFIG } from "./config.js";

export function createCacheRuntime(deps) {
  const {
    state,
    clamp,
    appConfig,
    updatePerf,
    updatePyramidInflight,
    getIOConcurrencyMax
  } = deps;

  const configuredFraction = Number(appConfig?.cache?.maxSystemMemoryFraction);
  const cacheFraction = Number.isFinite(configuredFraction) ? clamp(configuredFraction, 0.05, 0.80) : 0.20;

  const cacheBudget = {
    fracOfAvailable: cacheFraction,
    minBytes: Number(appConfig?.cache?.minBytes) || APP_CONFIG.cache.minBytes,
    maxBytes: Number(appConfig?.cache?.maxBytes) || APP_CONFIG.cache.maxBytes,
    minChunkBudgetChunks: Number(appConfig?.cache?.minChunkBudgetChunks) || APP_CONFIG.cache.minChunkBudgetChunks,
    minPyramidBytes: Number(appConfig?.cache?.minPyramidBytes) || APP_CONFIG.cache.minPyramidBytes,
    fracChunk: Number(appConfig?.cache?.fracChunk) || APP_CONFIG.cache.fracChunk,
    fracPyramid: Number(appConfig?.cache?.fracPyramid) || APP_CONFIG.cache.fracPyramid,
    totalBytes: 0
  };

  function estimateTotalCacheBudgetBytes() {
    let heapLimit = 0;
    try {
      heapLimit = (performance && performance.memory && performance.memory.jsHeapSizeLimit) ? performance.memory.jsHeapSizeLimit : 0;
    } catch (_err) {}
    let devBytes = 0;
    try {
      devBytes = (navigator && navigator.deviceMemory) ? (navigator.deviceMemory * 1024 * 1024 * 1024) : 0;
    } catch (_err) {}

    let basis = heapLimit || devBytes || (1024 * 1024 * 1024);
    if (heapLimit && devBytes) basis = Math.min(heapLimit, devBytes);
    let budget = basis * cacheBudget.fracOfAvailable;
    budget = clamp(budget, cacheBudget.minBytes, cacheBudget.maxBytes);
    return budget;
  }

  function recomputeCacheBudgets() {
    if (!cacheBudget.totalBytes) {
      cacheBudget.totalBytes = estimateTotalCacheBudgetBytes();
    }
    const n = Math.max(1, state.datasets.length);
    const per = cacheBudget.totalBytes / n;

    for (const ds of state.datasets) {
      const chunkSize = (ds.ds && ds.ds.chunkSize)
        ? ds.ds.chunkSize
        : (appConfig?.io?.defaultChunkSizeBytes || APP_CONFIG.io.defaultChunkSizeBytes);
      const chunkBytes = Math.max(
        chunkSize * cacheBudget.minChunkBudgetChunks,
        Math.floor(per * cacheBudget.fracChunk)
      );
      const pyramidBytes = Math.max(
        cacheBudget.minPyramidBytes,
        Math.floor(per * cacheBudget.fracPyramid)
      );

      ds.chunkBudgetBytes = chunkBytes;
      ds.pyramidBudgetBytes = pyramidBytes;
      if (ds.ds && ds.ds.setMaxBytes) ds.ds.setMaxBytes(chunkBytes);
      if (ds.pyramid) ds.pyramid.limitBytes = pyramidBytes;
    }
    updatePerf();
  }

  function setIOParallel(enabled) {
    const on = !!enabled;
    state.ioParallel = on;
    const io = on ? getIOConcurrencyMax() : 1;

    for (const ds of state.datasets) {
      try {
        if (ds && ds.ds) {
          if (typeof ds.ds.setConcurrency === "function") ds.ds.setConcurrency(io);
          else if (typeof ds.ds.concurrency === "number") {
            ds.ds.concurrency = clamp(
              io,
              Number(appConfig?.io?.minConcurrency) || APP_CONFIG.io.minConcurrency,
              Number(appConfig?.io?.maxConcurrency) || APP_CONFIG.io.maxConcurrency
            );
          }
        }
        if (ds && ds.pyramid) updatePyramidInflight(ds);
      } catch (_err) {}
    }
    updatePerf();
    return io;
  }

  return {
    cacheBudget,
    setIOParallel,
    recomputeCacheBudgets
  };
}
