import { BlobDataSource, ChunkCacheDataSource } from "../core/data-source.js";
import { normalizeMeta, parseEnviHeader } from "../core/envi-parser.js";
import { APP_CONFIG } from "../app/config.js";
import { EnviDataSource } from "./envi-data-source.js";
import { createFmapDataSource } from "./fmap/index.js";
import fmapWasmUrl from "../../wasm/fmap/pkg/fmap_core.wasm?url";

const COMMON_ENVI_DATA_EXTS = [
  ".dat", "", ".img", ".raw", ".bin", ".bip", ".bil", ".bsq"
];

let fmapWasmBytesPromise = null;

async function loadFmapWasmBytes() {
  if (!fmapWasmBytesPromise) {
    fmapWasmBytesPromise = fetch(fmapWasmUrl).then((response) => {
      if (!response.ok) throw new Error(`Unable to load fmap WASM (${response.status}).`);
      return response.arrayBuffer();
    });
  }
  return fmapWasmBytesPromise;
}

export function fileExtLower(name) {
  const m = /\.[^.]+$/.exec(name);
  return m ? m[0].toLowerCase() : "";
}

export function stripHdrExt(name) {
  return name.replace(/\.hdr$/i, "");
}

export function buildFileNameMap(files) {
  const map = new Map();
  for (const f of files) {
    map.set(f.name.toLowerCase(), f);
  }
  return map;
}

export function findMatchingDataFileForHdr(hdrFile, fileMap) {
  const stem = stripHdrExt(hdrFile.name);
  const stemLower = stem.toLowerCase();
  const candidates = [];

  candidates.push(stemLower);
  for (const ext of COMMON_ENVI_DATA_EXTS) {
    if (!ext) continue;
    if (stemLower.endsWith(ext)) continue;
    candidates.push(stemLower + ext);
  }

  for (const nameLower of candidates) {
    const f = fileMap.get(nameLower);
    if (f && f !== hdrFile) return f;
  }

  const baseKey = stemLower;
  let best = null;
  for (const [k, f] of fileMap.entries()) {
    if (f === hdrFile) continue;
    if (k === baseKey) {
      best = f;
      break;
    }
    if (k.startsWith(baseKey + ".")) {
      if (!best || f.size > best.size) best = f;
    }
  }
  return best;
}

export async function addDatasetsFromFileList(files, deps) {
  const list = Array.from(files || []);
  if (!list.length) return { datasets: [], missing: [] };

  const fileMap = buildFileNameMap(list);
  const hdrs = list.filter((f) => fileExtLower(f.name) === ".hdr");
  const tasks = [];
  const missing = [];

  for (const hdr of hdrs) {
    const data = findMatchingDataFileForHdr(hdr, fileMap);
    if (!data) {
      missing.push(hdr.name);
      continue;
    }
    tasks.push({ hdr, data });
  }

  tasks.sort((a, b) => a.hdr.name.localeCompare(b.hdr.name));

  const datasets = [];
  for (const t of tasks) {
    const ds = await addDatasetFromFiles(t.hdr, t.data, deps);
    datasets.push(ds);
  }
  return { datasets, missing, headersFound: hdrs.length };
}

export async function addDatasetFromFiles(hdrFile, dataFile, deps) {
  deps?.setStatus?.("reading header…", "warn");
  const text = await readTextFile(hdrFile);
  const raw = parseEnviHeader(text);
  const meta = normalizeMeta(raw);
  validateEnviPayload(meta, dataFile?.size);

  deps?.setStatus?.("opening data…", "warn");
  let base = null;
  let cached = null;
  if (deps?.fmapEnabled && supportsFmap(meta)) {
    const factory = deps?.createFmapDataSource ?? createFmapDataSource;
    const options = deps?.fmapOptions || APP_CONFIG.fmap;
    const wasmBytes = deps?.fmapWasmBytes ?? await loadFmapWasmBytes();
    cached = factory(dataFile, meta, {
      pageSize: options.pageSizeBytes,
      poolBytes: options.poolBytes,
      concurrency: deps?.ioConcurrency ?? options.maxInflightRequests,
      maxInflightBytes: options.maxInflightBytes,
      maxResultBytes: options.maxResultBytes,
      maxQueuedRequests: options.maxQueuedRequests,
      maxQueuedBytes: options.maxQueuedBytes,
      batchBytes: options.batchBytes,
      sparseReadThresholdBytes: options.sparseReadThresholdBytes,
      sparseReadMaxGapBytes: options.sparseReadMaxGapBytes,
      wasmBytes
    });
    try { await cached.ready; } catch (error) { cached.close(); throw error; }
  } else {
    base = new BlobDataSource(dataFile);
    const source = new ChunkCacheDataSource(base, {
      chunkSize: deps?.chunkSize ?? APP_CONFIG.io.defaultChunkSizeBytes,
      maxBytes: deps?.cacheBytes ?? APP_CONFIG.io.defaultDatasetCacheBytes,
      concurrency: deps?.ioConcurrency ?? APP_CONFIG.io.defaultConcurrency
    });
    cached = new EnviDataSource(source, meta);
  }

  const ds = deps.createDataset({
    hdrFile,
    dataFile,
    raw,
    meta,
    base,
    cached
  });

  deps?.setStatus?.("ready", "ok");
  return ds;
}

export function supportsFmap(meta) {
  return meta?.interleave === "bsq"
    && Number(meta?.dataType) === 4
    && Number(meta?.dataTypeInfo?.bytes) === 4;
}

export function validateEnviPayload(meta, fileSize) {
  const samples = Number(meta?.samples);
  const lines = Number(meta?.lines);
  const bands = Number(meta?.bands);
  const bytes = Number(meta?.dataTypeInfo?.bytes);
  const headerOffset = Number(meta?.headerOffset || 0);
  const size = Number(fileSize);
  const fields = [samples, lines, bands, bytes, headerOffset, size];
  if (!fields.every(Number.isSafeInteger) || samples <= 0 || lines <= 0 || bands <= 0 || bytes <= 0 || headerOffset < 0 || size < 0) {
    throw new Error("Invalid ENVI dimensions, header offset, sample size, or file size.");
  }
  const sampleCount = samples * lines * bands;
  const payloadBytes = sampleCount * bytes;
  const requiredBytes = headerOffset + payloadBytes;
  if (!Number.isSafeInteger(sampleCount) || !Number.isSafeInteger(payloadBytes) || !Number.isSafeInteger(requiredBytes)) {
    throw new Error("ENVI payload size exceeds the browser's exact file-offset range.");
  }
  if (requiredBytes > size) {
    throw new Error(`ENVI data file is truncated: expected at least ${requiredBytes} bytes, found ${size}.`);
  }
  return requiredBytes;
}

async function readTextFile(fileLike) {
  if (fileLike && typeof fileLike.text === "function") {
    return fileLike.text();
  }

  if (typeof FileReader !== "undefined") {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(fr.error || new Error("Failed reading text file"));
      fr.onload = () => resolve(String(fr.result || ""));
      fr.readAsText(fileLike);
    });
  }

  if (typeof Response !== "undefined") {
    const res = new Response(fileLike);
    return res.text();
  }

  throw new Error("No text file reader available in this runtime.");
}
