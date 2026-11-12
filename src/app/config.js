const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function detectHardwareCores(fallback = 4) {
  const cores = Number(
    (typeof navigator !== "undefined" && navigator && navigator.hardwareConcurrency)
      ? navigator.hardwareConcurrency
      : fallback
  );
  return Math.max(1, Math.floor(Number.isFinite(cores) ? cores : fallback));
}

export function detectDeviceMemoryGiB(fallback = 0) {
  const deviceMemory = Number(
    (typeof navigator !== "undefined" && navigator && navigator.deviceMemory)
      ? navigator.deviceMemory
      : fallback
  );
  return Number.isFinite(deviceMemory) && deviceMemory > 0
    ? deviceMemory
    : Math.max(0, Number(fallback) || 0);
}

export function resolveHardwareConcurrencyLimit({
  fraction = 1,
  min = 1,
  max = Number.POSITIVE_INFINITY,
  fallback = 4
} = {}) {
  const cores = detectHardwareCores(fallback);
  const scaled = Math.floor(cores * Math.max(0, Number(fraction) || 0));
  return clamp(Math.max(1, scaled || 1), Math.max(1, Number(min) || 1), Math.max(1, Number(max) || 1));
}

export function shouldUseLitePreviewProfile() {
  const deviceMemoryGiB = detectDeviceMemoryGiB(0);
  const hardwareCores = detectHardwareCores(0);
  if (deviceMemoryGiB > 0 && deviceMemoryGiB <= APP_CONFIG.previewOverview.liteProfileMaxDeviceMemoryGiB) {
    return true;
  }
  if (hardwareCores > 0 && hardwareCores <= APP_CONFIG.previewOverview.liteProfileMaxHardwareCores) {
    return true;
  }
  return false;
}

export function resolvePreviewOverviewLongEdge({ deferred = true, bootstrap = false } = {}) {
  const useLite = shouldUseLitePreviewProfile();
  if (bootstrap) {
    return useLite
      ? APP_CONFIG.previewOverview.liteBootstrapLongEdge
      : APP_CONFIG.previewOverview.standardBootstrapLongEdge;
  }
  if (deferred) {
    return useLite
      ? APP_CONFIG.previewOverview.liteDeferredLongEdge
      : APP_CONFIG.previewOverview.standardDeferredLongEdge;
  }
  return useLite
    ? APP_CONFIG.previewOverview.liteInitialLongEdge
    : APP_CONFIG.previewOverview.standardInitialLongEdge;
}

export const APP_CONFIG = Object.freeze({
  fmap: Object.freeze({
    pageSizeBytes: 256 * KIB,
    poolBytes: 512 * MIB,
    maxInflightBytes: 8 * MIB,
    maxInflightRequests: 2,
    maxResultBytes: 4 * MIB,
    maxQueuedRequests: 64,
    maxQueuedBytes: 32 * MIB,
    batchBytes: 64 * KIB,
    sparseReadThresholdBytes: 32 * KIB,
    sparseReadMaxGapBytes: 4096
  }),
  io: Object.freeze({
    parallelEnabledByDefault: true,
    defaultChunkSizeBytes: 1 << 20,
    defaultDatasetCacheBytes: 256 * MIB,
    defaultConcurrency: 3,
    minConcurrency: 1,
    maxConcurrency: 12,
    hardwareCoreFraction: 0.75,
    hardwareParallelDivisor: 2,
    hardwareParallelBias: 1,
    hardwareParallelMin: 3
  }),
  scheduler: Object.freeze({
    coreFraction: 0.75,
    minConcurrency: 3,
    maxConcurrency: 12,
    fairShareMinPerOwner: 1
  }),
  dataSource: Object.freeze({
    minChunkSizeBytes: 64 * KIB,
    defaultChunkSizeBytes: 1 << 20,
    defaultMaxBytes: 512 * MIB
  }),
  cache: Object.freeze({
    maxSystemMemoryFraction: 0.60,
    minBytes: 256 * MIB,
    maxBytes: 4 * GIB,
    minChunkBudgetChunks: 12,
    minPyramidBytes: 64 * MIB,
    hiddenMinChunkBudgetChunks: 2,
    hiddenMinPyramidBytes: 8 * MIB,
    activeDatasetWeight: 2.0,
    visibleDatasetWeight: 1.0,
    hiddenDatasetWeight: 0.1,
    fracChunk: 0.70,
    fracPyramid: 0.30
  }),
  pyramid: Object.freeze({
    tileSize: 128,
    defaultLimitBytes: 256 * MIB,
    inflightFactor: 0.75,
    inflightBias: 1,
    inflightMin: 2,
    inflightMax: 8,
    pinnedOverviewLevels: 3,
    immediateOverviewMaxTiles: 32,
    immediateCoarseMaxTiles: 64,
    immediateVisibleMaxTiles: 48,
    backgroundQueueSoftMax: 64,
    backgroundPrefetchPlanLimit: 48,
    directionalIntentMaxAgeMs: 220,
    directionalIntentMinImageDelta: 8,
    directionalBiasFactor: 7,
    directionalLateralPenalty: 1.5
  }),
  scratch: Object.freeze({
    defaultMaxRetainedBuffers: 2,
    defaultMaxRetainedElements: 1 << 20,
    render: Object.freeze({
      maxRetainedBuffers: 2,
      maxRetainedElements: 2_097_152
    }),
    histogram: Object.freeze({
      maxRetainedBuffers: 2,
      maxRetainedElements: 1_048_576
    }),
    thumbnail: Object.freeze({
      maxRetainedBuffers: 3,
      maxRetainedElements: 1_048_576
    }),
    spectrumArea: Object.freeze({
      maxRetainedBuffers: 1,
      maxRetainedElements: 1_048_576
    })
  }),
  previewOverview: Object.freeze({
    standardBootstrapLongEdge: 320,
    standardInitialLongEdge: 1024,
    standardLongEdge: 2048,
    standardDeferredLongEdge: 2048,
    liteBootstrapLongEdge: 256,
    liteInitialLongEdge: 512,
    liteLongEdge: 1024,
    liteDeferredLongEdge: 1024,
    liteProfileMaxDeviceMemoryGiB: 8,
    liteProfileMaxHardwareCores: 6
  }),
  render: Object.freeze({
    previewMaxReadBytes: 32 * MIB,
    previewMaxSparseSpans: 6_000,
    previewMaxScaledDecodePixels: 200_000,
    previewMaxFactor: 16
  }),
  histogram: Object.freeze({
    autoWholeStatsMaxPixels: 20_000_000,
    autoWholeStatsMaxReadBytes: 24 * MIB
  }),
  spectrum: Object.freeze({
    discreteBarMaxBands: 20
  }),
  lineProfile: Object.freeze({
    maxSamples: 1024,
    concurrency: 3
  }),
  tiff: Object.freeze({
    // `standard` is sized around a current desktop / laptop with at least
    // 16GB RAM, and is comfortable on 24GB-class machines.
    standardReferenceDeviceMemoryGiB: 24,
    standardReferenceHardwareCores: 10,
    standardRawCacheBytes: 768 * MIB,
    standardDecodedCacheBytes: 2560 * MIB,

    // `lite` is sized to stay safe on current iPad Pro class hardware.
    liteReferenceDeviceMemoryGiB: 8,
    liteReferenceHardwareCores: 6,
    liteProfileMaxDeviceMemoryGiB: 8,
    liteProfileMaxHardwareCores: 6,
    liteRawCacheBytes: 192 * MIB,
    liteDecodedCacheBytes: 640 * MIB,
    hugeCompressedStripFileBytes: 256 * MIB,
    hugeCompressedStripUncompressedBytes: 1 * GIB,
    rawValidationMaxFileBytes: 32 * MIB,
    rawValidationMaxUncompressedBytes: 128 * MIB,
    indexScanYieldEvery: 32,
    sparseRawRowBatchRows: 12,
    progressiveUpdateEveryBlocks: 2,
    progressiveUpdateMinMs: 40,
    budgetRawFraction: 0.25,
    budgetMinBytes: 4 * MIB,
    workerCoreFraction: 0.5,
    workerPoolMin: 1,
    standardWorkerPoolMax: 6,
    liteWorkerPoolMax: 2
  })
});
