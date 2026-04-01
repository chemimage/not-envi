import {
  readBandWindow as readBandWindowCore,
  readBandWindowBIP as readBandWindowBIPCore
} from "../../core/raster-io.js";
import { DATA_TYPES } from "../../core/envi-types.js";
import { APP_CONFIG } from "../../app/config.js";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const TIFF_EXT_RE = /\.(tif|tiff)$/i;
export const TIFF_PHOTOMETRIC_WHITE_IS_ZERO = 0;
export const TIFF_PHOTOMETRIC_BLACK_IS_ZERO = 1;
export const TIFF_PHOTOMETRIC_RGB = 2;
export const RGB_U8_TYPE = 1;
export const RGB_U8_INFO = DATA_TYPES.get(RGB_U8_TYPE);

export const perfNow = () => (
  (typeof performance !== "undefined" && typeof performance.now === "function")
    ? performance.now()
    : Date.now()
);

export function yieldToEventLoop() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export function createTiffStats() {
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

export function listTagValues(value) {
  if (Array.isArray(value)) return value.map((entry) => Number(entry));
  if (ArrayBuffer.isView(value)) return Array.from(value, (entry) => Number(entry));
  if (value == null) return [];
  return [Number(value)];
}

export function firstFinite(values, fallback = 0) {
  for (const value of values) {
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

export function firstSafeOffsetOrNull(values) {
  for (const value of values) {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) continue;
    const whole = Math.trunc(num);
    if (!Number.isSafeInteger(whole)) continue;
    return whole;
  }
  return null;
}

export function requireSafeOffset(value, label) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || !Number.isSafeInteger(Math.trunc(num))) {
    throw new Error(`Unsupported TIFF ${label}: ${String(value)}`);
  }
  return Math.trunc(num);
}

export function sampleFormatToEnviType(sampleFormat, bitsPerSample) {
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

export function summarizeImage(image) {
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
  const photometricInterpretation = firstFinite(
    [fileDirectory?.PhotometricInterpretation],
    samplesPerPixel === 3 ? TIFF_PHOTOMETRIC_RGB : TIFF_PHOTOMETRIC_BLACK_IS_ZERO
  );
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

export function resolveUniformSampleType(summary, label = "TIFF image") {
  const bits = summary.bitsPerSample[0];
  const format = summary.sampleFormats[0];
  for (let i = 1; i < summary.samplesPerPixel; i += 1) {
    if (
      Number(summary.bitsPerSample[i]) !== Number(bits)
      || Number(summary.sampleFormats[i]) !== Number(format)
    ) {
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

export function buildMeta({
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

export function photometricName(code) {
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

export function isRawCompatibleGrayscale(summary) {
  return summary.samplesPerPixel === 1
    && (
      Number(summary.photometricInterpretation) === TIFF_PHOTOMETRIC_WHITE_IS_ZERO
      || Number(summary.photometricInterpretation) === TIFF_PHOTOMETRIC_BLACK_IS_ZERO
    );
}

export function isRawCompatibleRgb(summary) {
  return summary.samplesPerPixel === 3
    && Number(summary.photometricInterpretation) === TIFF_PHOTOMETRIC_RGB;
}

export function isRawCompatibleSummary(summary) {
  return isRawCompatibleGrayscale(summary) || isRawCompatibleRgb(summary);
}

export function needsRgbWindowSource(summary) {
  return summary.samplesPerPixel >= 1 && !isRawCompatibleSummary(summary);
}

export function buildRgbDisplayMeta(summary, description) {
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

export function resolveTiffCacheBudgets(deps = {}) {
  const isIpad = isIpadLike();
  const defaultRaw = isIpad ? APP_CONFIG.tiff.ipadRawCacheBytes : APP_CONFIG.tiff.desktopRawCacheBytes;
  const defaultDecoded = isIpad ? APP_CONFIG.tiff.ipadDecodedCacheBytes : APP_CONFIG.tiff.desktopDecodedCacheBytes;
  const defaultTotal = defaultRaw + defaultDecoded;
  const totalHint = Number(deps?.cacheBytes);
  if (Number.isFinite(totalHint) && totalHint > 0) {
    const total = Math.min(totalHint, defaultTotal);
    const raw = Math.max(
      APP_CONFIG.tiff.budgetMinBytes,
      Math.floor(total * APP_CONFIG.tiff.budgetRawFraction)
    );
    return {
      rawCacheBytes: Math.min(raw, total),
      decodedCacheBytes: Math.max(APP_CONFIG.tiff.budgetMinBytes, total - Math.min(raw, total)),
      workerPoolSize: Math.max(
        0,
        Math.min(
          Number(deps?.ioConcurrency) || APP_CONFIG.io.defaultConcurrency,
          isIpad ? APP_CONFIG.tiff.ipadWorkerPoolMax : APP_CONFIG.tiff.desktopWorkerPoolMax
        )
      )
    };
  }
  return {
    rawCacheBytes: defaultRaw,
    decodedCacheBytes: defaultDecoded,
    workerPoolSize: Math.max(
      0,
      Math.min(
        Number(deps?.ioConcurrency) || APP_CONFIG.io.defaultConcurrency,
        isIpad ? APP_CONFIG.tiff.ipadWorkerPoolMax : APP_CONFIG.tiff.desktopWorkerPoolMax
      )
    )
  };
}

function isSingleStrip(summary) {
  return !summary.tileOffsets.length
    && Number(summary.rowsPerStrip) >= Number(summary.height)
    && summary.stripOffsets.length === 1
    && summary.stripByteCounts.length === 1;
}

export function estimateSummaryUncompressedBytes(summary, sampleType) {
  return Number(summary?.width || 0)
    * Number(summary?.height || 0)
    * Number(summary?.samplesPerPixel || 0)
    * Number(sampleType?.dataTypeInfo?.bytes || 0);
}

export function isHugeCompressedSingleStrip(summary, sampleType, file = null) {
  if (Number(summary.compression) === 1) return false;
  if (!isSingleStrip(summary)) return false;
  const uncompressedBytes = estimateSummaryUncompressedBytes(summary, sampleType);
  return uncompressedBytes >= APP_CONFIG.tiff.hugeCompressedStripUncompressedBytes
    || Number(file?.size || 0) >= APP_CONFIG.tiff.hugeCompressedStripFileBytes;
}

export function shouldValidateRawCandidate(summary, sampleType, file = null, pageCount = 1) {
  if (Number(file?.size || 0) > APP_CONFIG.tiff.rawValidationMaxFileBytes) return false;
  const totalUncompressedBytes = estimateSummaryUncompressedBytes(summary, sampleType)
    * Math.max(1, Number(pageCount) || 1);
  return totalUncompressedBytes <= APP_CONFIG.tiff.rawValidationMaxUncompressedBytes;
}

function isMissingImageIndexError(err, index) {
  return String(err?.message || err || "").includes(`No image at index ${Number(index)}`);
}

export async function loadImageSummaries(tiff, deps = {}) {
  const images = [];
  for (let index = 0; ; index += 1) {
    try {
      images.push(summarizeImage(await tiff.getImage(index)));
      if ((index + 1) % APP_CONFIG.tiff.indexScanYieldEvery === 0) {
        deps?.setStatus?.(`indexing TIFF… (${index + 1} pages)`, "warn");
        await yieldToEventLoop();
      }
    } catch (err) {
      if (!images.length) throw err;
      if (isMissingImageIndexError(err, index)) break;
      throw err;
    }
  }
  if (!images.length) throw new Error("TIFF has no readable image directories.");
  return images;
}

export function readDataViewValue(dv, byteOffset, info, littleEndian) {
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

export async function validateRawCandidate(meta, ds, images) {
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

export function isUncompressedSingleStrip(summary) {
  const stripOffset = firstSafeOffsetOrNull(summary.stripOffsets);
  return summary.compression === 1
    && !summary.tileOffsets.length
    && Number(summary.rowsPerStrip) === Number(summary.height)
    && stripOffset != null
    && summary.stripByteCounts.length >= 1;
}
