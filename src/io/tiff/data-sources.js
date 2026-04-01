import { Pool } from "geotiff";
import { BlobDataSource, ChunkCacheDataSource } from "../../core/data-source.js";
import {
  makeSegmentReader,
  readBandWindow as readBandWindowCore,
  segGet
} from "../../core/raster-io.js";
import { APP_CONFIG } from "../../app/config.js";
import {
  createTiffStats,
  firstFinite,
  firstSafeOffsetOrNull,
  isRawCompatibleSummary,
  isUncompressedSingleStrip,
  listTagValues,
  perfNow,
  readDataViewValue,
  requireSafeOffset
} from "./shared.js";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class BandOffsetTiffDataSource {
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

export function buildRawBandSpecs(summary, sampleType, imageIndex = 0) {
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

export function buildRgbBandSpecs(summary, imageIndex = 0) {
  const table = buildBlockTable(summary, imageIndex);
  return [0, 1, 2].map((channel) => ({
    kind: "rgb",
    table,
    blocks: table.blocksByGroup[0],
    channel
  }));
}

export function buildWindowBandSpecs(summary, imageIndex = 0) {
  const table = buildBlockTable(summary, imageIndex);
  return Array.from({ length: summary.samplesPerPixel }, (_v, band) => ({
    kind: "window",
    table,
    blocks: table.blocksByGroup[0],
    windowSampleIndex: band,
    channel: band
  }));
}

export function buildBandOffsetSpecs(summary, sampleType) {
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

export class TiffBlockIndexedDataSource {
  constructor({ file, tiff, meta, bandSpecs, budgets = {}, concurrency = 2 }) {
    this.file = file;
    this.tiff = tiff;
    this.meta = meta;
    this.bandSpecs = Array.isArray(bandSpecs) ? bandSpecs : [];
    this.ioConcurrency = clamp(
      Math.floor(Number(concurrency) || APP_CONFIG.io.defaultConcurrency),
      APP_CONFIG.io.minConcurrency,
      APP_CONFIG.io.maxConcurrency
    );
    this.base = new BlobDataSource(file);
    this.rawSource = new ChunkCacheDataSource(this.base, {
      chunkSize: APP_CONFIG.io.defaultChunkSizeBytes,
      maxBytes: Math.max(0, Number(budgets.rawCacheBytes) || 0),
      concurrency: this.ioConcurrency
    });
    this.decodedCache = new LruByteCache(Math.max(0, Number(budgets.decodedCacheBytes) || 0));
    this.decodedInflight = new Map();
    this.workerPoolSize = Math.max(0, Number(budgets.workerPoolSize) || 0);
    this.pool = null;
    this.stats = createTiffStats();
    this.closed = false;
  }

  get maxBytes() {
    return (this.rawSource?.maxBytes || 0) + this.decodedCache.maxBytes;
  }

  cacheBytes() {
    const rawBytes = (this.rawSource && typeof this.rawSource.cacheBytes === "function")
      ? this.rawSource.cacheBytes()
      : 0;
    return rawBytes + this.decodedCache.bytes;
  }

  setMaxBytes(bytes) {
    const total = Math.max(0, Number(bytes) || 0);
    const raw = Math.max(0, Math.floor(total * 0.25));
    if (this.rawSource && typeof this.rawSource.setMaxBytes === "function") {
      this.rawSource.setMaxBytes(raw);
    }
    this.decodedCache.setMaxBytes(Math.max(0, total - raw));
    this.#syncCacheStats();
  }

  setConcurrency(n) {
    this.ioConcurrency = clamp(
      Math.floor(Number(n) || this.ioConcurrency || APP_CONFIG.io.minConcurrency),
      APP_CONFIG.io.minConcurrency,
      APP_CONFIG.io.maxConcurrency
    );
    if (this.rawSource && typeof this.rawSource.setConcurrency === "function") {
      this.rawSource.setConcurrency(this.ioConcurrency);
    }
    this.#resetPool();
  }

  clear() {
    if (this.rawSource && typeof this.rawSource.clear === "function") this.rawSource.clear();
    this.decodedCache.clear();
    this.decodedInflight.clear();
    this.#syncCacheStats();
  }

  estimateReadWork(meta, band, x0, y0, outW, outH, step) {
    const spec = this.bandSpecs[band];
    if (!spec) return null;
    const safeX0 = clamp(Math.floor(x0), 0, Math.max(0, meta.samples - 1));
    const safeY0 = clamp(Math.floor(y0), 0, Math.max(0, meta.lines - 1));
    const maxX = clamp(safeX0 + (outW * step), 0, meta.samples);
    const maxY = clamp(safeY0 + (outH * step), 0, meta.lines);
    const safeOutW = Math.floor((maxX - safeX0 + (step - 1)) / step);
    const safeOutH = Math.floor((maxY - safeY0 + (step - 1)) / step);
    if (safeOutW <= 0 || safeOutH <= 0) {
      return { sparseRaw: false, blockCount: 0, spanReads: 0, xBlockCount: 0, yBlockCount: 0 };
    }

    const xLast = safeX0 + ((safeOutW - 1) * step);
    const yLast = safeY0 + ((safeOutH - 1) * step);
    const minBx = Math.max(0, Math.floor(safeX0 / spec.table.blockWidth));
    const maxBx = Math.min(spec.table.numBlocksX - 1, Math.floor(xLast / spec.table.blockWidth));
    const minBy = Math.max(0, Math.floor(safeY0 / spec.table.blockHeight));
    const maxBy = Math.min(spec.table.numBlocksY - 1, Math.floor(yLast / spec.table.blockHeight));
    const xBlockCount = Math.max(0, Math.min(safeOutW, maxBx - minBx + 1));
    const yBlockCount = Math.max(0, Math.min(safeOutH, maxBy - minBy + 1));
    const blockCount = xBlockCount * yBlockCount;
    const sparseRaw = this.#shouldUseSparseRawSampling(spec, step, blockCount);
    return {
      sparseRaw,
      blockCount,
      xBlockCount,
      yBlockCount,
      spanReads: sparseRaw ? (safeOutH * xBlockCount) : 0
    };
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
    const blockCount = (maxBx - minBx + 1) * (maxBy - minBy + 1);

    if (this.#shouldUseSparseRawSampling(spec, step, blockCount)) {
      const t0 = perfNow();
      await this.#readSparseRawWindow(spec, target, safeX0, safeY0, safeOutW, safeOutH, outW, step, minBx, maxBx);
      this.stats.blockComposeCalls += 1;
      this.stats.blockComposeMs += perfNow() - t0;
      return target;
    }

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
    return this.#readBlockValue(spec, decoded, ix - block.x0, iy - block.y0);
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
    if (this.rawSource && typeof this.rawSource.close === "function") {
      try { this.rawSource.close(); } catch (_err) {}
    }
    this.rawSource = null;
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
    return this.#loadDecodedOnce(cacheKey, async () => {
      const raw = await this.#loadRawBlock(block);
      const buffer = raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength
        ? raw.buffer.slice(0)
        : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
      const t0 = perfNow();
      const decodedBuffer = await this.#getPool().decode(spec.table.summary.fileDirectory, buffer);
      this.stats.decodeCalls += 1;
      this.stats.decodeMs += perfNow() - t0;
      return {
        kind: "raw",
        buffer: decodedBuffer,
        view: new DataView(decodedBuffer),
        storageWidth: spec.table.blockWidth,
        bytes: decodedBuffer.byteLength
      };
    });
  }

  async #loadRgbDecodedBlock(spec, block) {
    const cacheKey = `decoded:${block.key}:rgb`;
    const hit = this.decodedCache.get(cacheKey);
    if (hit) {
      this.stats.decodedCacheHits += 1;
      this.#syncCacheStats();
      return hit;
    }
    return this.#loadDecodedOnce(cacheKey, async () => {
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
      return {
        kind: "rgb",
        data,
        storageWidth: block.w,
        bytes: data.byteLength
      };
    });
  }

  async #loadWindowDecodedBlock(spec, block) {
    const cacheKey = `decoded:${block.key}:window:${spec.windowSampleIndex}`;
    const hit = this.decodedCache.get(cacheKey);
    if (hit) {
      this.stats.decodedCacheHits += 1;
      this.#syncCacheStats();
      return hit;
    }
    return this.#loadDecodedOnce(cacheKey, async () => {
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
      return {
        kind: "sample",
        data: raw,
        storageWidth: block.w,
        bytes: raw.byteLength
      };
    });
  }

  async #loadRawBlock(block) {
    const raw = await this.rawSource.read(block.offset, block.byteCount);
    this.#syncCacheStats();
    return raw;
  }

  async #loadDecodedOnce(cacheKey, loader) {
    const inflight = this.decodedInflight.get(cacheKey);
    if (inflight) return inflight;
    this.stats.decodedCacheMisses += 1;
    const p = (async () => {
      const decoded = await loader();
      this.decodedCache.set(cacheKey, decoded, decoded.bytes);
      this.#syncCacheStats();
      return decoded;
    })();
    this.decodedInflight.set(cacheKey, p);
    try {
      return await p;
    } finally {
      this.decodedInflight.delete(cacheKey);
    }
  }

  #shouldUseSparseRawSampling(spec, step, blockCount) {
    return spec?.kind === "raw"
      && Number(spec?.table?.summary?.compression) === 1
      && Number(step) > 1
      && Number(blockCount) > 1;
  }

  async #readSparseRawWindow(spec, target, x0, y0, safeOutW, safeOutH, outW, step, minBx, maxBx) {
    const storageRowBytes = spec.table.blockWidth * spec.bytesPerPixel;
    const numBlocksX = spec.table.numBlocksX;
    const blockHeight = spec.table.blockHeight;
    await parallelFor(
      safeOutH,
      this.ioConcurrency,
      async (rowIndex) => {
        const srcY = y0 + (rowIndex * step);
        const by = Math.floor(srcY / blockHeight);
        const rowBase = rowIndex * outW;
        const localYBase = srcY - (by * blockHeight);
        const scratch = new Uint8Array(storageRowBytes);
        for (let bx = minBx; bx <= maxBx; bx += 1) {
          const block = spec.blocks[(by * numBlocksX) + bx];
          if (!block) continue;
          const colStart = Math.max(0, Math.ceil((block.x0 - x0) / step));
          const colEnd = Math.min(safeOutW, Math.floor((block.x0 + block.w - 1 - x0) / step) + 1);
          if (colStart >= colEnd) continue;
          const firstLocalX = x0 + (colStart * step) - block.x0;
          const lastLocalX = x0 + ((colEnd - 1) * step) - block.x0;
          const spanBytes = ((lastLocalX - firstLocalX) * spec.bytesPerPixel) + spec.bytesPerSample;
          const span = scratch.subarray(0, spanBytes);
          const readOffset = block.offset
            + (localYBase * storageRowBytes)
            + (firstLocalX * spec.bytesPerPixel)
            + spec.sampleByteOffset;
          await this.rawSource.readInto(readOffset, span, 0, spanBytes);
          const dv = new DataView(span.buffer, span.byteOffset, spanBytes);
          for (let col = colStart; col < colEnd; col += 1) {
            const srcX = x0 + (col * step);
            const byteOffset = (srcX - block.x0 - firstLocalX) * spec.bytesPerPixel;
            target[rowBase + col] = readDataViewValue(dv, byteOffset, this.meta.dataTypeInfo, this.meta.littleEndian);
          }
        }
      }
    );
    this.#syncCacheStats();
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
        target[baseOut + col] = this.#readBlockValue(spec, decoded, srcX - block.x0, localY);
      }
    }
  }

  #readBlockValue(spec, decoded, localX, localY) {
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
    const rawStats = this.rawSource?.stats || null;
    this.stats.bytesRead = Number(rawStats?.bytesRead) || this.stats.bytesRead || 0;
    this.stats.readCalls = Number(rawStats?.readCalls) || 0;
    this.stats.readIntoCalls = Number(rawStats?.readIntoCalls) || 0;
    this.stats.visitPagesCalls = Number(rawStats?.visitPagesCalls) || 0;
    this.stats.rawCacheHits = Number(rawStats?.cacheHits) || 0;
    this.stats.rawCacheMisses = Number(rawStats?.cacheMisses) || 0;
    this.stats.cacheHits = this.stats.rawCacheHits + this.stats.decodedCacheHits;
    this.stats.cacheMisses = this.stats.rawCacheMisses + this.stats.decodedCacheMisses;
    this.stats.cacheEvictions = Number(rawStats?.cacheEvictions) || 0;
    this.stats.rawCacheBytes = (this.rawSource && typeof this.rawSource.cacheBytes === "function")
      ? this.rawSource.cacheBytes()
      : 0;
    this.stats.decodedCacheBytes = this.decodedCache.bytes;
    this.stats.cacheBytes = this.cacheBytes();
  }
}
