import { APP_CONFIG } from "../app/config.js";
import { openTiffBackend } from "./tiff/backend/index.js";
import { describeTiffDataset } from "./tiff/describe.js";
import { TIFF_EXT_RE, yieldToEventLoop } from "./tiff/shared.js";
import { createFmapRangeDataSource } from "./fmap/index.js";
import { createFmapTiffDataSource } from "./fmap/tiff-range-source.js";
import { loadFmapWasmBytes } from "./fmap/wasm.js";

async function openTiffFmapRangeSource(file, deps) {
  if (!deps?.fmapEnabled) return null;
  const configured = { ...APP_CONFIG.fmap, ...(deps?.fmapOptions || {}) };
  const wasmBytes = deps?.fmapWasmBytes ?? await loadFmapWasmBytes();
  const rangeFactory = deps?.createFmapRangeDataSource || createFmapRangeDataSource;
  const maxLogicalResultBytes = deps?.tiffFmapOptions?.maxLogicalResultBytes ?? (128 * 1024 * 1024);
  const maxLogicalBytes = deps?.tiffFmapOptions?.maxLogicalBytes ?? maxLogicalResultBytes;
  return createFmapTiffDataSource(file, {
    createRangeSource: (selectedFile) => rangeFactory(selectedFile, {
      pageSize: configured.pageSizeBytes,
      poolBytes: configured.poolBytes,
      concurrency: deps?.ioConcurrency ?? configured.maxInflightRequests,
      maxInflightBytes: configured.maxInflightBytes,
      maxResultBytes: configured.maxResultBytes,
      maxQueuedRequests: configured.maxQueuedRequests,
      maxQueuedBytes: configured.maxQueuedBytes,
      maxLogicalResultBytes,
      maxLogicalBytes,
      batchBytes: configured.batchBytes,
      wasmBytes
    }),
    pageSize: configured.pageSizeBytes,
    poolBytes: configured.poolBytes,
    concurrency: deps?.ioConcurrency ?? configured.maxInflightRequests,
    maxWorkingSetBytes: deps?.tiffFmapOptions?.maxWorkingSetBytes ?? configured.maxQueuedBytes,
    maxLogicalResultBytes,
    maxQueuedReservations: deps?.tiffFmapOptions?.maxQueuedReservations ?? configured.maxQueuedRequests,
    maxQueuedReservationBytes: deps?.tiffFmapOptions?.maxQueuedReservationBytes ?? (configured.maxQueuedBytes * 2)
  });
}

function configureDatasetSource(desc, deps) {
  if (desc.mode === "linear" && desc.cached && desc.base) {
    desc.cached.setConcurrency(deps?.ioConcurrency ?? desc.cached.concurrency ?? APP_CONFIG.io.defaultConcurrency);
    desc.cached.setMaxBytes(deps?.cacheBytes ?? desc.cached.maxBytes ?? APP_CONFIG.io.defaultDatasetCacheBytes);
    return;
  }
  if (desc.cached && typeof desc.cached.setConcurrency === "function") {
    desc.cached.setConcurrency(deps?.ioConcurrency ?? APP_CONFIG.io.defaultConcurrency);
  }
  if (desc.cached && typeof desc.cached.setMaxBytes === "function") {
    desc.cached.setMaxBytes(deps?.cacheBytes ?? APP_CONFIG.io.defaultDatasetCacheBytes);
  }
}

function maybeCloseLinearTiff(tiff, desc) {
  if ((desc.mode !== "linear" && desc.mode !== "band-offset") || !tiff || typeof tiff.close !== "function") {
    return;
  }
  try {
    tiff.close();
  } catch (_err) {}
}

export function isTiffFile(fileLike) {
  return TIFF_EXT_RE.test(String(fileLike?.name || ""));
}

export async function addDatasetFromFile(file, deps = {}) {
  if (!isTiffFile(file)) {
    throw new Error(`Unsupported TIFF file: ${String(file?.name || "")}`);
  }

  deps?.setStatus?.("opening TIFF…", "warn");
  await yieldToEventLoop();
  let tiff = null;
  let fmapRangeSource = null;
  let desc = null;
  try {
    fmapRangeSource = await openTiffFmapRangeSource(file, deps);
    tiff = await openTiffBackend(file, { ...deps, tiffFmapRangeSource: fmapRangeSource });
    await yieldToEventLoop();
    desc = await describeTiffDataset(tiff, file, { ...deps, tiffFmapRangeSource: fmapRangeSource });
  } catch (error) {
    try { fmapRangeSource?.close?.(); } catch (_closeError) {}
    try { tiff?.close?.(); } catch (_closeError) {}
    throw error;
  }
  configureDatasetSource(desc, deps);
  maybeCloseLinearTiff(tiff, desc);

  const ds = deps.createDataset({
    hdrFile: null,
    dataFile: file,
    raw: desc.raw,
    meta: desc.meta,
    base: desc.base,
    cached: desc.cached
  });
  deps?.setStatus?.("ready", "ok");
  return ds;
}

export async function addDatasetsFromFileList(files, deps = {}) {
  const list = Array.from(files || []).filter((file) => isTiffFile(file));
  const datasets = [];
  for (const file of list) {
    datasets.push(await addDatasetFromFile(file, deps));
  }
  return { datasets, directFound: list.length };
}
