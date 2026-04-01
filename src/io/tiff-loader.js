import { fromBlob } from "geotiff";
import { ChunkCacheDataSource, BlobDataSource } from "../core/data-source.js";
import {
  makeSegmentReader,
  readBandWindow as readBandWindowCore,
  segGet
} from "../core/raster-io.js";
import { DATA_TYPES } from "../core/envi-types.js";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const TIFF_EXT_RE = /\.(tif|tiff)$/i;

function createTiffStats() {
  return {
    bytesRead: 0,
    readCalls: 0,
    readIntoCalls: 0,
    visitPagesCalls: 0,
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

function isUncompressedSingleStrip(summary) {
  return summary.compression === 1
    && !summary.tileOffsets.length
    && Number(summary.rowsPerStrip) === Number(summary.height)
    && summary.stripOffsets.length >= 1
    && summary.stripByteCounts.length >= 1;
}

function createLinearSingleSource(summary, sampleType, file, deps) {
  const bytesPerSample = sampleType.dataTypeInfo.bytes;
  const { width, height, samplesPerPixel, planarConfiguration } = summary;
  const base = new BlobDataSource(file);
  const cached = new ChunkCacheDataSource(base, {
    chunkSize: deps?.chunkSize ?? (1 << 20),
    maxBytes: deps?.cacheBytes ?? (128 * 1024 * 1024),
    concurrency: deps?.ioConcurrency ?? 2
  });
  const desc = String(file?.name || "TIFF");
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
        headerOffset: requireSafeOffset(summary.stripOffsets[0], "strip offset"),
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
        headerOffset: requireSafeOffset(summary.stripOffsets[0], "strip offset"),
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
  if (!isUncompressedSingleStrip(summary)) return null;
  const bandBytes = summary.width * summary.height * sampleType.dataTypeInfo.bytes;
  if (summary.samplesPerPixel === 3 && summary.planarConfiguration === 2) {
    if (summary.stripOffsets.length < 3 || summary.stripByteCounts.length < 3) return null;
    const bandOffsets = [];
    for (let band = 0; band < 3; band += 1) {
      if (summary.stripByteCounts[band] < bandBytes) {
        throw new Error("TIFF planar strip is smaller than expected band payload.");
      }
      bandOffsets.push(requireSafeOffset(summary.stripOffsets[band], `planar strip offset ${band + 1}`));
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
  const raw = {
    format: "tiff",
    imageCount,
    bigTiff: !!tiff.bigTiff
  };

  if (imageCount === 1) {
    if (first.samplesPerPixel !== 1 && first.samplesPerPixel !== 3) {
      throw new Error("Only grayscale TIFF or 3-band TIFF images are supported.");
    }

    const linear = createLinearSingleSource(first, sampleType, file, deps);
    if (linear) {
      linear.meta.littleEndian = !!tiff.littleEndian;
      return { raw, meta: linear.meta, mode: "linear", base: linear.base, cached: linear.cached };
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
      return {
        raw,
        meta,
        mode: "band-offset",
        base: null,
        cached: new BandOffsetTiffDataSource(cached, meta, bandOffsets)
      };
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
      mode: "windowed",
      base: null,
        cached: new TiffWindowDataSource({
          tiff,
          images: images.map((entry) => entry.image),
          meta,
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
    const pageType = resolveUniformSampleType(summary, `TIFF page ${index + 1}`);
    if (pageType.dataType !== sampleType.dataType) {
      throw new Error("Multi-page TIFF pages must share the same sample type.");
    }
  }

  const bandBytes = first.width * first.height * sampleType.dataTypeInfo.bytes;
  const simplePages = images.map((summary) => {
    if (!isUncompressedSingleStrip(summary) || summary.samplesPerPixel !== 1) return null;
    if (summary.stripByteCounts[0] < bandBytes) {
      throw new Error("TIFF page strip is smaller than expected band payload.");
    }
    return requireSafeOffset(summary.stripOffsets[0], `page ${summary.pageNumber?.[0] ?? ""} strip offset`);
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
      return { raw, meta, mode: "linear", base, cached };
    }
    return {
      raw,
      meta,
      mode: "band-offset",
      base: null,
      cached: new BandOffsetTiffDataSource(cached, meta, simplePages)
    };
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
    mode: "windowed",
    base: null,
      cached: new TiffWindowDataSource({
        tiff,
        images: images.map((entry) => entry.image),
        meta,
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
