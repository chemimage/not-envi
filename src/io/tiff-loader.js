import { APP_CONFIG } from "../app/config.js";
import { openTiffBackend } from "./tiff/backend/index.js";
import { describeTiffDataset } from "./tiff/describe.js";
import { TIFF_EXT_RE, yieldToEventLoop } from "./tiff/shared.js";

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
  const tiff = await openTiffBackend(file, deps);
  await yieldToEventLoop();

  const desc = await describeTiffDataset(tiff, file, deps);
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
