import { fromBlob, Pool } from "geotiff";
import { ChunkCacheDataSource, BlobDataSource } from "../core/data-source.js";
import {
  makeSegmentReader,
  readBandWindow as readBandWindowCore,
  readBandWindowBIP as readBandWindowBIPCore,
  segGet
} from "../core/raster-io.js";
import { DATA_TYPES } from "../core/envi-types.js";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const TIFF_EXT_RE = /\.(tif|tiff)$/i;
const TIFF_PHOTOMETRIC_WHITE_IS_ZERO = 0;
const TIFF_PHOTOMETRIC_BLACK_IS_ZERO = 1;
const TIFF_PHOTOMETRIC_RGB = 2;
const RGB_U8_TYPE = 1;
const RGB_U8_INFO = DATA_TYPES.get(RGB_U8_TYPE);
const MIB = 1024 * 1024;
const TIFF_DESKTOP_RAW_CACHE_BYTES = 32 * MIB;
const TIFF_DESKTOP_DECODED_CACHE_BYTES = 96 * MIB;
const TIFF_IPAD_RAW_CACHE_BYTES = 8 * MIB;
const TIFF_IPAD_DECODED_CACHE_BYTES = 24 * MIB;
const TIFF_HUGE_COMPRESSED_STRIP_FILE_BYTES = 64 * MIB;
const TIFF_HUGE_COMPRESSED_STRIP_UNCOMPRESSED_BYTES = 128 * MIB;
const perfNow = () => (
  (typeof performance !== "undefined" && typeof performance.now === "function")
    ? performance.now()
    : Date.now()
);

function createTiffStats() {
  return {
    bytesRead: 0,
    readCalls: 0,
    readIntoCalls: 0,
    visitPagesCalls: 0,
    rawCacheHits: 0,
    rawCacheMisses: 0,
    decodedCacheHits: 0,
    decodedCacheMisses: 0,
    decodeCalls: 0,
    decodeMs: 0,
    blockReads: 0,
    blockComposeCalls: 0,
    blockComposeMs: 0,
    rawCacheBytes: 0,
    decodedCacheBytes: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheEvictions: 0,
    cacheBytes: 0
  };
}

function listTagValues(value) {
  if (Array.isArray(value)) return value.map((entry) => Number(entry));
  if (ArrayBuffer.isView(value)) return Array.from(value, (entry) => Number(entry));
  if (value == null) return [];
  return [Number(value)];
}

function firstFinite(values, fallback = 0) {
  for (const value of values) {
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

function firstSafeOffsetOrNull(values) {
  for (const value of values) {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) continue;
    const whole = Math.trunc(num);
    if (!Number.isSafeInteger(whole)) continue;
    return whole;
  }
  return null;
}

function requireSafeOffset(value, label) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || !Number.isSafeInteger(Math.trunc(num))) {
    throw new Error(`Unsupported TIFF ${label}: ${String(value)}`);
  }
  return Math.trunc(num);
}

function sampleFormatToEnviType(sampleFormat, bitsPerSample) {
  const format = Number(sampleFormat) || 1;
  const bits = Number(bitsPerSample) || 0;
  if (format === 1) {
    if (bits === 8) return 1;
    if (bits === 16) return 12;
    if (bits === 32) return 13;
    if (bits === 64) return 15;
  }
  if (format === 2) {
    if (bits === 16) return 2;
    if (bits === 32) return 3;
    if (bits === 64) return 14;
  }
  if (format === 3) {
    if (bits === 32) return 4;
    if (bits === 64) return 5;
  }
  throw new Error(`Unsupported TIFF sample type: format ${format}, ${bits} bits`);
}

function summarizeImage(image) {
  const width = Number(image.getWidth());
  const height = Number(image.getHeight());
  const samplesPerPixel = Number(image.getSamplesPerPixel()) || 1;
  const bitsPerSample = [];
  const sampleFormats = [];
  for (let sample = 0; sample < samplesPerPixel; sample += 1) {
    bitsPerSample.push(Number(image.getBitsPerSample(sample)) || 0);
    sampleFormats.push(Number(image.getSampleFormat(sample)) || 1);
  }
  const fileDirectory = image.getFileDirectory();
  const planarConfiguration = firstFinite([fileDirectory?.PlanarConfiguration], 1);
  const photometricInterpretation = firstFinite([
    fileDirectory?.PhotometricInterpretation
  ], samplesPerPixel === 3 ? TIFF_PHOTOMETRIC_RGB : TIFF_PHOTOMETRIC_BLACK_IS_ZERO);
  const compression = firstFinite([fileDirectory?.Compression], 1);
  const rowsPerStrip = firstFinite([fileDirectory?.RowsPerStrip], height);
  const stripOffsets = listTagValues(fileDirectory?.StripOffsets);
  const stripByteCounts = listTagValues(fileDirectory?.StripByteCounts);
  const tileOffsets = listTagValues(fileDirectory?.TileOffsets);
  const pageNumber = listTagValues(fileDirectory?.PageNumber);
  return {
    image,
    fileDirectory,
    width,
    height,
    samplesPerPixel,
    bitsPerSample,
    sampleFormats,
    planarConfiguration,
    photometricInterpretation,
    compression,
    rowsPerStrip,
    stripOffsets,
    stripByteCounts,
    tileOffsets,
    pageNumber
  };
}

function resolveUniformSampleType(summary, label = "TIFF image") {
  const bits = summary.bitsPerSample[0];
  const format = summary.sampleFormats[0];
  for (let i = 1; i < summary.samplesPerPixel; i += 1) {
    if (Number(summary.bitsPerSample[i]) !== Number(bits) || Number(summary.sampleFormats[i]) !== Number(format)) {
      throw new Error(`${label} mixes sample types across channels, which is not supported.`);
    }
  }
  const dataType = sampleFormatToEnviType(format, bits);
  const dataTypeInfo = DATA_TYPES.get(dataType);
  if (!dataTypeInfo) {
    throw new Error(`Unsupported TIFF sample type for ${label}.`);
  }
  return { bits, format, dataType, dataTypeInfo };
}

function buildMeta({
  width,
  height,
  bands,
  interleave,
  littleEndian,
  dataType,
  dataTypeInfo,
  headerOffset = 0,
  bandNames = null,
  defaultBands = null,
  defaultDisplayMode = null,
  defaultAdjustColor = null,
  description = ""
}) {
  return {
    samples: width,
    lines: height,
    bands,
    interleave,
    littleEndian: !!littleEndian,
    headerOffset,
    dataType,
    dataTypeInfo,
    bandNames,
    defaultBands,
    defaultDisplayMode,
    defaultAdjustColor,
    description,
    sourceFormat: "tiff",
    wlUnits: null,
    wavelengths: null,
    scale: null
  };
}

function photometricName(code) {
  if (Number(code) === TIFF_PHOTOMETRIC_WHITE_IS_ZERO) return "WhiteIsZero";
  if (Number(code) === TIFF_PHOTOMETRIC_BLACK_IS_ZERO) return "BlackIsZero";
  if (Number(code) === TIFF_PHOTOMETRIC_RGB) return "RGB";
  if (Number(code) === 3) return "Palette";
  if (Number(code) === 4) return "Mask";
  if (Number(code) === 5) return "CMYK";
  if (Number(code) === 6) return "YCbCr";
  if (Number(code) === 8) return "CIELab";
  if (Number(code) === 9) return "ICCLab";
  return `Photometric ${String(code)}`;
}

function isRawCompatibleGrayscale(summary) {
  return summary.samplesPerPixel === 1
    && (
      Number(summary.photometricInterpretation) === TIFF_PHOTOMETRIC_WHITE_IS_ZERO
      || Number(summary.photometricInterpretation) === TIFF_PHOTOMETRIC_BLACK_IS_ZERO
    );
}

function isRawCompatibleRgb(summary) {
  return summary.samplesPerPixel === 3
    && Number(summary.photometricInterpretation) === TIFF_PHOTOMETRIC_RGB;
}

function isRawCompatibleSummary(summary) {
  return isRawCompatibleGrayscale(summary) || isRawCompatibleRgb(summary);
}

function needsRgbWindowSource(summary) {
  return summary.samplesPerPixel >= 1 && !isRawCompatibleSummary(summary);
}

function buildRgbDisplayMeta(summary, description) {
  return buildMeta({
    width: summary.width,
    height: summary.height,
    bands: 3,
    interleave: "bip",
    littleEndian: true,
    dataType: RGB_U8_TYPE,
    dataTypeInfo: RGB_U8_INFO,
    bandNames: ["Red", "Green", "Blue"],
    defaultBands: [0, 1, 2],
    defaultDisplayMode: "rgb",
    defaultAdjustColor: "red",
    description
  });
}

function isIpadLike() {
  if (typeof navigator === "undefined") return false;
  const ua = String(navigator.userAgent || "");
  if (/iPad/i.test(ua)) return true;
  return navigator.platform === "MacIntel" && Number(navigator.maxTouchPoints || 0) > 1;
}

function resolveTiffCacheBudgets(deps = {}) {
  const isIpad = isIpadLike();
  const defaultRaw = isIpad ? TIFF_IPAD_RAW_CACHE_BYTES : TIFF_DESKTOP_RAW_CACHE_BYTES;
  const defaultDecoded = isIpad ? TIFF_IPAD_DECODED_CACHE_BYTES : TIFF_DESKTOP_DECODED_CACHE_BYTES;
  const defaultTotal = defaultRaw + defaultDecoded;
  const totalHint = Number(deps?.cacheBytes);
  if (Number.isFinite(totalHint) && totalHint > 0) {
    const total = Math.min(totalHint, defaultTotal);
    const raw = Math.max(4 * MIB, Math.floor(total * 0.25));
    return {
      rawCacheBytes: Math.min(raw, total),
      decodedCacheBytes: Math.max(4 * MIB, total - Math.min(raw, total)),
      workerPoolSize: Math.max(0, Math.min(Number(deps?.ioConcurrency) || 2, isIpad ? 1 : 4))
    };
  }
  return {
    rawCacheBytes: defaultRaw,
    decodedCacheBytes: defaultDecoded,
    workerPoolSize: Math.max(0, Math.min(Number(deps?.ioConcurrency) || 2, isIpad ? 1 : 4))
  };
}

function isSingleStrip(summary) {
  return !summary.tileOffsets.length
    && Number(summary.rowsPerStrip) >= Number(summary.height)
    && summary.stripOffsets.length === 1
    && summary.stripByteCounts.length === 1;
}

function isHugeCompressedSingleStrip(summary, sampleType, file = null) {
  if (Number(summary.compression) === 1) return false;
  if (!isSingleStrip(summary)) return false;
  const uncompressedBytes = Number(summary.width)
    * Number(summary.height)
    * Number(summary.samplesPerPixel)
    * Number(sampleType?.dataTypeInfo?.bytes || 0);
  return uncompressedBytes >= TIFF_HUGE_COMPRESSED_STRIP_UNCOMPRESSED_BYTES
    || Number(file?.size || 0) >= TIFF_HUGE_COMPRESSED_STRIP_FILE_BYTES;
}

function readDataViewValue(dv, byteOffset, info, littleEndian) {
  switch (info?.dv) {
    case "getUint8": return dv.getUint8(byteOffset);
    case "getInt16": return dv.getInt16(byteOffset, littleEndian);
    case "getUint16": return dv.getUint16(byteOffset, littleEndian);
    case "getInt32": return dv.getInt32(byteOffset, littleEndian);
    case "getUint32": return dv.getUint32(byteOffset, littleEndian);
    case "getFloat32": return dv.getFloat32(byteOffset, littleEndian);
    case "getFloat64": return dv.getFloat64(byteOffset, littleEndian);
    case "getBigInt64": return Number(dv.getBigInt64(byteOffset, littleEndian));
    case "getBigUint64": return Number(dv.getBigUint64(byteOffset, littleEndian));
    default: return dv.getFloat32(byteOffset, littleEndian);
  }
}

function pickValidationBands(bands) {
  const out = [];
  const push = (value) => {
    const band = Math.max(0, Math.min(Math.max(0, Number(bands) - 1), Number(value) || 0));
    if (!out.includes(band)) out.push(band);
  };
  push(0);
  if (Number(bands) > 2) push(1);
  if (Number(bands) > 1) push(Number(bands) - 1);
  return out;
}

function pickValidationWindows(width, height) {
  const outW = Math.max(1, Math.min(2, Number(width) || 0));
  const outH = Math.max(1, Math.min(2, Number(height) || 0));
  const windows = [];
  const add = (x0, y0) => {
    const key = `${x0}:${y0}:${outW}:${outH}`;
    if (windows.some((entry) => entry.key === key)) return;
    windows.push({ key, x0, y0, outW, outH });
  };
  add(0, 0);
  add(Math.max(0, Number(width) - outW), Math.max(0, Number(height) - outH));
  add(
    Math.max(0, Math.floor((Math.max(1, Number(width)) - outW) / 2)),
    Math.max(0, Math.floor((Math.max(1, Number(height)) - outH) / 2))
  );
  return windows;
}

async function readOracleBandWindow(meta, images, band, x0, y0, outW, outH) {
  const imageIndex = images.length === 1 ? 0 : band;
  const sampleIndex = images.length === 1 ? band : 0;
  const image = images[imageIndex]?.image || null;
  if (!image) throw new Error(`TIFF image ${Number(imageIndex) + 1} is unavailable.`);
  return image.readRasters({
    window: [x0, y0, x0 + outW, y0 + outH],
    samples: [sampleIndex],
    interleave: true,
    width: outW,
    height: outH,
    resampleMethod: "nearest",
    fillValue: 0
  });
}

async function readCandidateBandWindow(meta, ds, band, x0, y0, outW, outH) {
  if (meta.interleave === "bip") {
    return readBandWindowBIPCore(meta, ds, band, x0, y0, outW, outH, 1, 1);
  }
  return readBandWindowCore(meta, ds, band, x0, y0, outW, outH, 1, 1);
}

function bandWindowMatches(meta, actual, expected) {
  if (!actual || !expected || actual.length !== expected.length) return false;
  const isFloat = Number(meta?.dataType) === 4 || Number(meta?.dataType) === 5;
  for (let i = 0; i < actual.length; i += 1) {
    const a = Number(actual[i]);
    const e = Number(expected[i]);
    if (!Number.isFinite(a) || !Number.isFinite(e)) {
      if (!(Number.isNaN(a) && Number.isNaN(e))) return false;
      continue;
    }
    if (isFloat) {
      const tol = Math.max(1e-6, Math.abs(e) * 1e-5);
      if (Math.abs(a - e) > tol) return false;
    } else if (a !== e) {
      return false;
    }
  }
  return true;
}

async function validateRawCandidate(meta, ds, images) {
  try {
    const bands = pickValidationBands(meta.bands);
    const windows = pickValidationWindows(meta.samples, meta.lines);
    for (const band of bands) {
      for (const window of windows) {
        const expected = await readOracleBandWindow(meta, images, band, window.x0, window.y0, window.outW, window.outH);
        const actual = await readCandidateBandWindow(meta, ds, band, window.x0, window.y0, window.outW, window.outH);
        if (!bandWindowMatches(meta, actual, expected)) return false;
      }
    }
    return true;
  } catch (_err) {
    return false;
  }
}

function isUncompressedSingleStrip(summary) {
  const stripOffset = firstSafeOffsetOrNull(summary.stripOffsets);
  return summary.compression === 1
    && !summary.tileOffsets.length
    && Number(summary.rowsPerStrip) === Number(summary.height)
    && stripOffset != null
    && summary.stripByteCounts.length >= 1;
}

function createLinearSingleSource(summary, sampleType, file, deps) {
  if (!isRawCompatibleSummary(summary)) return null;
  if (!isUncompressedSingleStrip(summary)) return null;
  const bytesPerSample = sampleType.dataTypeInfo.bytes;
  const { width, height, samplesPerPixel, planarConfiguration } = summary;
  const base = new BlobDataSource(file);
  const cached = new ChunkCacheDataSource(base, {
    chunkSize: deps?.chunkSize ?? (1 << 20),
    maxBytes: deps?.cacheBytes ?? (128 * 1024 * 1024),
    concurrency: deps?.ioConcurrency ?? 2
  });
  const desc = String(file?.name || "TIFF");
  const stripOffset = firstSafeOffsetOrNull(summary.stripOffsets);
  if (stripOffset == null) return null;
  if (samplesPerPixel === 1) {
    const bandBytes = width * height * bytesPerSample;
    if (summary.stripByteCounts[0] < bandBytes) {
      throw new Error("TIFF strip is smaller than expected grayscale image payload.");
    }
    return {
      base,
      cached,
      meta: buildMeta({
        width,
        height,
        bands: 1,
        interleave: "bsq",
        littleEndian: true,
        dataType: sampleType.dataType,
        dataTypeInfo: sampleType.dataTypeInfo,
        headerOffset: stripOffset,
        description: desc
      })
    };
  }

  if (samplesPerPixel === 3 && planarConfiguration === 1) {
    const rasterBytes = width * height * samplesPerPixel * bytesPerSample;
    if (summary.stripByteCounts[0] < rasterBytes) {
      throw new Error("TIFF strip is smaller than expected color image payload.");
    }
    return {
      base,
      cached,
      meta: buildMeta({
        width,
        height,
        bands: 3,
        interleave: "bip",
        littleEndian: true,
        dataType: sampleType.dataType,
        dataTypeInfo: sampleType.dataTypeInfo,
        headerOffset: stripOffset,
        bandNames: ["Red", "Green", "Blue"],
        defaultBands: [0, 1, 2],
        defaultDisplayMode: "rgb",
        defaultAdjustColor: "red",
        description: desc
      })
    };
  }

  return null;
}

function buildBandOffsetSpecs(summary, sampleType) {
  if (!isRawCompatibleSummary(summary)) return null;
  if (!isUncompressedSingleStrip(summary)) return null;
  const bandBytes = summary.width * summary.height * sampleType.dataTypeInfo.bytes;
  if (summary.samplesPerPixel === 3 && summary.planarConfiguration === 2) {
    if (summary.stripOffsets.length < 3 || summary.stripByteCounts.length < 3) return null;
    const bandOffsets = [];
    for (let band = 0; band < 3; band += 1) {
      if (summary.stripByteCounts[band] < bandBytes) {
        throw new Error("TIFF planar strip is smaller than expected band payload.");
      }
      const bandOffset = firstSafeOffsetOrNull([summary.stripOffsets[band]]);
      if (bandOffset == null) return null;
      bandOffsets.push(bandOffset);
    }
    return bandOffsets;
  }
  return null;
}

class BandOffsetTiffDataSource {
  constructor(source, meta, bandOffsets) {
    this.source = source;
    this.meta = meta;
    this.bandOffsets = bandOffsets.map((value, index) => requireSafeOffset(value, `band offset ${index + 1}`));
  }

  get chunkSize() {
    return this.source?.chunkSize || 0;
  }

  get maxBytes() {
    return this.source?.maxBytes || 0;
  }

  get concurrency() {
    return this.source?.concurrency || 1;
  }

  get stats() {
    return this.source?.stats || createTiffStats();
  }

  setConcurrency(n) {
    if (this.source && typeof this.source.setConcurrency === "function") {
      this.source.setConcurrency(n);
    }
  }

  setMaxBytes(bytes) {
    if (this.source && typeof this.source.setMaxBytes === "function") {
      this.source.setMaxBytes(bytes);
    }
  }

  cacheBytes() {
    return this.source && typeof this.source.cacheBytes === "function"
      ? this.source.cacheBytes()
      : 0;
  }

  clear() {
    if (this.source && typeof this.source.clear === "function") this.source.clear();
  }

  async readBandWindow(meta, band, x0, y0, outW, outH, step, out = null) {
    const bandOffset = this.bandOffsets[band];
    if (!Number.isFinite(Number(bandOffset))) {
      throw new Error(`TIFF band ${Number(band) + 1} is unavailable.`);
    }
    const bandMeta = {
      ...meta,
      bands: 1,
      interleave: "bsq",
      headerOffset: bandOffset
    };
    return readBandWindowCore(bandMeta, this.source, 0, x0, y0, outW, outH, step, this.concurrency, out);
  }

  async readBandWindowBIP(meta, band, x0, y0, outW, outH, step, out = null) {
    return this.readBandWindow(meta, band, x0, y0, outW, outH, step, out);
  }

  async probeValueAtBand(meta, ix, iy, band) {
    const bytes = meta.dataTypeInfo.bytes;
    const bandOffset = this.bandOffsets[band];
    if (!Number.isFinite(Number(bandOffset))) return null;
    const offset = bandOffset + (((iy * meta.samples) + ix) * bytes);
    const scratch = new Uint8Array(bytes);
    await this.source.readInto(offset, scratch, 0, bytes);
    const seg = makeSegmentReader(meta, scratch);
    return Number(segGet(meta, seg, 0));
  }

  async readSpectrumAtPixel(meta, ix, iy) {
    const out = new Float32Array(this.bandOffsets.length);
    for (let band = 0; band < this.bandOffsets.length; band += 1) {
      out[band] = Number(await this.probeValueAtBand(meta, ix, iy, band));
    }
    return out;
  }

  close() {
    if (this.source && typeof this.source.close === "function") {
      this.source.close();
    }
    this.source = null;
  }
}

class LruByteCache {
  constructor(maxBytes = 0) {
    this.maxBytes = Math.max(0, Number(maxBytes) || 0);
    this.bytes = 0;
    this.map = new Map();
  }

  setMaxBytes(bytes) {
    this.maxBytes = Math.max(0, Number(bytes) || 0);
    return this.#evict();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value, bytes) {
    const size = Math.max(0, Number(bytes) || 0);
    if (this.map.has(key)) {
      const prev = this.map.get(key);
      this.map.delete(key);
      this.bytes -= prev.bytes;
    }
    if (this.maxBytes > 0) {
      this.map.set(key, { value, bytes: size });
      this.bytes += size;
      return this.#evict();
    }
    return [];
  }

  clear() {
    this.map.clear();
    this.bytes = 0;
  }

  #evict() {
    const evicted = [];
    while (this.maxBytes > 0 && this.bytes > this.maxBytes && this.map.size) {
      const oldestKey = this.map.keys().next().value;
      const entry = this.map.get(oldestKey);
      this.map.delete(oldestKey);
      this.bytes -= entry.bytes;
      evicted.push(entry.value);
    }
    if (this.maxBytes <= 0 && this.map.size) {
      for (const entry of this.map.values()) evicted.push(entry.value);
      this.clear();
    }
    return evicted;
  }
}

function buildBlockTable(summary, imageIndex = 0) {
  const isTiled = summary.tileOffsets.length > 0;
  const blockWidth = isTiled
    ? Math.max(1, firstFinite([summary.fileDirectory?.TileWidth], summary.width))
    : summary.width;
  const blockHeight = isTiled
    ? Math.max(1, firstFinite([summary.fileDirectory?.TileLength], summary.height))
    : Math.max(1, Math.min(summary.height, summary.rowsPerStrip || summary.height));
  const numBlocksX = Math.max(1, Math.ceil(summary.width / blockWidth));
  const numBlocksY = Math.max(1, Math.ceil(summary.height / blockHeight));
  const groups = summary.planarConfiguration === 2 ? summary.samplesPerPixel : 1;
  const offsets = isTiled ? summary.tileOffsets : summary.stripOffsets;
  const byteCounts = isTiled
    ? listTagValues(summary.fileDirectory?.TileByteCounts)
    : summary.stripByteCounts;
  const expected = numBlocksX * numBlocksY * groups;
  if (offsets.length < expected || byteCounts.length < expected) {
    throw new Error("TIFF is missing complete tile/strip offset metadata.");
  }

  const blocksByGroup = Array.from({ length: groups }, () => new Array(numBlocksX * numBlocksY));
  for (let group = 0; group < groups; group += 1) {
    for (let by = 0; by < numBlocksY; by += 1) {
      for (let bx = 0; bx < numBlocksX; bx += 1) {
        const localIndex = (by * numBlocksX) + bx;
        const index = (group * numBlocksX * numBlocksY) + localIndex;
        const offset = firstSafeOffsetOrNull([offsets[index]]);
        const byteCount = Number(byteCounts[index]);
        if (offset == null || !Number.isFinite(byteCount) || byteCount <= 0) {
          throw new Error("TIFF contains invalid tile/strip offsets.");
        }
        const x0 = bx * blockWidth;
        const y0 = by * blockHeight;
        blocksByGroup[group][localIndex] = {
          key: `img${imageIndex}:g${group}:b${localIndex}`,
          imageIndex,
          group,
          bx,
          by,
          x0,
          y0,
          w: Math.min(blockWidth, summary.width - x0),
          h: Math.min(blockHeight, summary.height - y0),
          offset,
          byteCount
        };
      }
    }
  }

  try { summary.image.tiles = null; } catch (_err) {}

  return {
    image: summary.image,
    summary,
    imageIndex,
    isTiled,
    blockWidth,
    blockHeight,
    numBlocksX,
    numBlocksY,
    blocksByGroup
  };
}

function buildRawBandSpecs(summary, sampleType, imageIndex = 0) {
  const table = buildBlockTable(summary, imageIndex);
  const bytesPerSample = sampleType.dataTypeInfo.bytes;
  const sampleCount = summary.samplesPerPixel;
  const specs = [];
  for (let band = 0; band < sampleCount; band += 1) {
    specs.push({
      kind: "raw",
      table,
      blocks: summary.planarConfiguration === 2 ? table.blocksByGroup[band] : table.blocksByGroup[0],
      sampleByteOffset: summary.planarConfiguration === 2 ? 0 : (band * bytesPerSample),
      bytesPerSample,
      bytesPerPixel: summary.planarConfiguration === 2 ? bytesPerSample : (sampleCount * bytesPerSample),
      channel: band
    });
  }
  return specs;
}

function buildRgbBandSpecs(summary, imageIndex = 0) {
  const table = buildBlockTable(summary, imageIndex);
  return [0, 1, 2].map((channel) => ({
    kind: "rgb",
    table,
    blocks: table.blocksByGroup[0],
    channel
  }));
}

function buildWindowBandSpecs(summary, imageIndex = 0) {
  const table = buildBlockTable(summary, imageIndex);
  return Array.from({ length: summary.samplesPerPixel }, (_v, band) => ({
    kind: "window",
    table,
    blocks: table.blocksByGroup[0],
    windowSampleIndex: band,
    channel: band
  }));
}

class TiffBlockIndexedDataSource {
  constructor({ file, tiff, meta, bandSpecs, budgets = {}, concurrency = 2 }) {
    this.file = file;
    this.tiff = tiff;
    this.meta = meta;
    this.bandSpecs = Array.isArray(bandSpecs) ? bandSpecs : [];
    this.ioConcurrency = clamp(Math.floor(Number(concurrency) || 2), 1, 8);
    this.base = new BlobDataSource(file);
    this.rawCache = new LruByteCache(Math.max(0, Number(budgets.rawCacheBytes) || 0));
    this.decodedCache = new LruByteCache(Math.max(0, Number(budgets.decodedCacheBytes) || 0));
    this.workerPoolSize = Math.max(0, Number(budgets.workerPoolSize) || 0);
    this.pool = null;
    this.stats = createTiffStats();
    this.closed = false;
  }

  get maxBytes() {
    return this.rawCache.maxBytes + this.decodedCache.maxBytes;
  }

  cacheBytes() {
    return this.rawCache.bytes + this.decodedCache.bytes;
  }

  setMaxBytes(bytes) {
    const total = Math.max(0, Number(bytes) || 0);
    const raw = Math.max(0, Math.floor(total * 0.25));
    this.rawCache.setMaxBytes(raw);
    this.decodedCache.setMaxBytes(Math.max(0, total - raw));
    this.#syncCacheStats();
  }

  setConcurrency(n) {
    this.ioConcurrency = clamp(Math.floor(Number(n) || this.ioConcurrency || 1), 1, 8);
    this.#resetPool();
  }

  clear() {
    this.rawCache.clear();
    this.decodedCache.clear();
    this.#syncCacheStats();
  }

  async readBandWindow(meta, band, x0, y0, outW, outH, step, out = null) {
    const target = allocateOutput(meta, out, outW * outH);
    const spec = this.bandSpecs[band];
    if (!spec) throw new Error(`TIFF band ${Number(band) + 1} is unavailable.`);
    const safeX0 = clamp(Math.floor(x0), 0, Math.max(0, meta.samples - 1));
    const safeY0 = clamp(Math.floor(y0), 0, Math.max(0, meta.lines - 1));
    const maxX = clamp(safeX0 + (outW * step), 0, meta.samples);
    const maxY = clamp(safeY0 + (outH * step), 0, meta.lines);
    const safeOutW = Math.floor((maxX - safeX0 + (step - 1)) / step);
    const safeOutH = Math.floor((maxY - safeY0 + (step - 1)) / step);
    if (safeOutW <= 0 || safeOutH <= 0) return target;

    const xLast = safeX0 + ((safeOutW - 1) * step);
    const yLast = safeY0 + ((safeOutH - 1) * step);
    const minBx = Math.max(0, Math.floor(safeX0 / spec.table.blockWidth));
    const maxBx = Math.min(spec.table.numBlocksX - 1, Math.floor(xLast / spec.table.blockWidth));
    const minBy = Math.max(0, Math.floor(safeY0 / spec.table.blockHeight));
    const maxBy = Math.min(spec.table.numBlocksY - 1, Math.floor(yLast / spec.table.blockHeight));

    const blocks = [];
    for (let by = minBy; by <= maxBy; by += 1) {
      for (let bx = minBx; bx <= maxBx; bx += 1) {
        const block = spec.blocks[(by * spec.table.numBlocksX) + bx];
        if (block) blocks.push(block);
      }
    }

    const t0 = perfNow();
    const decoded = await Promise.all(blocks.map((block) => this.#loadDecodedBlock(spec, block)));
    for (let i = 0; i < blocks.length; i += 1) {
      this.#compositeBlock(spec, blocks[i], decoded[i], target, safeX0, safeY0, safeOutW, safeOutH, outW, step);
    }
    this.stats.blockComposeCalls += 1;
    this.stats.blockComposeMs += perfNow() - t0;
    return target;
  }

  async readBandWindowBIP(meta, band, x0, y0, outW, outH, step, out = null) {
    return this.readBandWindow(meta, band, x0, y0, outW, outH, step, out);
  }

  async probeValueAtBand(meta, ix, iy, band) {
    if (ix < 0 || iy < 0 || ix >= meta.samples || iy >= meta.lines) return null;
    const spec = this.bandSpecs[band];
    if (!spec) return null;
    const block = spec.blocks[(Math.floor(iy / spec.table.blockHeight) * spec.table.numBlocksX) + Math.floor(ix / spec.table.blockWidth)];
    if (!block) return null;
    const decoded = await this.#loadDecodedBlock(spec, block);
    return this.#readBlockValue(spec, block, decoded, ix - block.x0, iy - block.y0);
  }

  async readSpectrumAtPixel(meta, ix, iy) {
    const out = new Float32Array(meta.bands);
    for (let band = 0; band < meta.bands; band += 1) {
      out[band] = Number(await this.probeValueAtBand(meta, ix, iy, band));
    }
    return out;
  }

  close() {
    this.closed = true;
    this.clear();
    if (this.base && typeof this.base.close === "function") {
      try { this.base.close(); } catch (_err) {}
    }
    this.base = null;
    this.#resetPool(true);
    if (this.tiff && typeof this.tiff.close === "function") {
      try { this.tiff.close(); } catch (_err) {}
    }
    this.tiff = null;
  }

  async #loadDecodedBlock(spec, block) {
    if (spec.kind === "raw") return this.#loadRawDecodedBlock(spec, block);
    if (spec.kind === "rgb") return this.#loadRgbDecodedBlock(spec, block);
    return this.#loadWindowDecodedBlock(spec, block);
  }

  async #loadRawDecodedBlock(spec, block) {
    const cacheKey = `decoded:${block.key}:raw`;
    const hit = this.decodedCache.get(cacheKey);
    if (hit) {
      this.stats.decodedCacheHits += 1;
      this.#syncCacheStats();
      return hit;
    }
    this.stats.decodedCacheMisses += 1;
    const raw = await this.#loadRawBlock(block);
    const buffer = raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength
      ? raw.buffer.slice(0)
      : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    const t0 = perfNow();
    const decodedBuffer = await this.#getPool().decode(spec.table.summary.fileDirectory, buffer);
    this.stats.decodeCalls += 1;
    this.stats.decodeMs += perfNow() - t0;
    const decoded = {
      kind: "raw",
      buffer: decodedBuffer,
      view: new DataView(decodedBuffer),
      storageWidth: spec.table.blockWidth,
      bytes: decodedBuffer.byteLength
    };
    this.decodedCache.set(cacheKey, decoded, decoded.bytes);
    this.#syncCacheStats();
    return decoded;
  }

  async #loadRgbDecodedBlock(spec, block) {
    const cacheKey = `decoded:${block.key}:rgb`;
    const hit = this.decodedCache.get(cacheKey);
    if (hit) {
      this.stats.decodedCacheHits += 1;
      this.#syncCacheStats();
      return hit;
    }
    this.stats.decodedCacheMisses += 1;
    const t0 = perfNow();
    const rgb = await spec.table.image.readRGB({
      window: [block.x0, block.y0, block.x0 + block.w, block.y0 + block.h],
      interleave: true,
      width: block.w,
      height: block.h,
      resampleMethod: "nearest",
      pool: this.#getPool()
    });
    this.stats.decodeCalls += 1;
    this.stats.decodeMs += perfNow() - t0;
    const data = rgb instanceof Uint8Array ? rgb : Uint8Array.from(rgb);
    const decoded = {
      kind: "rgb",
      data,
      storageWidth: block.w,
      bytes: data.byteLength
    };
    this.decodedCache.set(cacheKey, decoded, decoded.bytes);
    this.#syncCacheStats();
    return decoded;
  }

  async #loadWindowDecodedBlock(spec, block) {
    const cacheKey = `decoded:${block.key}:window:${spec.windowSampleIndex}`;
    const hit = this.decodedCache.get(cacheKey);
    if (hit) {
      this.stats.decodedCacheHits += 1;
      this.#syncCacheStats();
      return hit;
    }
    this.stats.decodedCacheMisses += 1;
    const t0 = perfNow();
    const raw = await spec.table.image.readRasters({
      window: [block.x0, block.y0, block.x0 + block.w, block.y0 + block.h],
      samples: [spec.windowSampleIndex],
      interleave: true,
      width: block.w,
      height: block.h,
      resampleMethod: "nearest",
      fillValue: 0,
      pool: this.#getPool()
    });
    this.stats.decodeCalls += 1;
    this.stats.decodeMs += perfNow() - t0;
    const decoded = {
      kind: "sample",
      data: raw,
      storageWidth: block.w,
      bytes: raw.byteLength
    };
    this.decodedCache.set(cacheKey, decoded, decoded.bytes);
    this.#syncCacheStats();
    return decoded;
  }

  async #loadRawBlock(block) {
    const cacheKey = `raw:${block.key}`;
    const hit = this.rawCache.get(cacheKey);
    if (hit) {
      this.stats.rawCacheHits += 1;
      this.stats.readCalls += 1;
      this.#syncCacheStats();
      return hit;
    }
    this.stats.rawCacheMisses += 1;
    this.stats.readCalls += 1;
    const raw = await this.base.read(block.offset, block.byteCount);
    this.stats.bytesRead += raw.byteLength;
    this.rawCache.set(cacheKey, raw, raw.byteLength);
    this.#syncCacheStats();
    return raw;
  }

  #compositeBlock(spec, block, decoded, target, x0, y0, safeOutW, safeOutH, outW, step) {
    const colStart = Math.max(0, Math.ceil((block.x0 - x0) / step));
    const colEnd = Math.min(safeOutW, Math.floor((block.x0 + block.w - 1 - x0) / step) + 1);
    const rowStart = Math.max(0, Math.ceil((block.y0 - y0) / step));
    const rowEnd = Math.min(safeOutH, Math.floor((block.y0 + block.h - 1 - y0) / step) + 1);
    for (let row = rowStart; row < rowEnd; row += 1) {
      const srcY = y0 + (row * step);
      const localY = srcY - block.y0;
      const baseOut = row * outW;
      for (let col = colStart; col < colEnd; col += 1) {
        const srcX = x0 + (col * step);
        target[baseOut + col] = this.#readBlockValue(spec, block, decoded, srcX - block.x0, localY);
      }
    }
  }

  #readBlockValue(spec, _block, decoded, localX, localY) {
    if (decoded.kind === "rgb") {
      return decoded.data[((localY * decoded.storageWidth) + localX) * 3 + spec.channel];
    }
    if (decoded.kind === "sample") {
      return decoded.data[(localY * decoded.storageWidth) + localX];
    }
    const byteOffset = (((localY * decoded.storageWidth) + localX) * spec.bytesPerPixel) + spec.sampleByteOffset;
    return readDataViewValue(decoded.view, byteOffset, this.meta.dataTypeInfo, this.meta.littleEndian);
  }

  #getPool() {
    if (!this.pool) {
      const size = (typeof Worker !== "undefined") ? this.workerPoolSize : 0;
      this.pool = new Pool(size);
    }
    return this.pool;
  }

  #resetPool(force = false) {
    if (this.pool) {
      try { this.pool.destroy(); } catch (_err) {}
      this.pool = null;
    } else if (!force) {
      return;
    }
  }

  #syncCacheStats() {
    this.stats.rawCacheBytes = this.rawCache.bytes;
    this.stats.decodedCacheBytes = this.decodedCache.bytes;
    this.stats.cacheBytes = this.cacheBytes();
  }
}

async function parallelFor(count, limit, fn) {
  const n = Math.min(Math.max(1, limit | 0), count | 0);
  let next = 0;
  const workers = [];
  for (let i = 0; i < n; i += 1) {
    workers.push((async () => {
      while (true) {
        const index = next++;
        if (index >= count) break;
        await fn(index);
      }
    })());
  }
  await Promise.all(workers);
}

function allocateOutput(meta, out, length) {
  if (out && typeof out.length === "number" && out.length >= length) return out;
  const Ctor = meta?.dataTypeInfo?.ctor || Float64Array;
  return new Ctor(length);
}

class TiffWindowDataSource {
  constructor({ tiff, images, meta, concurrency = 2 }) {
    this.tiff = tiff;
    this.images = images;
    this.meta = meta;
    this.ioConcurrency = clamp(Math.floor(Number(concurrency) || 2), 1, 8);
    this.stats = createTiffStats();
    this.closed = false;
  }

  get maxBytes() {
    return 0;
  }

  cacheBytes() {
    return 0;
  }

  setMaxBytes(_bytes) {}

  setConcurrency(n) {
    this.ioConcurrency = clamp(Math.floor(Number(n) || this.ioConcurrency || 1), 1, 8);
  }

  async #readWindowFromImage(imageIndex, sampleIndex, x0, y0, outW, outH, step, out = null) {
    if (this.closed) throw new Error("Data source closed");
    const image = this.images[imageIndex];
    if (!image) throw new Error(`TIFF image ${imageIndex + 1} is unavailable.`);
    this.stats.readCalls += 1;
    const width = Number(image.getWidth()) || 0;
    const height = Number(image.getHeight()) || 0;
    const safeX0 = clamp(Math.floor(x0), 0, Math.max(0, width - 1));
    const safeY0 = clamp(Math.floor(y0), 0, Math.max(0, height - 1));
    const maxX = clamp(safeX0 + (outW * step), 0, width);
    const maxY = clamp(safeY0 + (outH * step), 0, height);
    const safeOutW = Math.floor((maxX - safeX0 + (step - 1)) / step);
    const safeOutH = Math.floor((maxY - safeY0 + (step - 1)) / step);
    const target = allocateOutput(this.meta, out, outW * outH);
    if (safeOutW <= 0 || safeOutH <= 0) return target;

    const direct = (safeOutW === outW && safeOutH === outH)
      ? target
      : allocateOutput(this.meta, null, safeOutW * safeOutH);

    const raw = await image.readRasters({
      window: [safeX0, safeY0, maxX, maxY],
      samples: [sampleIndex],
      interleave: true,
      width: safeOutW,
      height: safeOutH,
      resampleMethod: "nearest",
      fillValue: 0
    });

    if (raw !== direct) direct.set(raw, 0);
    if (direct === target) return target;

    for (let row = 0; row < safeOutH; row += 1) {
      const srcStart = row * safeOutW;
      const dstStart = row * outW;
      target.set(direct.subarray(srcStart, srcStart + safeOutW), dstStart);
    }
    return target;
  }

  async readBandWindow(meta, band, x0, y0, outW, outH, step, out = null) {
    if (Number(meta.bands) === 1) {
      return this.#readWindowFromImage(0, 0, x0, y0, outW, outH, step, out);
    }
    if (this.images.length === 1) {
      return this.#readWindowFromImage(0, band, x0, y0, outW, outH, step, out);
    }
    return this.#readWindowFromImage(band, 0, x0, y0, outW, outH, step, out);
  }

  async readBandWindowBIP(meta, band, x0, y0, outW, outH, step, out = null) {
    return this.readBandWindow(meta, band, x0, y0, outW, outH, step, out);
  }

  async probeValueAtBand(meta, ix, iy, band) {
    const out = await this.readBandWindow(meta, band, ix, iy, 1, 1, 1);
    return Number(out[0]);
  }

  async readSpectrumAtPixel(meta, ix, iy) {
    const out = new Float32Array(meta.bands);
    if (this.images.length === 1) {
      this.stats.readCalls += 1;
      const raw = await this.images[0].readRasters({
        window: [ix, iy, ix + 1, iy + 1],
        samples: Array.from({ length: meta.bands }, (_v, band) => band),
        interleave: true,
        width: 1,
        height: 1,
        fillValue: 0
      });
      out.set(raw, 0);
      return out;
    }
    await parallelFor(meta.bands, this.ioConcurrency, async (band) => {
      const value = await this.#readWindowFromImage(band, 0, ix, iy, 1, 1, 1);
      out[band] = Number(value[0]);
    });
    return out;
  }

  close() {
    this.closed = true;
    this.images = [];
    if (this.tiff && typeof this.tiff.close === "function") {
      try { this.tiff.close(); } catch (_err) {}
    }
    this.tiff = null;
  }
}

class TiffRgbDataSource {
  constructor({ tiff, image, meta, concurrency = 2 }) {
    this.tiff = tiff;
    this.image = image;
    this.meta = meta;
    this.ioConcurrency = clamp(Math.floor(Number(concurrency) || 2), 1, 8);
    this.stats = createTiffStats();
    this.closed = false;
  }

  get maxBytes() {
    return 0;
  }

  cacheBytes() {
    return 0;
  }

  setMaxBytes(_bytes) {}

  setConcurrency(n) {
    this.ioConcurrency = clamp(Math.floor(Number(n) || this.ioConcurrency || 1), 1, 8);
  }

  async #readRgbWindow(x0, y0, outW, outH, step) {
    if (this.closed) throw new Error("Data source closed");
    const width = Number(this.image?.getWidth()) || 0;
    const height = Number(this.image?.getHeight()) || 0;
    const safeX0 = clamp(Math.floor(x0), 0, Math.max(0, width - 1));
    const safeY0 = clamp(Math.floor(y0), 0, Math.max(0, height - 1));
    const maxX = clamp(safeX0 + (outW * step), 0, width);
    const maxY = clamp(safeY0 + (outH * step), 0, height);
    const safeOutW = Math.floor((maxX - safeX0 + (step - 1)) / step);
    const safeOutH = Math.floor((maxY - safeY0 + (step - 1)) / step);
    if (safeOutW <= 0 || safeOutH <= 0) {
      return { rgb: new Uint8Array(0), safeOutW: 0, safeOutH: 0 };
    }
    this.stats.readCalls += 1;
    const rgb = await this.image.readRGB({
      window: [safeX0, safeY0, maxX, maxY],
      interleave: true,
      width: safeOutW,
      height: safeOutH,
      resampleMethod: "nearest"
    });
    return { rgb, safeOutW, safeOutH };
  }

  async readBandWindow(_meta, band, x0, y0, outW, outH, step, out = null) {
    const target = allocateOutput(this.meta, out, outW * outH);
    const { rgb, safeOutW, safeOutH } = await this.#readRgbWindow(x0, y0, outW, outH, step);
    if (safeOutW <= 0 || safeOutH <= 0) return target;
    const channel = Math.max(0, Math.min(2, Math.trunc(Number(band) || 0)));
    for (let row = 0; row < safeOutH; row += 1) {
      const rowBase = row * outW;
      const rgbBase = row * safeOutW * 3;
      for (let col = 0; col < safeOutW; col += 1) {
        target[rowBase + col] = rgb[rgbBase + (col * 3) + channel];
      }
    }
    return target;
  }

  async readBandWindowBIP(meta, band, x0, y0, outW, outH, step, out = null) {
    return this.readBandWindow(meta, band, x0, y0, outW, outH, step, out);
  }

  async probeValueAtBand(meta, ix, iy, band) {
    const out = await this.readBandWindow(meta, band, ix, iy, 1, 1, 1);
    return Number(out[0]);
  }

  async readSpectrumAtPixel(_meta, ix, iy) {
    const out = new Float32Array(3);
    const { rgb } = await this.#readRgbWindow(ix, iy, 1, 1, 1);
    if (rgb.length >= 3) {
      out[0] = Number(rgb[0]);
      out[1] = Number(rgb[1]);
      out[2] = Number(rgb[2]);
    }
    return out;
  }

  close() {
    this.closed = true;
    this.image = null;
    if (this.tiff && typeof this.tiff.close === "function") {
      try { this.tiff.close(); } catch (_err) {}
    }
    this.tiff = null;
  }
}

async function describeTiffDataset(tiff, file, deps = {}) {
  const imageCount = await tiff.getImageCount();
  if (imageCount < 1) {
    throw new Error("TIFF has no readable image directories.");
  }
  const images = [];
  for (let index = 0; index < imageCount; index += 1) {
    images.push(summarizeImage(await tiff.getImage(index)));
  }

  const first = images[0];
  const sampleType = resolveUniformSampleType(first, "TIFF image");
  const desc = String(file?.name || "TIFF");
  const budgets = resolveTiffCacheBudgets(deps);
  const raw = {
    format: "tiff",
    imageCount,
    bigTiff: !!tiff.bigTiff,
    photometricInterpretation: first.photometricInterpretation
  };

  if (imageCount === 1) {
    if (first.samplesPerPixel !== 1 && first.samplesPerPixel !== 3) {
      throw new Error("Only grayscale TIFF or 3-band TIFF images are supported.");
    }
    if (isHugeCompressedSingleStrip(first, sampleType, file)) {
      throw new Error("Single huge compressed-strip TIFF is not supported. Re-save it as tiled/striped TIFF or uncompressed TIFF for fast access.");
    }
    let preferWindowBlocks = false;

    if (needsRgbWindowSource(first)) {
      const meta = buildRgbDisplayMeta(
        first,
        `${desc} (${photometricName(first.photometricInterpretation)} converted to RGB)`
      );
      return {
        raw,
        meta,
        mode: "block-indexed",
        base: null,
        cached: new TiffBlockIndexedDataSource({
          file,
          tiff,
          meta,
          bandSpecs: buildRgbBandSpecs(first, 0),
          budgets,
          concurrency: deps?.ioConcurrency ?? 2
        })
      };
    }

    const linear = createLinearSingleSource(first, sampleType, file, deps);
    if (linear) {
      linear.meta.littleEndian = !!tiff.littleEndian;
      if (await validateRawCandidate(linear.meta, linear.cached, images)) {
        return { raw, meta: linear.meta, mode: "linear", base: linear.base, cached: linear.cached };
      }
      linear.cached.close();
      preferWindowBlocks = true;
    }

    const bandOffsets = buildBandOffsetSpecs(first, sampleType);
    if (bandOffsets) {
      const base = new BlobDataSource(file);
      const cached = new ChunkCacheDataSource(base, {
        chunkSize: deps?.chunkSize ?? (1 << 20),
        maxBytes: deps?.cacheBytes ?? (128 * 1024 * 1024),
        concurrency: deps?.ioConcurrency ?? 2
      });
      const meta = buildMeta({
        width: first.width,
        height: first.height,
        bands: 3,
        interleave: "bsq",
        littleEndian: !!tiff.littleEndian,
        dataType: sampleType.dataType,
        dataTypeInfo: sampleType.dataTypeInfo,
        bandNames: ["Red", "Green", "Blue"],
        defaultBands: [0, 1, 2],
        defaultDisplayMode: "rgb",
        defaultAdjustColor: "red",
        description: desc
      });
      const source = new BandOffsetTiffDataSource(cached, meta, bandOffsets);
      if (await validateRawCandidate(meta, source, images)) {
        return {
          raw,
          meta,
          mode: "band-offset",
          base: null,
          cached: source
        };
      }
      source.close();
      preferWindowBlocks = true;
    }

    const meta = buildMeta({
      width: first.width,
      height: first.height,
      bands: first.samplesPerPixel,
      interleave: first.planarConfiguration === 1 ? "bip" : "bsq",
      littleEndian: !!tiff.littleEndian,
      dataType: sampleType.dataType,
      dataTypeInfo: sampleType.dataTypeInfo,
      bandNames: first.samplesPerPixel === 3 ? ["Red", "Green", "Blue"] : null,
      defaultBands: first.samplesPerPixel === 3 ? [0, 1, 2] : null,
      defaultDisplayMode: first.samplesPerPixel === 3 ? "rgb" : null,
      defaultAdjustColor: first.samplesPerPixel === 3 ? "red" : null,
      description: desc
    });
    return {
      raw,
      meta,
      mode: "block-indexed",
      base: null,
      cached: new TiffBlockIndexedDataSource({
        file,
        tiff,
        meta,
        bandSpecs: preferWindowBlocks ? buildWindowBandSpecs(first, 0) : buildRawBandSpecs(first, sampleType, 0),
        budgets,
        concurrency: deps?.ioConcurrency ?? 2
      })
    };
  }

  for (let index = 0; index < images.length; index += 1) {
    const summary = images[index];
    if (summary.width !== first.width || summary.height !== first.height) {
      throw new Error("Multi-page TIFF pages must share the same dimensions.");
    }
    if (summary.samplesPerPixel !== 1) {
      throw new Error("Multi-page TIFF support is currently limited to grayscale pages.");
    }
    if (isHugeCompressedSingleStrip(summary, sampleType, file)) {
      throw new Error("Single huge compressed-strip TIFF page is not supported. Re-save it as tiled/striped TIFF or uncompressed TIFF for fast access.");
    }
    if (!isRawCompatibleGrayscale(summary)) {
      throw new Error(`Multi-page TIFF page ${index + 1} uses unsupported ${photometricName(summary.photometricInterpretation)} photometric data.`);
    }
    const pageType = resolveUniformSampleType(summary, `TIFF page ${index + 1}`);
    if (pageType.dataType !== sampleType.dataType) {
      throw new Error("Multi-page TIFF pages must share the same sample type.");
    }
  }

  const bandBytes = first.width * first.height * sampleType.dataTypeInfo.bytes;
  let preferWindowBlocks = false;
  const simplePages = images.map((summary) => {
    if (!isUncompressedSingleStrip(summary) || summary.samplesPerPixel !== 1) return null;
    if (summary.stripByteCounts[0] < bandBytes) {
      throw new Error("TIFF page strip is smaller than expected band payload.");
    }
    return firstSafeOffsetOrNull(summary.stripOffsets);
  });

  if (simplePages.every((offset) => Number.isFinite(Number(offset)))) {
    const base = new BlobDataSource(file);
    const cached = new ChunkCacheDataSource(base, {
      chunkSize: deps?.chunkSize ?? (1 << 20),
      maxBytes: deps?.cacheBytes ?? (128 * 1024 * 1024),
      concurrency: deps?.ioConcurrency ?? 2
    });
    const contiguous = simplePages.every((offset, index) => offset === (simplePages[0] + (index * bandBytes)));
    const meta = buildMeta({
      width: first.width,
      height: first.height,
      bands: images.length,
      interleave: "bsq",
      littleEndian: !!tiff.littleEndian,
      dataType: sampleType.dataType,
      dataTypeInfo: sampleType.dataTypeInfo,
      description: desc
    });
    if (contiguous) {
      meta.headerOffset = simplePages[0];
      if (await validateRawCandidate(meta, cached, images)) {
        return { raw, meta, mode: "linear", base, cached };
      }
      cached.close();
      preferWindowBlocks = true;
    } else {
      const source = new BandOffsetTiffDataSource(cached, meta, simplePages);
      if (await validateRawCandidate(meta, source, images)) {
        return {
          raw,
          meta,
          mode: "band-offset",
          base: null,
          cached: source
        };
      }
      source.close();
      preferWindowBlocks = true;
    }
  }

  const meta = buildMeta({
    width: first.width,
    height: first.height,
    bands: images.length,
    interleave: "bsq",
    littleEndian: !!tiff.littleEndian,
    dataType: sampleType.dataType,
    dataTypeInfo: sampleType.dataTypeInfo,
    description: desc
  });
  return {
    raw,
    meta,
    mode: "block-indexed",
    base: null,
    cached: new TiffBlockIndexedDataSource({
      file,
      tiff,
      meta,
      bandSpecs: preferWindowBlocks
        ? images.flatMap((summary, index) => buildWindowBandSpecs(summary, index))
        : images.flatMap((summary, index) => buildRawBandSpecs(summary, sampleType, index)),
      budgets,
      concurrency: deps?.ioConcurrency ?? 2
    })
  };
}

export function isTiffFile(fileLike) {
  return TIFF_EXT_RE.test(String(fileLike?.name || ""));
}

export async function addDatasetFromFile(file, deps = {}) {
  if (!isTiffFile(file)) {
    throw new Error(`Unsupported TIFF file: ${String(file?.name || "")}`);
  }
  deps?.setStatus?.("opening TIFF…", "warn");
  const tiff = await fromBlob(file);
  const desc = await describeTiffDataset(tiff, file, deps);

  if (desc.mode === "linear" && desc.cached && desc.base) {
    desc.cached.setConcurrency(deps?.ioConcurrency ?? desc.cached.concurrency ?? 2);
    desc.cached.setMaxBytes(deps?.cacheBytes ?? desc.cached.maxBytes ?? (128 * 1024 * 1024));
  } else if (desc.cached && typeof desc.cached.setConcurrency === "function") {
    desc.cached.setConcurrency(deps?.ioConcurrency ?? 2);
    if (typeof desc.cached.setMaxBytes === "function") {
      desc.cached.setMaxBytes(deps?.cacheBytes ?? (128 * 1024 * 1024));
    }
  }

  if (desc.mode !== "windowed" && tiff && typeof tiff.close === "function") {
    try { tiff.close(); } catch (_err) {}
  }

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
