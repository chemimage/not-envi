import { BlobDataSource, ChunkCacheDataSource } from "../core/data-source.js";
import { normalizeMeta, parseEnviHeader } from "../core/envi-parser.js";

const COMMON_ENVI_DATA_EXTS = [
  ".dat", "", ".img", ".raw", ".bin", ".bip", ".bil", ".bsq"
];

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

  deps?.setStatus?.("opening data…", "warn");
  const base = new BlobDataSource(dataFile);
  const cached = new ChunkCacheDataSource(base, {
    chunkSize: deps?.chunkSize ?? (1 << 20),
    maxBytes: deps?.cacheBytes ?? (128 * 1024 * 1024),
    concurrency: deps?.ioConcurrency ?? 2
  });

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
