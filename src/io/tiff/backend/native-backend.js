import { buildMeta, buildRgbDisplayMeta, isRawCompatibleSummary, listTagValues, photometricName, resolveTiffCacheBudgets, resolveUniformSampleType, summarizeImage, supportsNativeJpegTileDecode } from "../shared.js";
import { buildTiffImageCatalog } from "../metadata-index.js";
import { TiffBlockIndexedDataSource, buildRawBandSpecs, buildRgbBandSpecs } from "../data-sources.js";
import { openGeotiffFallback } from "./geotiff-fallback.js";
import { LibtiffMetadataReader, metadataLimitError } from "../libtiff/metadata.js";
import { tiffPhysicalScale } from "../physical-scale.js";

const MAX_SAMPLES_PER_PIXEL = 4096;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function canNativeDecodeJpeg() {
  return typeof createImageBitmap === "function";
}

function ensureSafeInt(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Unsupported TIFF ${label}: ${String(value)}`);
  return number;
}

function ensureMetadataSafeInt(value, label) {
  try { return ensureSafeInt(value, label); }
  catch (error) { throw metadataLimitError(error.message); }
}

function normalizeNumericArray(value, fallback = 1, count = 1) {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return Array.from(value, (entry) => Number(entry) || fallback);
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
      description: this.backend.file?.name || "TIFF",
      scale: tiffPhysicalScale(this.fileDirectory)
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
    this.reader = new LibtiffMetadataReader(file, deps?.tiffFmapRangeSource || null, deps?.tiffMaxMetadataBytes);
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
    this.header = await this.reader.open();
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
    const parsed = await this.reader.directory(safeOffset);
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
    this.reader.close();
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
  try { await backend.init(); return backend; }
  catch (error) { backend.close(); throw error; }
}
