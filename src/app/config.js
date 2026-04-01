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

export const APP_CONFIG = Object.freeze({
  io: Object.freeze({
    parallelEnabledByDefault: true,
    defaultChunkSizeBytes: 1 << 20,
    defaultDatasetCacheBytes: 128 * MIB,
    defaultConcurrency: 2,
    minConcurrency: 1,
    maxConcurrency: 8,
    hardwareCoreFraction: 0.5,
    hardwareParallelDivisor: 2,
    hardwareParallelBias: 1,
    hardwareParallelMin: 2
  }),
  dataSource: Object.freeze({
    minChunkSizeBytes: 64 * KIB,
    defaultChunkSizeBytes: 1 << 20,
    defaultMaxBytes: 256 * MIB
  }),
  cache: Object.freeze({
    maxSystemMemoryFraction: 0.50,
    minBytes: 256 * MIB,
    maxBytes: 3 * GIB,
    minChunkBudgetChunks: 8,
    minPyramidBytes: 64 * MIB,
    fracChunk: 0.60,
    fracPyramid: 0.40
  }),
  pyramid: Object.freeze({
    tileSize: 128,
    defaultLimitBytes: 256 * MIB,
    inflightFactor: 0.75,
    inflightBias: 1,
    inflightMin: 2,
    inflightMax: 8,
    immediateCoarseMaxTiles: 64,
    immediateVisibleMaxTiles: 32
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
  render: Object.freeze({
    tiffPreviewMaxSparseSpans: 6_000,
    tiffPreviewMaxScaledDecodePixels: 120_000,
    tiffPreviewMaxFactor: 16
  }),
  tiff: Object.freeze({
    desktopRawCacheBytes: 512 * MIB,
    desktopDecodedCacheBytes: 2 * GIB,
    ipadRawCacheBytes: 128 * MIB,
    ipadDecodedCacheBytes: 512 * MIB,
    hugeCompressedStripFileBytes: 256 * MIB,
    hugeCompressedStripUncompressedBytes: 1 * GIB,
    rawValidationMaxFileBytes: 32 * MIB,
    rawValidationMaxUncompressedBytes: 128 * MIB,
    indexScanYieldEvery: 32,
    budgetRawFraction: 0.25,
    budgetMinBytes: 4 * MIB,
    workerCoreFraction: 0.5,
    workerPoolMin: 1,
    desktopWorkerPoolMax: 4,
    ipadWorkerPoolMax: 1,
    taskCoreFraction: 0.5,
    taskMinConcurrency: 2,
    taskMaxConcurrency: 8,
    fairShareMinPerDataset: 1
  })
});
