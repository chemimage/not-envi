import { APP_CONFIG } from "./config.js";

export function createCacheRuntime(deps) {
  const {
    state,
    clamp,
    appConfig,
    updatePerf,
    updatePyramidInflight,
    getIOConcurrencyMax,
    getActiveDatasetId,
    getVisibleDatasetIds
  } = deps;

  function resolveFiniteNumber(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  const configuredFraction = Number(appConfig?.cache?.maxSystemMemoryFraction);
  const cacheFraction = Number.isFinite(configuredFraction) ? clamp(configuredFraction, 0.05, 0.80) : 0.20;

  const cacheBudget = {
    fracOfAvailable: cacheFraction,
    minBytes: resolveFiniteNumber(appConfig?.cache?.minBytes, APP_CONFIG.cache.minBytes),
    maxBytes: resolveFiniteNumber(appConfig?.cache?.maxBytes, APP_CONFIG.cache.maxBytes),
    minChunkBudgetChunks: Math.max(1, Math.floor(resolveFiniteNumber(appConfig?.cache?.minChunkBudgetChunks, APP_CONFIG.cache.minChunkBudgetChunks))),
    minPyramidBytes: Math.max(0, Math.floor(resolveFiniteNumber(appConfig?.cache?.minPyramidBytes, APP_CONFIG.cache.minPyramidBytes))),
    hiddenMinChunkBudgetChunks: Math.max(1, Math.floor(resolveFiniteNumber(appConfig?.cache?.hiddenMinChunkBudgetChunks, APP_CONFIG.cache.hiddenMinChunkBudgetChunks))),
    hiddenMinPyramidBytes: Math.max(0, Math.floor(resolveFiniteNumber(appConfig?.cache?.hiddenMinPyramidBytes, APP_CONFIG.cache.hiddenMinPyramidBytes))),
    activeDatasetWeight: resolveFiniteNumber(appConfig?.cache?.activeDatasetWeight, APP_CONFIG.cache.activeDatasetWeight),
    visibleDatasetWeight: resolveFiniteNumber(appConfig?.cache?.visibleDatasetWeight, APP_CONFIG.cache.visibleDatasetWeight),
    hiddenDatasetWeight: resolveFiniteNumber(appConfig?.cache?.hiddenDatasetWeight, APP_CONFIG.cache.hiddenDatasetWeight),
    fracChunk: resolveFiniteNumber(appConfig?.cache?.fracChunk, APP_CONFIG.cache.fracChunk),
    fracPyramid: resolveFiniteNumber(appConfig?.cache?.fracPyramid, APP_CONFIG.cache.fracPyramid),
    detectedHeapLimitBytes: 0,
    detectedDeviceMemoryBytes: 0,
    detectedBudgetBasisBytes: 0,
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
    cacheBudget.detectedHeapLimitBytes = heapLimit;
    cacheBudget.detectedDeviceMemoryBytes = devBytes;
    cacheBudget.detectedBudgetBasisBytes = basis;
    let budget = basis * cacheBudget.fracOfAvailable;
    budget = clamp(budget, cacheBudget.minBytes, cacheBudget.maxBytes);
    return budget;
  }

  function normalizeDatasetKey(id) {
    const key = String(id || "");
    return key || null;
  }

  function resolveDatasetWeights() {
    const visibleKeys = new Set();
    const visibleIds = (typeof getVisibleDatasetIds === "function") ? getVisibleDatasetIds() : [];
    for (const id of visibleIds || []) {
      const key = normalizeDatasetKey(id);
      if (key) visibleKeys.add(key);
    }

    const activeKey = normalizeDatasetKey(
      (typeof getActiveDatasetId === "function") ? getActiveDatasetId() : state.activeId
    );
    const activeWeight = Math.max(0, Number(cacheBudget.activeDatasetWeight) || 0);
    const visibleWeight = Math.max(0, Number(cacheBudget.visibleDatasetWeight) || 0);
    const hiddenWeight = Math.max(0, Number(cacheBudget.hiddenDatasetWeight) || 0);
    const weights = new Map();
    let totalWeight = 0;

    for (const ds of state.datasets) {
      const key = normalizeDatasetKey(ds?.id);
      if (!key) continue;
      let weight = hiddenWeight;
      if (visibleKeys.has(key)) weight = Math.max(weight, visibleWeight);
      if (activeKey && key === activeKey) weight = Math.max(weight, activeWeight);
      weights.set(key, weight);
      totalWeight += weight;
    }

    if (totalWeight <= 0) {
      for (const ds of state.datasets) {
        const key = normalizeDatasetKey(ds?.id);
        if (!key) continue;
        weights.set(key, 1);
      }
      totalWeight = Math.max(1, weights.size);
    }
    return { weights, totalWeight, activeKey, visibleKeys };
  }

  function recomputeCacheBudgets() {
    if (!cacheBudget.totalBytes) {
      cacheBudget.totalBytes = estimateTotalCacheBudgetBytes();
    }
    const { weights, totalWeight, activeKey, visibleKeys } = resolveDatasetWeights();

    for (const ds of state.datasets) {
      const key = normalizeDatasetKey(ds?.id);
      const weight = key ? (weights.get(key) || 0) : 0;
      const share = totalWeight > 0 ? (weight / totalWeight) : 0;
      const budgetBytes = Math.floor(cacheBudget.totalBytes * share);
      const hiddenDataset = !!key && key !== activeKey && !visibleKeys.has(key);
      const minChunkBudgetChunks = hiddenDataset
        ? cacheBudget.hiddenMinChunkBudgetChunks
        : cacheBudget.minChunkBudgetChunks;
      const minPyramidBytes = hiddenDataset
        ? cacheBudget.hiddenMinPyramidBytes
        : cacheBudget.minPyramidBytes;
      const chunkSize = (ds.ds && ds.ds.chunkSize)
        ? ds.ds.chunkSize
        : (appConfig?.io?.defaultChunkSizeBytes || APP_CONFIG.io.defaultChunkSizeBytes);
      const chunkBytes = Math.max(
        chunkSize * minChunkBudgetChunks,
        Math.floor(budgetBytes * cacheBudget.fracChunk)
      );
      const pyramidBytes = Math.max(
        minPyramidBytes,
        Math.floor(budgetBytes * cacheBudget.fracPyramid)
      );

      ds.chunkBudgetBytes = chunkBytes;
      ds.pyramidBudgetBytes = pyramidBytes;
      if (ds.ds && ds.ds.setMaxBytes) ds.ds.setMaxBytes(chunkBytes);
      if (ds.pyramid) {
        ds.pyramid.limitBytes = pyramidBytes;
        ds.pyramid.compositionCache?.setLimit(pyramidBytes);
      }
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
