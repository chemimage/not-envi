const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

export const APP_CONFIG = Object.freeze({
  io: Object.freeze({
    parallelEnabledByDefault: true,
    defaultChunkSizeBytes: 1 << 20,
    defaultDatasetCacheBytes: 128 * MIB,
    defaultConcurrency: 2,
    minConcurrency: 1,
    maxConcurrency: 8,
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
    tiffPreviewMaxSparseSpans: 24_000,
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
    desktopWorkerPoolMax: 4,
    ipadWorkerPoolMax: 1
  })
});
