export function createCacheRuntime(deps) {
  const {
    state,
    clamp,
    updatePerf,
    updatePyramidInflight,
    getIOConcurrencyMax
  } = deps;

  const cacheBudget = {
    fracOfAvailable: 0.40,
    minBytes: 256 * 1024 * 1024,
    maxBytes: 3 * 1024 * 1024 * 1024,
    fracChunk: 0.60,
    fracPyramid: 0.40,
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
      const chunkSize = (ds.ds && ds.ds.chunkSize) ? ds.ds.chunkSize : (1 << 20);
      const chunkBytes = Math.max(chunkSize * 8, Math.floor(per * cacheBudget.fracChunk));
      const pyramidBytes = Math.max(64 * 1024 * 1024, Math.floor(per * cacheBudget.fracPyramid));

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
          else if (typeof ds.ds.concurrency === "number") ds.ds.concurrency = clamp(io, 1, 8);
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
