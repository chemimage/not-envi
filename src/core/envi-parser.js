import { DATA_TYPES } from "./envi-types.js";
import { parseUmPerPixelFromCustomFields, parseUmPerPixelFromMapInfo } from "./scale-parser.js";

export function parseEnviValue(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  if (v.startsWith("{") && v.endsWith("}")) {
    const inner = v.slice(1, -1).trim();
    const parts = inner.split(",").map((s) => s.trim()).filter(Boolean);
    return parts.map((p) => {
      const q = p.replace(/^"(.*)"$/, "$1");
      const n = Number(q);
      return Number.isFinite(n) ? n : q;
    });
  }
  const unq = v.replace(/^"(.*)"$/, "$1");
  const n = Number(unq);
  return Number.isFinite(n) ? n : unq;
}

export function parseEnviHeader(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i += 1;
  if (i < lines.length && lines[i].trim().toLowerCase() === "envi") i += 1;

  const meta = {};
  let pendingKey = null;
  let pendingVal = "";

  const pushPending = () => {
    if (!pendingKey) return;
    meta[pendingKey] = parseEnviValue(pendingVal);
    pendingKey = null;
    pendingVal = "";
  };

  for (; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith(";")) continue;

    if (pendingKey) {
      pendingVal += ` ${line}`;
      if (line.includes("}")) pushPending();
      continue;
    }

    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const val = line.slice(eq + 1).trim();
    if (val.startsWith("{") && !val.includes("}")) {
      pendingKey = key;
      pendingVal = val;
    } else {
      meta[key] = parseEnviValue(val);
    }
  }
  pushPending();
  return meta;
}

export function normalizeMeta(raw) {
  const get = (k, def = null) => (k in raw ? raw[k] : def);
  const samples = Number(get("samples"));
  const lines = Number(get("lines"));
  const bands = Number(get("bands"));
  if (!(samples > 0 && lines > 0 && bands > 0)) {
    throw new Error("Invalid ENVI header: samples/lines/bands are required.");
  }

  const headerOffset = Number(get("header offset", 0)) || 0;
  const dataType = Number(get("data type"));
  const dataTypeInfo = DATA_TYPES.get(dataType);
  if (!dataTypeInfo) throw new Error(`Unsupported ENVI data type: ${dataType}`);

  const interleave = normalizeInterleave(get("interleave", "bsq"));

  const byteOrder = Number(get("byte order", 0)) || 0;
  const littleEndian = byteOrder === 0;

  let wavelengths = get("wavelength", null);
  if (Array.isArray(wavelengths)) {
    wavelengths = wavelengths.map((w) => {
      const n = Number(w);
      return Number.isFinite(n) ? n : w;
    });
  } else {
    wavelengths = null;
  }

  let bandNames = get("band names", get("band_names", null));
  if (!Array.isArray(bandNames)) bandNames = null;

  let defaultBands = get("default bands", null);
  if (Array.isArray(defaultBands)) {
    defaultBands = defaultBands.map((x) => {
      const n = Number(x);
      return Number.isFinite(n) ? n : null;
    }).filter((v) => v != null);
  } else {
    defaultBands = null;
  }

  const wlUnits = get("wavelength units", get("wavelength_units", ""));
  const desc = get("description", "");
  const mapInfo = get("map info", null);
  const scale = parseUmPerPixelFromMapInfo(mapInfo) || parseUmPerPixelFromCustomFields(raw);

  return {
    samples,
    lines,
    bands,
    headerOffset,
    dataType,
    dataTypeInfo,
    interleave,
    byteOrder,
    littleEndian,
    wavelengths,
    bandNames,
    defaultBands,
    wlUnits,
    desc,
    mapInfo,
    scale
  };
}

function normalizeInterleave(rawInterleave) {
  const v = String(rawInterleave).trim().toLowerCase();
  if (!v) return "bsq";

  // Non-standard numeric indices used by some exporters.
  if (v === "0") return "bsq";
  if (v === "1") return "bil";
  if (v === "2") return "bip";

  if (v === "bsq") return "bsq";
  if (v === "bil") return "bil";
  if (v === "bip" || v === "bsp") return "bip";

  throw new Error(`Unsupported interleave: ${v}`);
}
