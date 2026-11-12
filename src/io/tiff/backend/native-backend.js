import { buildMeta, buildRgbDisplayMeta, isRawCompatibleSummary, listTagValues, photometricName, resolveTiffCacheBudgets, resolveUniformSampleType, summarizeImage, supportsNativeJpegTileDecode } from "../shared.js";
import { buildTiffImageCatalog } from "../metadata-index.js";
import { TiffBlockIndexedDataSource, buildRawBandSpecs, buildRgbBandSpecs } from "../data-sources.js";
import { openGeotiffFallback } from "./geotiff-fallback.js";

const TAG_NAMES = new Map([
  [254, "NewSubfileType"],
  [256, "ImageWidth"],
  [257, "ImageLength"],
  [258, "BitsPerSample"],
  [259, "Compression"],
  [262, "PhotometricInterpretation"],
  [270, "ImageDescription"],
  [273, "StripOffsets"],
  [277, "SamplesPerPixel"],
  [278, "RowsPerStrip"],
  [279, "StripByteCounts"],
  [284, "PlanarConfiguration"],
  [285, "PageName"],
  [297, "PageNumber"],
  [317, "Predictor"],
  [322, "TileWidth"],
  [323, "TileLength"],
  [324, "TileOffsets"],
  [325, "TileByteCounts"],
  [330, "SubIFDs"],
  [339, "SampleFormat"]
]);

const TYPE_SIZES = new Map([
  [1, 1],
  [2, 1],
  [3, 2],
  [4, 4],
  [5, 8],
  [6, 1],
  [7, 1],
  [8, 2],
  [9, 4],
  [10, 8],
  [11, 4],
  [12, 8],
  [16, 8],
  [17, 8],
  [18, 8]
]);

const TIFF_MAGIC = 42;
const BIGTIFF_MAGIC = 43;
const DEFAULT_MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_SAMPLES_PER_PIXEL = 4096;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function canNativeDecodeJpeg() {
  return typeof createImageBitmap === "function";
}

function scalarOrArray(values) {
  if (!Array.isArray(values)) return values;
  return values.length === 1 ? values[0] : values;
}

function ensureSafeInt(value, label) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || !Number.isSafeInteger(Math.trunc(num))) {
    throw new Error(`Unsupported TIFF ${label}: ${String(value)}`);
  }
  return Math.trunc(num);
}

function metadataLimitError(message) {
  const error = new Error(message);
  error.code = "TIFF_METADATA_LIMIT";
  error.tiffNoFallback = true;
  return error;
}

function ensureMetadataSafeInt(value, label) {
  try {
    return ensureSafeInt(value, label);
  } catch (_error) {
    throw metadataLimitError(`Unsupported TIFF ${label}: ${String(value)}`);
  }
}

function checkedAdd(a, b, label) {
  const total = ensureMetadataSafeInt(a, label) + ensureMetadataSafeInt(b, label);
  if (!Number.isSafeInteger(total)) throw metadataLimitError(`Unsupported TIFF ${label}: exceeds the exact integer range.`);
  return total;
}

function checkedMultiply(a, b, label) {
  const total = ensureMetadataSafeInt(a, label) * ensureMetadataSafeInt(b, label);
  if (!Number.isSafeInteger(total)) throw metadataLimitError(`Unsupported TIFF ${label}: exceeds the exact integer range.`);
  return total;
}

function reserveMetadata(budget, bytes, label) {
  const count = ensureMetadataSafeInt(bytes, label);
  if (budget.used + count > budget.limit) {
    throw metadataLimitError(`TIFF metadata exceeds the ${budget.limit}-byte parsing limit while reading ${label}.`);
  }
  budget.used += count;
}

function readUnsigned(dv, offset, bytes, littleEndian) {
  if (bytes === 2) return dv.getUint16(offset, littleEndian);
  if (bytes === 4) return dv.getUint32(offset, littleEndian);
  if (bytes === 8) return Number(dv.getBigUint64(offset, littleEndian));
  throw new Error(`Unsupported TIFF unsigned integer width: ${bytes}`);
}

function readSigned(dv, offset, bytes, littleEndian) {
  if (bytes === 2) return dv.getInt16(offset, littleEndian);
  if (bytes === 4) return dv.getInt32(offset, littleEndian);
  if (bytes === 8) return Number(dv.getBigInt64(offset, littleEndian));
  throw new Error(`Unsupported TIFF signed integer width: ${bytes}`);
}

function decodeAscii(bytes) {
  const chars = [];
  for (let index = 0; index < bytes.length; index += 1) {
    const value = bytes[index];
    if (value === 0) break;
    chars.push(String.fromCharCode(value));
  }
  return chars.join("");
}

function decodeValues(bytes, type, count, littleEndian) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = [];
  switch (type) {
    case 1:
    case 6:
    case 7:
      for (let index = 0; index < count; index += 1) {
        values.push(type === 6 ? dv.getInt8(index) : dv.getUint8(index));
      }
      break;
    case 2:
      return decodeAscii(bytes);
    case 3:
      for (let index = 0; index < count; index += 1) values.push(dv.getUint16(index * 2, littleEndian));
      break;
    case 4:
      for (let index = 0; index < count; index += 1) values.push(dv.getUint32(index * 4, littleEndian));
      break;
    case 5:
      for (let index = 0; index < count; index += 1) {
        const base = index * 8;
        const den = dv.getUint32(base + 4, littleEndian);
        values.push(den ? (dv.getUint32(base, littleEndian) / den) : 0);
      }
      break;
    case 8:
      for (let index = 0; index < count; index += 1) values.push(dv.getInt16(index * 2, littleEndian));
      break;
    case 9:
      for (let index = 0; index < count; index += 1) values.push(dv.getInt32(index * 4, littleEndian));
      break;
    case 10:
      for (let index = 0; index < count; index += 1) {
        const base = index * 8;
        const den = dv.getInt32(base + 4, littleEndian);
        values.push(den ? (dv.getInt32(base, littleEndian) / den) : 0);
      }
      break;
    case 11:
      for (let index = 0; index < count; index += 1) values.push(dv.getFloat32(index * 4, littleEndian));
      break;
    case 12:
      for (let index = 0; index < count; index += 1) values.push(dv.getFloat64(index * 8, littleEndian));
      break;
    case 16:
    case 18:
      for (let index = 0; index < count; index += 1) values.push(Number(dv.getBigUint64(index * 8, littleEndian)));
      break;
    case 17:
      for (let index = 0; index < count; index += 1) values.push(Number(dv.getBigInt64(index * 8, littleEndian)));
      break;
    default:
      throw new Error(`Unsupported TIFF field type ${type}`);
  }
  return scalarOrArray(values);
}

async function blobToUint8(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

class FileReader {
  constructor(file, rangeSource = null) {
    this.file = file;
    this.size = Number(file?.size || 0);
    this.rangeSource = rangeSource;
  }

  async read(offset, length) {
    const safeOffset = clamp(Math.floor(Number(offset) || 0), 0, this.size);
    const safeLength = Math.max(0, Math.floor(Number(length) || 0));
    if (this.rangeSource) {
      const count = Math.min(safeLength, this.size - safeOffset);
      const result = new Uint8Array(count);
      const chunkBytes = Math.max(1, Math.min(1024 * 1024,
        this.rangeSource.maxLogicalResultBytes || Infinity,
        this.rangeSource.maxWorkingSetBytes ? Math.floor(this.rangeSource.maxWorkingSetBytes / 2) : Infinity));
      for (let cursor = 0; cursor < count; cursor += chunkBytes) {
        const bytes = await this.rangeSource.read(safeOffset + cursor, Math.min(chunkBytes, count - cursor));
        result.set(bytes, cursor);
      }
      return result;
    }
    return blobToUint8(this.file.slice(safeOffset, Math.min(this.size, safeOffset + safeLength)));
  }
}

async function parseHeader(reader) {
  const header = await reader.read(0, 16);
  if (header.length < 8) throw new Error("TIFF header is truncated.");
  const dv = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const byteOrder = String.fromCharCode(header[0], header[1]);
  const littleEndian = byteOrder === "II";
  if (!littleEndian && byteOrder !== "MM") throw new Error("Unsupported TIFF byte order.");
  const magic = dv.getUint16(2, littleEndian);
  if (magic === TIFF_MAGIC) {
    return {
      littleEndian,
      bigTiff: false,
      entryCountBytes: 2,
      entrySize: 12,
      valueBytes: 4,
      firstIfdOffset: readUnsigned(dv, 4, 4, littleEndian)
    };
  }
  if (magic === BIGTIFF_MAGIC) {
    const offsetSize = dv.getUint16(4, littleEndian);
    if (offsetSize !== 8) throw new Error(`Unsupported BigTIFF offset size: ${offsetSize}`);
    return {
      littleEndian,
      bigTiff: true,
      entryCountBytes: 8,
      entrySize: 20,
      valueBytes: 8,
      firstIfdOffset: readUnsigned(dv, 8, 8, littleEndian)
    };
  }
  throw new Error("Unrecognized TIFF header.");
}

async function parseIfdAt(reader, header, ifdOffset, metadataBudget) {
  const offset = ensureMetadataSafeInt(ifdOffset, "IFD offset");
  const countBytes = await reader.read(offset, header.entryCountBytes);
  if (countBytes.length < header.entryCountBytes) throw new Error("TIFF IFD count is truncated.");
  const countView = new DataView(countBytes.buffer, countBytes.byteOffset, countBytes.byteLength);
  const entryCount = ensureMetadataSafeInt(readUnsigned(countView, 0, header.entryCountBytes, header.littleEndian), "IFD entry count");
  const entriesBytes = checkedMultiply(entryCount, header.entrySize, "IFD entry table size");
  const totalBytes = checkedAdd(checkedAdd(header.entryCountBytes, entriesBytes, "IFD size"), header.valueBytes, "IFD size");
  reserveMetadata(metadataBudget, totalBytes, "IFD entry table");
  if (checkedAdd(offset, totalBytes, "IFD end offset") > reader.size) throw new Error("TIFF IFD is truncated.");
  const raw = await reader.read(offset, totalBytes);
  if (raw.length < totalBytes) throw new Error("TIFF IFD is truncated.");
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const fileDirectory = {};

  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = header.entryCountBytes + (index * header.entrySize);
    const tag = dv.getUint16(entryOffset, header.littleEndian);
    const type = dv.getUint16(entryOffset + 2, header.littleEndian);
    const name = TAG_NAMES.get(tag);
    if (!name) continue;
    const count = ensureMetadataSafeInt(
      readUnsigned(dv, entryOffset + 4, header.bigTiff ? 8 : 4, header.littleEndian),
      `tag ${tag} value count`
    );
    const bytesPerValue = TYPE_SIZES.get(type);
    if (!bytesPerValue || count <= 0) continue;
    const totalValueBytes = checkedMultiply(count, bytesPerValue, `tag ${tag} value size`);
    let valueBytes = null;
    if (totalValueBytes <= header.valueBytes) {
      valueBytes = raw.subarray(entryOffset + header.entrySize - header.valueBytes, entryOffset + header.entrySize - header.valueBytes + totalValueBytes);
    } else {
      reserveMetadata(metadataBudget, totalValueBytes, `tag ${tag} values`);
      const valueOffset = ensureMetadataSafeInt(
        readUnsigned(dv, entryOffset + header.entrySize - header.valueBytes, header.valueBytes, header.littleEndian),
        `tag ${tag} value offset`
      );
      if (checkedAdd(valueOffset, totalValueBytes, `tag ${tag} value end`) > reader.size) {
        throw new Error(`TIFF tag ${tag} value is truncated.`);
      }
      valueBytes = await reader.read(valueOffset, totalValueBytes);
      if (valueBytes.length < totalValueBytes) throw new Error(`TIFF tag ${tag} value is truncated.`);
    }
    if ([273, 279, 324, 325, 330].includes(tag) && [3, 4, 16, 18].includes(type)) {
      const Values = type === 16 || type === 18 ? Float64Array : Uint32Array;
      const values = new Values(count);
      const valueView = new DataView(valueBytes.buffer, valueBytes.byteOffset, valueBytes.byteLength);
      for (let item = 0; item < count; item += 1) {
        values[item] = ensureMetadataSafeInt(readUnsigned(valueView, item * bytesPerValue, bytesPerValue, header.littleEndian), `tag ${tag} value`);
      }
      fileDirectory[name] = values;
    } else fileDirectory[name] = decodeValues(valueBytes, type, count, header.littleEndian);
  }

  const nextIfdOffset = readUnsigned(
    dv,
    header.entryCountBytes + (entryCount * header.entrySize),
    header.valueBytes,
    header.littleEndian
  );

  return { ifdOffset: offset, fileDirectory, nextIfdOffset };
}

function normalizeNumericArray(value, fallback = 1, count = 1) {
  if (Array.isArray(value)) return value.map((entry) => Number(entry) || fallback);
  if (typeof value === "string") return [Number(value) || fallback];
  const scalar = Number(value);
  if (!Number.isFinite(scalar)) return Array.from({ length: count }, () => fallback);
  return Array.from({ length: Math.max(1, count) }, () => scalar);
}

function canNativeReadRasters(summary) {
  return Number(summary.compression) === 1 && Number(summary.samplesPerPixel) >= 1;
}

function canNativeReadRgb(summary) {
  return (Number(summary.compression) === 1 && isRawCompatibleSummary(summary))
    || supportsNativeJpegTileDecode(summary);
}

function createNearestResampledView(input, inputW, inputH, outputW, outputH, Ctor = Float32Array) {
  if (inputW === outputW && inputH === outputH) return input;
  const out = new Ctor(outputW * outputH);
  for (let y = 0; y < outputH; y += 1) {
    const srcY = clamp(Math.floor((y * inputH) / Math.max(1, outputH)), 0, inputH - 1);
    const rowBase = y * outputW;
    const srcRowBase = srcY * inputW;
    for (let x = 0; x < outputW; x += 1) {
      const srcX = clamp(Math.floor((x * inputW) / Math.max(1, outputW)), 0, inputW - 1);
      out[rowBase + x] = input[srcRowBase + srcX];
    }
  }
  return out;
}

function interleaveRgbBands(bands, width, height) {
  const out = new Uint8Array(width * height * 3);
  for (let index = 0, offset = 0; index < (width * height); index += 1, offset += 3) {
    out[offset] = Number(bands[0][index]) || 0;
    out[offset + 1] = Number(bands[1][index]) || 0;
    out[offset + 2] = Number(bands[2][index]) || 0;
  }
  return out;
}

class NativeTiffImage {
  constructor(backend, imageIndex, fileDirectory, ifdOffset = null) {
    this.backend = backend;
    this.imageIndex = imageIndex;
    this.fileDirectory = fileDirectory;
    this.ifdOffset = Number.isFinite(Number(ifdOffset)) ? ensureSafeInt(ifdOffset, "IFD offset") : null;
    if (this.ifdOffset != null) {
      this.fileDirectory.__ifdOffset = this.ifdOffset;
    }
    this._rawSource = null;
    this._rgbSource = null;
    this._sampleType = null;
  }

  getWidth() { return Number(this.fileDirectory.ImageWidth || 0); }
  getHeight() { return Number(this.fileDirectory.ImageLength || 0); }
  getSamplesPerPixel() { return Number(this.fileDirectory.SamplesPerPixel || 1); }
  getBitsPerSample(sampleIndex = 0) {
    const bits = normalizeNumericArray(this.fileDirectory.BitsPerSample, 1, this.getSamplesPerPixel());
    return bits[clamp(sampleIndex, 0, bits.length - 1)];
  }
  getSampleFormat(sampleIndex = 0) {
    const formats = normalizeNumericArray(this.fileDirectory.SampleFormat, 1, this.getSamplesPerPixel());
    return formats[clamp(sampleIndex, 0, formats.length - 1)];
  }
  getFileDirectory() { return this.fileDirectory; }

  summary() {
    const samplesPerPixel = this.getSamplesPerPixel();
    if (!Number.isSafeInteger(samplesPerPixel) || samplesPerPixel < 1 || samplesPerPixel > MAX_SAMPLES_PER_PIXEL) {
      throw metadataLimitError(
        `TIFF SamplesPerPixel ${String(samplesPerPixel)} exceeds the supported limit of ${MAX_SAMPLES_PER_PIXEL}.`
      );
    }
    return {
      image: this,
      fileDirectory: this.fileDirectory,
      width: this.getWidth(),
      height: this.getHeight(),
      samplesPerPixel,
      bitsPerSample: normalizeNumericArray(this.fileDirectory.BitsPerSample, 1, samplesPerPixel),
      sampleFormats: normalizeNumericArray(this.fileDirectory.SampleFormat, 1, samplesPerPixel),
      planarConfiguration: Number(this.fileDirectory.PlanarConfiguration || 1),
      photometricInterpretation: Number(this.fileDirectory.PhotometricInterpretation || (this.getSamplesPerPixel() === 3 ? 2 : 1)),
      compression: Number(this.fileDirectory.Compression || 1),
      rowsPerStrip: Number(this.fileDirectory.RowsPerStrip || this.getHeight()),
      stripOffsets: listTagValues(this.fileDirectory.StripOffsets),
      stripByteCounts: listTagValues(this.fileDirectory.StripByteCounts),
      tileOffsets: listTagValues(this.fileDirectory.TileOffsets),
      subIFDOffsets: listTagValues(this.fileDirectory.SubIFDs),
      pageNumber: listTagValues(this.fileDirectory.PageNumber),
      newSubfileType: Number(this.fileDirectory.NewSubfileType || 0)
    };
  }

  sampleType() {
    if (!this._sampleType) this._sampleType = resolveUniformSampleType(this.summary(), "TIFF image");
    return this._sampleType;
  }

  meta() {
    const summary = this.summary();
    const sampleType = this.sampleType();
    return buildMeta({
      width: summary.width,
      height: summary.height,
      bands: summary.samplesPerPixel,
      interleave: summary.planarConfiguration === 1 ? "bip" : "bsq",
      littleEndian: this.backend.littleEndian,
      dataType: sampleType.dataType,
      dataTypeInfo: sampleType.dataTypeInfo,
      bandNames: summary.samplesPerPixel === 3 ? ["Red", "Green", "Blue"] : null,
      defaultBands: summary.samplesPerPixel === 3 ? [0, 1, 2] : null,
      defaultDisplayMode: summary.samplesPerPixel === 3 ? "rgb" : null,
      defaultAdjustColor: summary.samplesPerPixel === 3 ? "red" : null,
      description: this.backend.file?.name || "TIFF"
    });
  }

  rgbMeta() {
    return buildRgbDisplayMeta(this.summary(), `${String(this.backend.file?.name || "TIFF")} (${photometricName(this.fileDirectory.PhotometricInterpretation)})`);
  }

  getRawSource() {
    if (!this._rawSource) {
      const summary = this.summary();
      const sampleType = this.sampleType();
      this._rawSource = new TiffBlockIndexedDataSource({
        file: this.backend.file,
        tiff: null,
        meta: this.meta(),
        bandSpecs: buildRawBandSpecs(summary, sampleType, this.imageIndex ?? 0),
        budgets: this.backend.budgets,
        concurrency: this.backend.ioConcurrency
      });
    }
    return this._rawSource;
  }

  getRgbSource() {
    if (!this._rgbSource) {
      const summary = this.summary();
      this._rgbSource = new TiffBlockIndexedDataSource({
        file: this.backend.file,
        tiff: null,
        meta: this.rgbMeta(),
        bandSpecs: buildRgbBandSpecs(summary, this.imageIndex ?? 0),
        budgets: this.backend.budgets,
        concurrency: this.backend.ioConcurrency
      });
    }
    return this._rgbSource;
  }

  async readRasters(options = {}) {
    const summary = this.summary();
    if (canNativeReadRasters(summary)) {
      return this.backend.readRastersNative(this, options);
    }
    return this.backend.readRastersFallback(this, options);
  }

  async readRGB(options = {}) {
    const summary = this.summary();
    if (canNativeReadRgb(summary) && (Number(summary.compression) !== 7 || canNativeDecodeJpeg())) {
      return this.backend.readRgbNative(this, options);
    }
    return this.backend.readRgbFallback(this, options);
  }

  close() {
    try { this._rawSource?.close?.(); } catch (_err) {}
    try { this._rgbSource?.close?.(); } catch (_err) {}
    this._rawSource = null;
    this._rgbSource = null;
  }
}

export class NativeTiffBackend {
  constructor(file, deps = {}) {
    this.file = file;
    this.reader = new FileReader(file, deps?.tiffFmapRangeSource || null);
    const metadataLimit = Number(deps?.tiffMaxMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES);
    this.metadataBudget = {
      limit: Number.isSafeInteger(metadataLimit) && metadataLimit > 0 ? metadataLimit : DEFAULT_MAX_METADATA_BYTES,
      used: 0
    };
    this.ioConcurrency = Number(deps?.ioConcurrency) || 2;
    this.budgets = resolveTiffCacheBudgets(deps);
    this.littleEndian = true;
    this.bigTiff = false;
    this.header = null;
    this.images = [];
    this.ifdRecords = new Map();
    this.metadataIndex = null;
    this.metadataWarnings = [];
    this._fallback = null;
  }

  async init() {
    this.header = await parseHeader(this.reader);
    this.littleEndian = this.header.littleEndian;
    this.bigTiff = this.header.bigTiff;
    let offset = this.header.firstIfdOffset;
    const mainOffsets = new Set();
    while (offset) {
      if (mainOffsets.has(offset)) throw metadataLimitError("TIFF contains a cyclic main IFD chain.");
      mainOffsets.add(offset);
      const record = await this.readDirectoryAt(offset, this.images.length);
      this.images.push(record.image);
      offset = ensureMetadataSafeInt(record.nextIFDByteOffset || 0, "next IFD offset");
    }
    if (!this.images.length) throw new Error("TIFF has no readable image directories.");
    const parents = new Map(), pending = [], queued = new Set(), visited = new Set(mainOffsets);
    let links = 0;
    const enqueue = (childOffset, parentOffset) => {
      const child = ensureMetadataSafeInt(childOffset, "SubIFD offset");
      if (!child) return;
      if (!parents.has(child)) {
        if (parents.size >= 4096) throw metadataLimitError("TIFF contains too many SubIFD references.");
        parents.set(child, new Set());
      }
      if (!parents.get(child).has(parentOffset)) {
        if (++links > 65536) throw metadataLimitError("TIFF contains too many SubIFD relationships.");
        parents.get(child).add(parentOffset);
      }
      if (visited.has(child) || queued.has(child)) return;
      queued.add(child);
      pending.push([child, parentOffset]);
    };
    const enqueueChildren = (record) => {
      for (const child of listTagValues(record.fileDirectory.SubIFDs)) {
        enqueue(child, record.image.ifdOffset);
      }
    };
    for (const record of this.ifdRecords.values()) enqueueChildren(record);
    for (let cursor = 0; cursor < pending.length; cursor += 1) {
      const [childOffset, parentOffset] = pending[cursor];
      if (visited.has(childOffset)) continue;
      visited.add(childOffset);
      let record;
      try { record = await this.readDirectoryAt(childOffset); }
      catch (error) {
        if (error?.code === "TIFF_METADATA_LIMIT") throw error;
        this.metadataWarnings.push({ offset: childOffset, message: String(error?.message || error) });
        continue; // Preserve usable base images when an optional overview is malformed.
      }
      enqueueChildren(record);
      if (record.nextIFDByteOffset) enqueue(record.nextIFDByteOffset, parentOffset);
    }
    const summaries = new Map([...this.ifdRecords.values()].map((record) => [record.image, summarizeImage(record.image)]));
    this.metadataIndex = buildTiffImageCatalog(this.images.map((image) => summaries.get(image)), [...summaries.values()], parents);
  }

  async readDirectoryAt(offset, imageIndex = null) {
    const safeOffset = ensureMetadataSafeInt(offset, "IFD offset");
    if (this.ifdRecords.has(safeOffset)) return this.ifdRecords.get(safeOffset);
    if (this.ifdRecords.size >= 4096) throw metadataLimitError("TIFF contains too many image directories.");
    const parsed = await parseIfdAt(this.reader, this.header, safeOffset, this.metadataBudget);
    const image = new NativeTiffImage(this, imageIndex, parsed.fileDirectory, parsed.ifdOffset);
    const record = { image, fileDirectory: parsed.fileDirectory, geoKeyDirectory: null, nextIFDByteOffset: parsed.nextIfdOffset };
    this.ifdRecords.set(safeOffset, record);
    return record;
  }

  async ensureFallback() {
    if (!this._fallback) this._fallback = await openGeotiffFallback(this.file);
    return this._fallback;
  }

  async getImageCount() {
    return this.images.length;
  }

  async getImage(index = 0) {
    const image = this.images[index];
    if (!image) throw new Error(`No image at index ${index}`);
    return image;
  }

  async parseFileDirectoryAt(offset) {
    return this.readDirectoryAt(offset);
  }

  async readRgbNative(image, options = {}) {
    const window = Array.isArray(options.window) ? options.window : [0, 0, image.getWidth(), image.getHeight()];
    const inW = Math.max(1, window[2] - window[0]);
    const inH = Math.max(1, window[3] - window[1]);
    const outW = Math.max(1, Number(options.width) || inW);
    const outH = Math.max(1, Number(options.height) || inH);
    const composite = await image.getRgbSource().readCompositeWindow(image.rgbMeta(), window[0], window[1], inW, inH, 1);
    const bands = composite?.bands || [new Float32Array(inW * inH), new Float32Array(inW * inH), new Float32Array(inW * inH)];
    const resizedBands = bands.map((band) => createNearestResampledView(band, inW, inH, outW, outH, Float32Array));
    return interleaveRgbBands(resizedBands, outW, outH);
  }

  async readRgbFallback(image, options = {}) {
    const fallback = await this.ensureFallback();
    const target = image.imageIndex == null
      ? await fallback.parseFileDirectoryAt(ensureSafeInt(image.ifdOffset, "IFD offset"))
      : await fallback.getImage(image.imageIndex);
    const targetImage = target?.image || target;
    return targetImage.readRGB(options);
  }

  async readRastersNative(image, options = {}) {
    const meta = image.meta();
    const source = image.getRawSource();
    const samples = Array.isArray(options.samples) && options.samples.length
      ? options.samples.map((value) => clamp(Math.floor(Number(value) || 0), 0, meta.bands - 1))
      : Array.from({ length: meta.bands }, (_v, index) => index);
    const interleave = options.interleave !== false;
    const window = Array.isArray(options.window) ? options.window : [0, 0, image.getWidth(), image.getHeight()];
    const inW = Math.max(1, window[2] - window[0]);
    const inH = Math.max(1, window[3] - window[1]);
    const outW = Math.max(1, Number(options.width) || inW);
    const outH = Math.max(1, Number(options.height) || inH);
    const Ctor = meta.dataTypeInfo?.ctor || Float32Array;
    const fillValue = Number(options.fillValue);
    const outputs = [];
    for (const band of samples) {
      const raw = await source.readBandWindow(meta, band, window[0], window[1], inW, inH, 1);
      let resized = raw;
      if (outW !== inW || outH !== inH) {
        resized = createNearestResampledView(raw, inW, inH, outW, outH, Ctor);
      } else if (!(raw instanceof Ctor)) {
        resized = Ctor.from(raw);
      }
      if (Number.isFinite(fillValue)) {
        for (let index = 0; index < resized.length; index += 1) {
          if (Number.isNaN(resized[index])) resized[index] = fillValue;
        }
      }
      outputs.push(resized);
    }
    if (!interleave) return outputs;
    const interleaved = new Ctor(outW * outH * samples.length);
    for (let index = 0; index < (outW * outH); index += 1) {
      const base = index * samples.length;
      for (let channel = 0; channel < samples.length; channel += 1) {
        interleaved[base + channel] = outputs[channel][index];
      }
    }
    return interleaved;
  }

  async readRastersFallback(image, options = {}) {
    const fallback = await this.ensureFallback();
    const target = image.imageIndex == null
      ? await fallback.parseFileDirectoryAt(ensureSafeInt(image.ifdOffset, "IFD offset"))
      : await fallback.getImage(image.imageIndex);
    const targetImage = target?.image || target;
    return targetImage.readRasters(options);
  }

  close() {
    for (const record of this.ifdRecords.values()) record.image.close();
    this.ifdRecords.clear();
    this.metadataIndex = null;
    this.images = [];
    if (this._fallback && typeof this._fallback.close === "function") {
      try { this._fallback.close(); } catch (_err) {}
    }
    this._fallback = null;
  }
}

export async function openNativeTiffBackend(file, deps = {}) {
  const backend = new NativeTiffBackend(file, deps);
  await backend.init();
  return backend;
}
