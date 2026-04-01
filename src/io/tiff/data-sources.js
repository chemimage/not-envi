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
  requireSafeOffset,
  supportsNativeJpegTileDecode
} from "./shared.js";
import {
  getSharedTiffDecodePool,
  resolveTiffTaskConcurrency,
  scheduleTiffTask
} from "./scheduler.js";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function canDecodeJpegTileNatively() {
  if (typeof createImageBitmap !== "function") return false;
  if (typeof OffscreenCanvas !== "undefined") return true;
  return typeof document !== "undefined" && typeof document.createElement === "function";
}

function createDecodeCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return null;
}

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

  async readBandWindowBIP(meta, band, x0, y0, outW, outH, step, out = null, options = null) {
    return this.readBandWindow(meta, band, x0, y0, outW, outH, step, out, options);
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
  const kind = supportsNativeJpegTileDecode(summary) ? "native-rgb-jpeg" : "rgb";
  return [0, 1, 2].map((channel) => ({
    kind,
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

function isWindowReadOptions(value) {
  return !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && !ArrayBuffer.isView(value);
}

function sortCenterOut(items, centerX, centerY, getCenter, spanX = 1, spanY = 1) {
  const halfSpanX = Math.max(1, Number(spanX) || 1) * 0.5;
  const halfSpanY = Math.max(1, Number(spanY) || 1) * 0.5;
  return items.slice().sort((a, b) => {
    const ac = getCenter(a);
    const bc = getCenter(b);
    const adx = Number(ac?.x ?? 0) - centerX;
    const ady = Number(ac?.y ?? 0) - centerY;
    const bdx = Number(bc?.x ?? 0) - centerX;
    const bdy = Number(bc?.y ?? 0) - centerY;
    const da = Math.max(Math.abs(adx) / halfSpanX, Math.abs(ady) / halfSpanY);
    const db = Math.max(Math.abs(bdx) / halfSpanX, Math.abs(bdy) / halfSpanY);
    if (da !== db) return da - db;
    const ah = Math.abs(adx) + Math.abs(ady);
    const bh = Math.abs(bdx) + Math.abs(bdy);
    if (ah !== bh) return ah - bh;
    if (Math.abs(ady) !== Math.abs(bdy)) return Math.abs(ady) - Math.abs(bdy);
    if (Math.abs(adx) !== Math.abs(bdx)) return Math.abs(adx) - Math.abs(bdx);
    if (Number(ac?.y ?? 0) !== Number(bc?.y ?? 0)) return Number(ac?.y ?? 0) - Number(bc?.y ?? 0);
    return Number(ac?.x ?? 0) - Number(bc?.x ?? 0);
  });
}

function orderBlockIndicesCenterOut(minIndex, maxIndex, blockSize, centerCoord) {
  const indices = [];
  for (let index = minIndex; index <= maxIndex; index += 1) indices.push(index);
  return indices.sort((a, b) => {
    const aCenter = (a * blockSize) + (blockSize * 0.5);
    const bCenter = (b * blockSize) + (blockSize * 0.5);
    const da = Math.abs(aCenter - centerCoord);
    const db = Math.abs(bCenter - centerCoord);
    if (da !== db) return da - db;
    return a - b;
  });
}

async function processInBatches(items, concurrency, runItem, onBatch = null, cancelled = null) {
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Math.min(Math.floor(Number(concurrency) || 1), Math.max(1, list.length || 1)));
  for (let start = 0; start < list.length; start += limit) {
    if (typeof cancelled === "function" && cancelled()) return false;
    const batch = list.slice(start, start + limit);
    const results = await Promise.all(batch.map((item, index) => runItem(item, start + index)));
    if (typeof cancelled === "function" && cancelled()) return false;
    if (typeof onBatch === "function") {
      await onBatch(batch, results, start);
    }
  }
  return true;
}

let nextTiffSourceId = 1;

export class TiffBlockIndexedDataSource {
  constructor({ file, tiff, meta, bandSpecs, overviewSummaries = [], budgets = {}, concurrency = 2, ownerId = "" }) {
    this.file = file;
    this.tiff = tiff;
    this.meta = meta;
    this.bandSpecs = Array.isArray(bandSpecs) ? bandSpecs : [];
    this.ioConcurrency = clamp(
      Math.floor(Number(concurrency) || APP_CONFIG.io.defaultConcurrency),
      APP_CONFIG.io.minConcurrency,
      APP_CONFIG.io.maxConcurrency
    );
    const resolvedOwnerId = String(ownerId || budgets.ownerId || "").trim();
    this.base = new BlobDataSource(file, { ownerId: resolvedOwnerId });
    this.profileName = String(budgets.profileName || "standard");
    this.rawCacheLimitBytes = Math.max(0, Number(budgets.rawCacheBytes) || 0);
    this.decodedCacheLimitBytes = Math.max(0, Number(budgets.decodedCacheBytes) || 0);
    this.rawSource = new ChunkCacheDataSource(this.base, {
      chunkSize: APP_CONFIG.io.defaultChunkSizeBytes,
      maxBytes: this.rawCacheLimitBytes,
      concurrency: this.ioConcurrency,
      ownerId: resolvedOwnerId
    });
    this.decodedCache = new LruByteCache(this.decodedCacheLimitBytes);
    this.decodedInflight = new Map();
    this.workerPoolSize = Math.max(0, Number(budgets.workerPoolSize) || 0);
    this.taskConcurrency = resolveTiffTaskConcurrency();
    this.pool = null;
    this.stats = createTiffStats();
    this.closed = false;
    this.ownerId = String(this.rawSource?.ownerId || this.base?.ownerId || "").trim() || `tiff:${nextTiffSourceId++}`;
    this.overviews = Array.isArray(overviewSummaries)
      ? overviewSummaries
        .map((summary) => ({
          summary,
          scaleX: Number(summary?.scaleX) || (Number(this.meta?.samples) / Math.max(1, Number(summary?.width) || 1)),
          scaleY: Number(summary?.scaleY) || (Number(this.meta?.lines) / Math.max(1, Number(summary?.height) || 1)),
          scale: Number(summary?.scale) || Math.min(
            Number(summary?.scaleX) || (Number(this.meta?.samples) / Math.max(1, Number(summary?.width) || 1)),
            Number(summary?.scaleY) || (Number(this.meta?.lines) / Math.max(1, Number(summary?.height) || 1))
          )
        }))
        .filter((entry) => entry.summary && entry.scale > 1)
        .sort((a, b) => Number(a.scale || 1) - Number(b.scale || 1))
      : [];
    this.overviewCount = this.overviews.length;
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
    this.rawCacheLimitBytes = raw;
    this.decodedCacheLimitBytes = Math.max(0, total - raw);
    if (this.rawSource && typeof this.rawSource.setMaxBytes === "function") {
      this.rawSource.setMaxBytes(raw);
    }
    this.decodedCache.setMaxBytes(this.decodedCacheLimitBytes);
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
    const nativeJpeg = spec.kind === "native-rgb-jpeg";
    const scaledBlockW = Math.max(1, Math.ceil(spec.table.blockWidth / Math.max(1, step)));
    const scaledBlockH = Math.max(1, Math.ceil(spec.table.blockHeight / Math.max(1, step)));
    return {
      sparseRaw,
      nativeJpeg,
      blockCount,
      xBlockCount,
      yBlockCount,
      spanReads: sparseRaw ? (safeOutH * xBlockCount) : 0,
      scaledDecodePixels: nativeJpeg ? (blockCount * scaledBlockW * scaledBlockH) : 0
    };
  }

  supportsCompositeWindow() {
    if (this.bandSpecs.length < 3) return false;
    const specs = this.bandSpecs.slice(0, 3);
    const [first] = specs;
    if (!first || specs.some((spec) => !spec || spec.table !== first.table)) return false;
    if (specs.every((spec) => spec.kind === "raw")) return true;
    if (specs.some((spec) => spec.blocks !== first.blocks)) return false;
    return specs.every((spec) => spec.kind === "rgb" || spec.kind === "native-rgb-jpeg");
  }

  hasNativeOverviews() {
    return this.overviews.length > 0;
  }

  #resolveReadOptions(outOrOptions = null, maybeOptions = null) {
    if (isWindowReadOptions(outOrOptions) && maybeOptions == null) {
      return { out: null, options: outOrOptions };
    }
    return { out: outOrOptions, options: isWindowReadOptions(maybeOptions) ? maybeOptions : null };
  }

  #createProgressEmitter(onProgress, totalUnits, snapshot, options = null) {
    if (typeof onProgress !== "function" || totalUnits <= 0) return null;
    const everyUnits = Math.max(1, Math.floor(Number(options?.progressEvery ?? APP_CONFIG.tiff.progressiveUpdateEveryBlocks) || 1));
    const minMs = Math.max(0, Number(options?.progressMinMs ?? APP_CONFIG.tiff.progressiveUpdateMinMs) || 0);
    let emittedUnits = 0;
    let lastEmitMs = 0;
    return async (completedUnits, force = false) => {
      const safeCompleted = Math.max(0, Math.min(totalUnits, Math.floor(Number(completedUnits) || 0)));
      const nowMs = perfNow();
      if (!force && safeCompleted < totalUnits) {
        const unitsDelta = safeCompleted - emittedUnits;
        const timeDelta = nowMs - lastEmitMs;
        if (unitsDelta < everyUnits && timeDelta < minMs) return;
      }
      emittedUnits = safeCompleted;
      lastEmitMs = nowMs;
      await onProgress({
        ...snapshot(),
        completedUnits: safeCompleted,
        totalUnits
      });
    };
  }

  #orderedBlocks(spec, minBx, maxBx, minBy, maxBy, centerX, centerY, spanX, spanY) {
    const blocks = [];
    for (let by = minBy; by <= maxBy; by += 1) {
      for (let bx = minBx; bx <= maxBx; bx += 1) {
        const block = spec.blocks[(by * spec.table.numBlocksX) + bx];
        if (block) blocks.push(block);
      }
    }
    return sortCenterOut(blocks, centerX, centerY, (block) => ({
      x: block.x0 + (block.w * 0.5),
      y: block.y0 + (block.h * 0.5)
    }), spanX, spanY);
  }

  #orderedCompositeEntries(specs, minBx, maxBx, minBy, maxBy, centerX, centerY, spanX, spanY) {
    const table = specs[0].table;
    const entries = [];
    for (let by = minBy; by <= maxBy; by += 1) {
      for (let bx = minBx; bx <= maxBx; bx += 1) {
        const index = (by * table.numBlocksX) + bx;
        const blocks = specs.map((spec) => spec.blocks[index] || null);
        const anchor = blocks.find(Boolean) || null;
        if (!anchor) continue;
        entries.push({ anchor, blocks });
      }
    }
    return sortCenterOut(entries, centerX, centerY, (entry) => ({
      x: entry.anchor.x0 + (entry.anchor.w * 0.5),
      y: entry.anchor.y0 + (entry.anchor.h * 0.5)
    }), spanX, spanY);
  }

  async readCompositeWindow(meta, x0, y0, outW, outH, step, outBands = null, options = null) {
    if (!this.supportsCompositeWindow()) return null;
    const resolved = this.#resolveReadOptions(outBands, options);
    const readOptions = resolved.options || null;
    const specs = this.bandSpecs.slice(0, 3);
    const outputs = [0, 1, 2].map((index) => {
      const out = Array.isArray(resolved.out) ? resolved.out[index] : null;
      return (out instanceof Float32Array && out.length >= (outW * outH))
        ? out
        : new Float32Array(outW * outH);
    });
    const safeX0 = clamp(Math.floor(x0), 0, Math.max(0, meta.samples - 1));
    const safeY0 = clamp(Math.floor(y0), 0, Math.max(0, meta.lines - 1));
    const maxX = clamp(safeX0 + (outW * step), 0, meta.samples);
    const maxY = clamp(safeY0 + (outH * step), 0, meta.lines);
    const safeOutW = Math.floor((maxX - safeX0 + (step - 1)) / step);
    const safeOutH = Math.floor((maxY - safeY0 + (step - 1)) / step);
    if (safeOutW <= 0 || safeOutH <= 0) {
      return { bands: outputs, width: outW, height: outH };
    }
    const overviewPlan = this.#selectOverviewPlan(step);
    if (overviewPlan) {
      return this.#readCompositeWindowFromOverview(meta, specs, overviewPlan, x0, y0, safeOutW, safeOutH, outW, step, outputs);
    }

    const first = specs[0];
    const cancelled = typeof readOptions?.cancelled === "function" ? readOptions.cancelled : null;
    const centerX = safeX0 + ((safeOutW * step) * 0.5);
    const centerY = safeY0 + ((safeOutH * step) * 0.5);
    const spanX = Math.max(1, safeOutW * step);
    const spanY = Math.max(1, safeOutH * step);
    const xLast = safeX0 + ((safeOutW - 1) * step);
    const yLast = safeY0 + ((safeOutH - 1) * step);
    const minBx = Math.max(0, Math.floor(safeX0 / first.table.blockWidth));
    const maxBx = Math.min(first.table.numBlocksX - 1, Math.floor(xLast / first.table.blockWidth));
    const minBy = Math.max(0, Math.floor(safeY0 / first.table.blockHeight));
    const maxBy = Math.min(first.table.numBlocksY - 1, Math.floor(yLast / first.table.blockHeight));
    const totalUnits = Math.max(0, (maxBx - minBx + 1) * (maxBy - minBy + 1));
    const sparseComposite = this.#shouldUseSparseRawCompositeSampling(specs, step, totalUnits);
    const progressUnits = sparseComposite
      ? Math.max(1, Math.ceil(safeOutH / Math.max(1, Math.floor(APP_CONFIG.tiff.sparseRawRowBatchRows || 1))))
      : Math.max(1, totalUnits);
    const progress = this.#createProgressEmitter(
      readOptions?.onProgress,
      progressUnits,
      () => ({ bands: outputs, width: outW, height: outH, partial: true }),
      readOptions
    );
    if (progress) {
      for (const output of outputs) output.fill(Number.NaN);
    }

    const t0 = perfNow();
    if (specs.every((spec) => spec.kind === "raw")) {
      const completed = await this.#readRawCompositeWindow(
        specs,
        outputs,
        safeX0,
        safeY0,
        safeOutW,
        safeOutH,
        outW,
        step,
        minBx,
        maxBx,
        minBy,
        maxBy,
        centerX,
        centerY,
        spanX,
        spanY,
        progress,
        cancelled,
        progressUnits
      );
      if (!completed) return null;
    } else {
      const blocks = this.#orderedBlocks(first, minBx, maxBx, minBy, maxBy, centerX, centerY, spanX, spanY);
      let completedUnits = 0;
      const completed = await processInBatches(
        blocks,
        this.#resolveBlockLoadConcurrency(first),
        async (block) => ({
          block,
          decoded: await this.#schedule(() => this.#loadDecodedBlock(first, block, step))
        }),
        async (_batch, results) => {
          for (const result of results) {
            this.#compositeRgbBlock(result.block, result.decoded, outputs, safeX0, safeY0, safeOutW, safeOutH, outW, step);
          }
          completedUnits += results.length;
          if (progress) await progress(completedUnits, completedUnits >= progressUnits);
        },
        cancelled
      );
      if (!completed) return null;
      if (progress && completedUnits < progressUnits) {
        await progress(progressUnits, true);
      }
    }
    this.stats.blockComposeCalls += 1;
    this.stats.blockComposeMs += perfNow() - t0;
    return { bands: outputs, width: outW, height: outH };
  }

  async readBandWindow(meta, band, x0, y0, outW, outH, step, out = null, options = null) {
    const resolved = this.#resolveReadOptions(out, options);
    const target = allocateOutput(meta, resolved.out, outW * outH);
    const spec = this.bandSpecs[band];
    if (!spec) throw new Error(`TIFF band ${Number(band) + 1} is unavailable.`);
    const safeX0 = clamp(Math.floor(x0), 0, Math.max(0, meta.samples - 1));
    const safeY0 = clamp(Math.floor(y0), 0, Math.max(0, meta.lines - 1));
    const maxX = clamp(safeX0 + (outW * step), 0, meta.samples);
    const maxY = clamp(safeY0 + (outH * step), 0, meta.lines);
    const safeOutW = Math.floor((maxX - safeX0 + (step - 1)) / step);
    const safeOutH = Math.floor((maxY - safeY0 + (step - 1)) / step);
    if (safeOutW <= 0 || safeOutH <= 0) return target;
    const overviewPlan = this.#selectOverviewPlan(step);
    if (overviewPlan) {
      return this.#readBandWindowFromOverview(meta, band, target, overviewPlan, safeX0, safeY0, safeOutW, safeOutH, step);
    }

    const xLast = safeX0 + ((safeOutW - 1) * step);
    const yLast = safeY0 + ((safeOutH - 1) * step);
    const minBx = Math.max(0, Math.floor(safeX0 / spec.table.blockWidth));
    const maxBx = Math.min(spec.table.numBlocksX - 1, Math.floor(xLast / spec.table.blockWidth));
    const minBy = Math.max(0, Math.floor(safeY0 / spec.table.blockHeight));
    const maxBy = Math.min(spec.table.numBlocksY - 1, Math.floor(yLast / spec.table.blockHeight));
    const blockCount = (maxBx - minBx + 1) * (maxBy - minBy + 1);
    const sparseRaw = this.#shouldUseSparseRawSampling(spec, step, blockCount);
    const readOptions = resolved.options || null;
    const cancelled = typeof readOptions?.cancelled === "function" ? readOptions.cancelled : null;
    const centerX = safeX0 + ((safeOutW * step) * 0.5);
    const centerY = safeY0 + ((safeOutH * step) * 0.5);
    const spanX = Math.max(1, safeOutW * step);
    const spanY = Math.max(1, safeOutH * step);
    const progressUnits = sparseRaw
      ? Math.max(1, Math.ceil(safeOutH / Math.max(1, Math.floor(APP_CONFIG.tiff.sparseRawRowBatchRows || 1))))
      : Math.max(1, blockCount);
    const progress = this.#createProgressEmitter(
      readOptions?.onProgress,
      progressUnits,
      () => ({ band, data: target, width: outW, height: outH, partial: true }),
      readOptions
    );
    if (progress && typeof target.fill === "function") target.fill(Number.NaN);

    if (sparseRaw) {
      const t0 = perfNow();
      const completed = await this.#readSparseRawWindow(
        spec,
        target,
        safeX0,
        safeY0,
        safeOutW,
        safeOutH,
        outW,
        step,
        minBx,
        maxBx,
        centerX,
        centerY,
        spanX,
        spanY,
        progress,
        cancelled
      );
      if (!completed) return null;
      this.stats.blockComposeCalls += 1;
      this.stats.blockComposeMs += perfNow() - t0;
      return target;
    }

    const blocks = this.#orderedBlocks(spec, minBx, maxBx, minBy, maxBy, centerX, centerY, spanX, spanY);

    const t0 = perfNow();
    let completedUnits = 0;
    const completed = await processInBatches(
      blocks,
      this.#resolveBlockLoadConcurrency(spec),
      async (block) => ({
        block,
        decoded: await this.#schedule(() => this.#loadDecodedBlock(spec, block, step))
      }),
      async (_batch, results) => {
        for (const result of results) {
          this.#compositeBlock(spec, result.block, result.decoded, target, safeX0, safeY0, safeOutW, safeOutH, outW, step);
        }
        completedUnits += results.length;
        if (progress) await progress(completedUnits, completedUnits >= progressUnits);
      },
      cancelled
    );
    if (!completed) return null;
    if (progress && completedUnits < progressUnits) {
      await progress(progressUnits, true);
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
    const decoded = await this.#schedule(() => this.#loadDecodedBlock(spec, block, 1));
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

  #selectOverviewPlan(step) {
    const desiredStep = Math.max(1, Number(step) || 1);
    if (desiredStep <= 1 || !this.overviews.length) return null;
    let best = null;
    let fallback = null;
    for (const overview of this.overviews) {
      const scale = Math.max(1, Number(overview?.scale) || 1);
      if (scale <= desiredStep) best = overview;
      else if (!fallback) fallback = overview;
    }
    return best || fallback || null;
  }

  #resolveOverviewWindow(overviewPlan, x0, y0, outW, outH, step) {
    const summary = overviewPlan?.summary || null;
    if (!summary) return null;
    const scaleX = Math.max(1, Number(overviewPlan.scaleX) || 1);
    const scaleY = Math.max(1, Number(overviewPlan.scaleY) || 1);
    const xLast = x0 + ((Math.max(1, outW) - 1) * step);
    const yLast = y0 + ((Math.max(1, outH) - 1) * step);
    const ox0 = clamp(Math.floor(x0 / scaleX), 0, Math.max(0, Number(summary.width) - 1));
    const oy0 = clamp(Math.floor(y0 / scaleY), 0, Math.max(0, Number(summary.height) - 1));
    const ox1 = clamp(Math.floor(xLast / scaleX) + 1, ox0 + 1, Math.max(1, Number(summary.width)));
    const oy1 = clamp(Math.floor(yLast / scaleY) + 1, oy0 + 1, Math.max(1, Number(summary.height)));
    return {
      summary,
      window: [ox0, oy0, ox1, oy1],
      width: outW,
      height: outH
    };
  }

  #overviewUsesRgb(spec, summary) {
    return spec?.kind === "rgb"
      || spec?.kind === "native-rgb-jpeg"
      || !isRawCompatibleSummary(summary);
  }

  #overviewSampleIndex(spec, band) {
    if (Number.isFinite(Number(spec?.windowSampleIndex))) return Number(spec.windowSampleIndex);
    if (Number.isFinite(Number(spec?.channel))) return Number(spec.channel);
    return Math.max(0, Math.floor(Number(band) || 0));
  }

  async #readBandWindowFromOverview(meta, band, target, overviewPlan, x0, y0, outW, outH, step) {
    const spec = this.bandSpecs[band];
    if (!spec) throw new Error(`TIFF band ${Number(band) + 1} is unavailable.`);
    const request = this.#resolveOverviewWindow(overviewPlan, x0, y0, outW, outH, step);
    if (!request) return target;
    const t0 = perfNow();
    if (this.#overviewUsesRgb(spec, request.summary)) {
      const rgb = await request.summary.image.readRGB({
        window: request.window,
        interleave: true,
        width: request.width,
        height: request.height,
        resampleMethod: "nearest",
        pool: this.#getPool()
      });
      const channel = clamp(this.#overviewSampleIndex(spec, band), 0, 2);
      for (let index = 0, offset = channel; index < target.length && offset < rgb.length; index += 1, offset += 3) {
        target[index] = rgb[offset];
      }
    } else {
      const sampleIndex = this.#overviewSampleIndex(spec, band);
      const raw = await request.summary.image.readRasters({
        window: request.window,
        samples: [sampleIndex],
        interleave: true,
        width: request.width,
        height: request.height,
        resampleMethod: "nearest",
        fillValue: 0,
        pool: this.#getPool()
      });
      target.set(raw.subarray(0, target.length), 0);
    }
    this.stats.decodeCalls += 1;
    this.stats.decodeMs += perfNow() - t0;
    return target;
  }

  async #readCompositeWindowFromOverview(meta, specs, overviewPlan, x0, y0, outW, outH, fullOutW, step, outputs) {
    const request = this.#resolveOverviewWindow(overviewPlan, x0, y0, outW, outH, step);
    if (!request) return { bands: outputs, width: fullOutW, height: outH };
    const t0 = perfNow();
    if (specs.some((spec) => this.#overviewUsesRgb(spec, request.summary))) {
      const rgb = await request.summary.image.readRGB({
        window: request.window,
        interleave: true,
        width: request.width,
        height: request.height,
        resampleMethod: "nearest",
        pool: this.#getPool()
      });
      for (let index = 0, offset = 0; index < outputs[0].length && (offset + 2) < rgb.length; index += 1, offset += 3) {
        outputs[0][index] = rgb[offset];
        outputs[1][index] = rgb[offset + 1];
        outputs[2][index] = rgb[offset + 2];
      }
    } else {
      const samples = specs.map((spec, index) => this.#overviewSampleIndex(spec, index));
      const raw = await request.summary.image.readRasters({
        window: request.window,
        samples,
        interleave: false,
        width: request.width,
        height: request.height,
        resampleMethod: "nearest",
        fillValue: 0,
        pool: this.#getPool()
      });
      for (let channel = 0; channel < 3; channel += 1) {
        const band = raw[channel];
        outputs[channel].set(band.subarray(0, outputs[channel].length), 0);
      }
    }
    this.stats.decodeCalls += 1;
    this.stats.decodeMs += perfNow() - t0;
    return { bands: outputs, width: fullOutW, height: outH };
  }

  async #loadDecodedBlock(spec, block, step = 1) {
    if (spec.kind === "raw") return this.#loadRawDecodedBlock(spec, block);
    if (spec.kind === "rgb") return this.#loadRgbDecodedBlock(spec, block, step);
    if (spec.kind === "native-rgb-jpeg") return this.#loadNativeRgbJpegBlock(spec, block, step);
    return this.#loadWindowDecodedBlock(spec, block, step);
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
      if (Number(spec?.table?.summary?.compression) === 1) {
        return {
          kind: "raw",
          view: new DataView(raw.buffer, raw.byteOffset, raw.byteLength),
          storageWidth: block.w,
          storageHeight: block.h,
          bytes: raw.byteLength
        };
      }
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

  async #loadRgbDecodedBlock(spec, block, step = 1) {
    const scaledW = Math.max(1, Math.ceil(block.w / Math.max(1, step)));
    const scaledH = Math.max(1, Math.ceil(block.h / Math.max(1, step)));
    const cacheKey = `decoded:${block.key}:rgb:${scaledW}x${scaledH}`;
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
        width: scaledW,
        height: scaledH,
        resampleMethod: "nearest",
        pool: this.#getPool()
      });
      this.stats.decodeCalls += 1;
      this.stats.decodeMs += perfNow() - t0;
      const data = rgb instanceof Uint8Array ? rgb : Uint8Array.from(rgb);
      return {
        kind: "rgb",
        data,
        storageWidth: scaledW,
        storageHeight: scaledH,
        sourceWidth: block.w,
        sourceHeight: block.h,
        bytes: data.byteLength
      };
    });
  }

  async #loadNativeRgbJpegBlock(spec, block, step = 1) {
    const scaledW = Math.max(1, Math.ceil(block.w / Math.max(1, step)));
    const scaledH = Math.max(1, Math.ceil(block.h / Math.max(1, step)));
    const cacheKey = `decoded:${block.key}:native-rgba:${scaledW}x${scaledH}`;
    const hit = this.decodedCache.get(cacheKey);
    if (hit) {
      this.stats.decodedCacheHits += 1;
      this.#syncCacheStats();
      return hit;
    }
    return this.#loadDecodedOnce(cacheKey, async () => {
      const raw = await this.#loadRawBlock(block);
      const t0 = perfNow();
      let decoded = null;
      if (canDecodeJpegTileNatively()) {
        decoded = await this.#decodeNativeJpegTile(raw, scaledW, scaledH);
        if (decoded) {
          decoded.sourceWidth = block.w;
          decoded.sourceHeight = block.h;
        }
      }
      if (!decoded) {
        const rgb = await spec.table.image.readRGB({
          window: [block.x0, block.y0, block.x0 + block.w, block.y0 + block.h],
          interleave: true,
          width: scaledW,
          height: scaledH,
          resampleMethod: "nearest",
          pool: this.#getPool()
        });
        decoded = {
          kind: "rgb",
          data: rgb instanceof Uint8Array ? rgb : Uint8Array.from(rgb),
          storageWidth: scaledW,
          storageHeight: scaledH,
          sourceWidth: block.w,
          sourceHeight: block.h,
          bytes: rgb.byteLength ?? rgb.length ?? (scaledW * scaledH * 3)
        };
      }
      this.stats.decodeCalls += 1;
      this.stats.decodeMs += perfNow() - t0;
      return decoded;
    });
  }

  async #loadWindowDecodedBlock(spec, block, step = 1) {
    const scaledW = Math.max(1, Math.ceil(block.w / Math.max(1, step)));
    const scaledH = Math.max(1, Math.ceil(block.h / Math.max(1, step)));
    const cacheKey = `decoded:${block.key}:window:${spec.windowSampleIndex}:${scaledW}x${scaledH}`;
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
        width: scaledW,
        height: scaledH,
        resampleMethod: "nearest",
        fillValue: 0,
        pool: this.#getPool()
      });
      this.stats.decodeCalls += 1;
      this.stats.decodeMs += perfNow() - t0;
      return {
        kind: "sample",
        data: raw,
        storageWidth: scaledW,
        storageHeight: scaledH,
        sourceWidth: block.w,
        sourceHeight: block.h,
        bytes: raw.byteLength
      };
    });
  }

  async #loadRawBlock(block) {
    const raw = await this.rawSource.read(block.offset, block.byteCount);
    this.#syncCacheStats();
    return raw;
  }

  async #loadBlocks(spec, blocks, step) {
    const decoded = new Array(blocks.length);
    await parallelFor(
      blocks.length,
      this.#resolveBlockLoadConcurrency(spec),
      async (index) => {
        decoded[index] = await this.#schedule(() => this.#loadDecodedBlock(spec, blocks[index], step));
      }
    );
    return decoded;
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

  async #decodeNativeJpegTile(raw, width, height) {
    if (!canDecodeJpegTileNatively()) return null;
    const blob = new Blob([raw], { type: "image/jpeg" });
    let bitmap = null;
    try {
      bitmap = await createImageBitmap(blob);
      const outW = Math.max(1, Number(width) || bitmap.width || 1);
      const outH = Math.max(1, Number(height) || bitmap.height || 1);
      const canvas = createDecodeCanvas(outW, outH);
      const ctx = canvas?.getContext?.("2d", { willReadFrequently: true, alpha: false }) || null;
      if (!ctx || typeof ctx.drawImage !== "function" || typeof ctx.getImageData !== "function") {
        return null;
      }
      if ("imageSmoothingEnabled" in ctx) ctx.imageSmoothingEnabled = false;
      ctx.drawImage(bitmap, 0, 0, outW, outH);
      const imageData = ctx.getImageData(0, 0, outW, outH);
      return {
        kind: "native-rgba",
        data: imageData.data,
        storageWidth: outW,
        storageHeight: outH,
        sourceWidth: outW,
        sourceHeight: outH,
        bytes: imageData.data.byteLength
      };
    } catch (_err) {
      return null;
    } finally {
      if (bitmap && typeof bitmap.close === "function") {
        try { bitmap.close(); } catch (_err) {}
      }
    }
  }

  #shouldUseSparseRawSampling(spec, step, blockCount) {
    return spec?.kind === "raw"
      && Number(spec?.table?.summary?.compression) === 1
      && Number(step) > 1
      && Number(blockCount) > 1;
  }

  #shouldUseSparseRawCompositeSampling(specs, step, blockCount) {
    return Array.isArray(specs)
      && specs.length >= 3
      && specs.every((spec) => this.#shouldUseSparseRawSampling(spec, step, blockCount));
  }

  async #readRawCompositeWindow(specs, outputs, x0, y0, safeOutW, safeOutH, outW, step, minBx, maxBx, minBy, maxBy, centerX, centerY, spanX, spanY, progress = null, cancelled = null, totalUnits = 0) {
    const table = specs[0].table;
    const blockCount = (maxBx - minBx + 1) * (maxBy - minBy + 1);
    if (this.#shouldUseSparseRawCompositeSampling(specs, step, blockCount)) {
      return this.#readSparseRawCompositeWindow(
        specs,
        outputs,
        x0,
        y0,
        safeOutW,
        safeOutH,
        outW,
        step,
        minBx,
        maxBx,
        centerX,
        centerY,
        spanX,
        spanY,
        progress,
        cancelled
      );
    }

    const blockEntries = this.#orderedCompositeEntries(specs, minBx, maxBx, minBy, maxBy, centerX, centerY, spanX, spanY);
    let completedUnits = 0;
    const completed = await processInBatches(
      blockEntries,
      this.#resolveCompositeEntryConcurrency(),
      async (entry) => ({
        entry,
        decodedBlocks: await this.#schedule(async () => {
          const blocks = new Array(entry.blocks.length);
          for (let specIndex = 0; specIndex < entry.blocks.length; specIndex += 1) {
            const block = entry.blocks[specIndex];
            blocks[specIndex] = block ? await this.#loadDecodedBlock(specs[specIndex], block, step) : null;
          }
          return blocks;
        })
      }),
      async (_batch, results) => {
        for (const result of results) {
          this.#compositeRawCompositeBlocks(
            specs,
            result.entry.anchor,
            result.decodedBlocks,
            outputs,
            x0,
            y0,
            safeOutW,
            safeOutH,
            outW,
            step
          );
        }
        completedUnits += results.length;
        if (progress) await progress(completedUnits, completedUnits >= totalUnits);
      },
      cancelled
    );
    if (!completed) return false;
    if (progress && completedUnits < totalUnits) {
      await progress(totalUnits, true);
    }
    return true;
  }

  async #readSparseRawWindow(spec, target, x0, y0, safeOutW, safeOutH, outW, step, minBx, maxBx, centerX, centerY, spanX, spanY, progress = null, cancelled = null) {
    const storageRowBytes = spec.table.blockWidth * spec.bytesPerPixel;
    const numBlocksX = spec.table.numBlocksX;
    const blockHeight = spec.table.blockHeight;
    const batchRows = Math.max(1, Math.floor(APP_CONFIG.tiff.sparseRawRowBatchRows || 1));
    const batchCount = Math.max(1, Math.ceil(safeOutH / batchRows));
    const rowBatches = sortCenterOut(
      Array.from({ length: batchCount }, (_v, index) => index),
      centerX,
      centerY,
      (batchIndex) => {
        const rowStart = batchIndex * batchRows;
        const rowEnd = Math.min(safeOutH, rowStart + batchRows);
        const rowMid = rowStart + ((Math.max(1, rowEnd - rowStart) - 1) * 0.5);
        return { x: centerX, y: y0 + (rowMid * step) };
      },
      spanX,
      spanY
    );
    const blockOrder = orderBlockIndicesCenterOut(minBx, maxBx, spec.table.blockWidth, centerX);
    let completedUnits = 0;
    const completed = await processInBatches(
      rowBatches,
      this.#resolveRawRowConcurrency(),
      async (batchIndex) => this.#schedule(async () => {
        const scratch = new Uint8Array(storageRowBytes);
        const rowStart = batchIndex * batchRows;
        const rowEnd = Math.min(safeOutH, rowStart + batchRows);
        for (let rowIndex = rowStart; rowIndex < rowEnd; rowIndex += 1) {
          if (typeof cancelled === "function" && cancelled()) return;
          const srcY = y0 + (rowIndex * step);
          const by = Math.floor(srcY / blockHeight);
          const rowBase = rowIndex * outW;
          const localYBase = srcY - (by * blockHeight);
          for (const bx of blockOrder) {
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
      }),
      async (_batch) => {
        completedUnits += _batch.length;
        if (progress) await progress(completedUnits, completedUnits >= batchCount);
      },
      cancelled
    );
    if (!completed) return false;
    if (progress && completedUnits < batchCount) {
      await progress(batchCount, true);
    }
    this.#syncCacheStats();
    return true;
  }

  async #readSparseRawCompositeWindow(specs, outputs, x0, y0, safeOutW, safeOutH, outW, step, minBx, maxBx, centerX, centerY, spanX, spanY, progress = null, cancelled = null) {
    const table = specs[0].table;
    const numBlocksX = table.numBlocksX;
    const blockHeight = table.blockHeight;
    const sharedBlocks = specs.every((spec) => spec.blocks === specs[0].blocks);
    const batchRows = Math.max(1, Math.floor(APP_CONFIG.tiff.sparseRawRowBatchRows || 1));
    const batchCount = Math.max(1, Math.ceil(safeOutH / batchRows));
    const rowBatches = sortCenterOut(
      Array.from({ length: batchCount }, (_v, index) => index),
      centerX,
      centerY,
      (batchIndex) => {
        const rowStart = batchIndex * batchRows;
        const rowEnd = Math.min(safeOutH, rowStart + batchRows);
        const rowMid = rowStart + ((Math.max(1, rowEnd - rowStart) - 1) * 0.5);
        return { x: centerX, y: y0 + (rowMid * step) };
      },
      spanX,
      spanY
    );
    const blockOrder = orderBlockIndicesCenterOut(minBx, maxBx, table.blockWidth, centerX);
    let completedUnits = 0;
    const completed = await processInBatches(
      rowBatches,
      this.#resolveRawRowConcurrency(),
      async (batchIndex) => this.#schedule(async () => {
        const scratch = specs.map((spec) => new Uint8Array(table.blockWidth * spec.bytesPerPixel));
        const views = new Array(specs.length);
        const rowStart = batchIndex * batchRows;
        const rowEnd = Math.min(safeOutH, rowStart + batchRows);
        for (let rowIndex = rowStart; rowIndex < rowEnd; rowIndex += 1) {
          if (typeof cancelled === "function" && cancelled()) return;
          const srcY = y0 + (rowIndex * step);
          const by = Math.floor(srcY / blockHeight);
          const rowBase = rowIndex * outW;
          for (const bx of blockOrder) {
            const index = (by * numBlocksX) + bx;
            const blocks = specs.map((spec) => spec.blocks[index] || null);
            const anchor = blocks.find(Boolean) || null;
            if (!anchor) continue;
            const localYBase = srcY - anchor.y0;
            const colStart = Math.max(0, Math.ceil((anchor.x0 - x0) / step));
            const colEnd = Math.min(safeOutW, Math.floor((anchor.x0 + anchor.w - 1 - x0) / step) + 1);
            if (colStart >= colEnd) continue;
            const firstLocalX = x0 + (colStart * step) - anchor.x0;
            const lastLocalX = x0 + ((colEnd - 1) * step) - anchor.x0;

            if (sharedBlocks) {
              const spec = specs[0];
              const storageRowBytes = table.blockWidth * spec.bytesPerPixel;
              const spanBytes = ((lastLocalX - firstLocalX) * spec.bytesPerPixel) + spec.bytesPerPixel;
              const span = scratch[0].subarray(0, spanBytes);
              const readOffset = anchor.offset
                + (localYBase * storageRowBytes)
                + (firstLocalX * spec.bytesPerPixel);
              await this.rawSource.readInto(readOffset, span, 0, spanBytes);
              const dv = new DataView(span.buffer, span.byteOffset, spanBytes);
              for (let col = colStart; col < colEnd; col += 1) {
                const srcX = x0 + (col * step);
                const baseByteOffset = (srcX - anchor.x0 - firstLocalX) * spec.bytesPerPixel;
                for (let channel = 0; channel < specs.length; channel += 1) {
                  outputs[channel][rowBase + col] = readDataViewValue(
                    dv,
                    baseByteOffset + specs[channel].sampleByteOffset,
                    this.meta.dataTypeInfo,
                    this.meta.littleEndian
                  );
                }
              }
              continue;
            }

            views.fill(null);
            for (let channel = 0; channel < specs.length; channel += 1) {
              const spec = specs[channel];
              const block = blocks[channel];
              if (!block) continue;
              const storageRowBytes = table.blockWidth * spec.bytesPerPixel;
              const spanBytes = ((lastLocalX - firstLocalX) * spec.bytesPerPixel) + spec.bytesPerSample;
              const span = scratch[channel].subarray(0, spanBytes);
              const readOffset = block.offset
                + (localYBase * storageRowBytes)
                + (firstLocalX * spec.bytesPerPixel)
                + spec.sampleByteOffset;
              await this.rawSource.readInto(readOffset, span, 0, spanBytes);
              views[channel] = new DataView(span.buffer, span.byteOffset, spanBytes);
            }
            for (let col = colStart; col < colEnd; col += 1) {
              const srcX = x0 + (col * step);
              const localX = srcX - anchor.x0 - firstLocalX;
              for (let channel = 0; channel < specs.length; channel += 1) {
                const spec = specs[channel];
                const dv = views[channel];
                if (!dv) continue;
                outputs[channel][rowBase + col] = readDataViewValue(
                  dv,
                  localX * spec.bytesPerPixel,
                  this.meta.dataTypeInfo,
                  this.meta.littleEndian
                );
              }
            }
          }
        }
      }),
      async (_batch) => {
        completedUnits += _batch.length;
        if (progress) await progress(completedUnits, completedUnits >= batchCount);
      },
      cancelled
    );
    if (!completed) return false;
    if (progress && completedUnits < batchCount) {
      await progress(batchCount, true);
    }
    this.#syncCacheStats();
    return true;
  }

  #compositeRawCompositeBlocks(specs, block, decodedBlocks, outputs, x0, y0, safeOutW, safeOutH, outW, step) {
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
        const localX = srcX - block.x0;
        for (let channel = 0; channel < specs.length; channel += 1) {
          const decoded = decodedBlocks[channel];
          if (!decoded) continue;
          outputs[channel][baseOut + col] = this.#readBlockValue(specs[channel], decoded, localX, localY);
        }
      }
    }
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

  #compositeRgbBlock(block, decoded, outputs, x0, y0, safeOutW, safeOutH, outW, step) {
    const colStart = Math.max(0, Math.ceil((block.x0 - x0) / step));
    const colEnd = Math.min(safeOutW, Math.floor((block.x0 + block.w - 1 - x0) / step) + 1);
    const rowStart = Math.max(0, Math.ceil((block.y0 - y0) / step));
    const rowEnd = Math.min(safeOutH, Math.floor((block.y0 + block.h - 1 - y0) / step) + 1);
    const stride = decoded.kind === "native-rgba" ? 4 : 3;
    for (let row = rowStart; row < rowEnd; row += 1) {
      const srcY = y0 + (row * step);
      const localY = srcY - block.y0;
      const baseOut = row * outW;
      for (let col = colStart; col < colEnd; col += 1) {
        const srcX = x0 + (col * step);
        const { storageX, storageY } = this.#resolveDecodedStoragePoint(decoded, srcX - block.x0, localY);
        const base = ((storageY * decoded.storageWidth) + storageX) * stride;
        outputs[0][baseOut + col] = decoded.data[base];
        outputs[1][baseOut + col] = decoded.data[base + 1];
        outputs[2][baseOut + col] = decoded.data[base + 2];
      }
    }
  }

  #resolveBlockLoadConcurrency(spec) {
    const decodeLike = spec?.kind === "rgb" || spec?.kind === "window" || spec?.kind === "native-rgb-jpeg";
    if (!decodeLike) return Math.max(1, this.ioConcurrency);
    const workerCap = Math.max(1, this.workerPoolSize || 1);
    return Math.max(1, Math.min(this.ioConcurrency, workerCap, this.taskConcurrency));
  }

  #resolveRawRowConcurrency() {
    return Math.max(1, Math.min(this.ioConcurrency, this.taskConcurrency));
  }

  #resolveCompositeEntryConcurrency() {
    return Math.max(1, Math.min(Math.max(1, Math.ceil(this.ioConcurrency / 2)), this.taskConcurrency));
  }

  #schedule(task) {
    return scheduleTiffTask(this.ownerId, task);
  }

  #resolveDecodedStoragePoint(decoded, localX, localY) {
    const srcW = Math.max(1, Number(decoded.sourceWidth) || Number(decoded.storageWidth) || 1);
    const srcH = Math.max(1, Number(decoded.sourceHeight) || Number(decoded.storageHeight) || 1);
    return {
      storageX: Math.max(0, Math.min(
        Math.max(0, Number(decoded.storageWidth) || 1) - 1,
        Math.floor((Math.max(0, localX) * Math.max(1, Number(decoded.storageWidth) || 1)) / srcW)
      )),
      storageY: Math.max(0, Math.min(
        Math.max(0, Number(decoded.storageHeight) || 1) - 1,
        Math.floor((Math.max(0, localY) * Math.max(1, Number(decoded.storageHeight) || 1)) / srcH)
      ))
    };
  }

  #readBlockValue(spec, decoded, localX, localY) {
    const { storageX, storageY } = this.#resolveDecodedStoragePoint(decoded, localX, localY);
    if (decoded.kind === "rgb") {
      return decoded.data[((storageY * decoded.storageWidth) + storageX) * 3 + spec.channel];
    }
    if (decoded.kind === "sample") {
      return decoded.data[(storageY * decoded.storageWidth) + storageX];
    }
    if (decoded.kind === "native-rgba") {
      return decoded.data[((storageY * decoded.storageWidth) + storageX) * 4 + spec.channel];
    }
    const byteOffset = (((localY * decoded.storageWidth) + localX) * spec.bytesPerPixel) + spec.sampleByteOffset;
    return readDataViewValue(decoded.view, byteOffset, this.meta.dataTypeInfo, this.meta.littleEndian);
  }

  #getPool() {
    if (!this.pool) this.pool = getSharedTiffDecodePool(this.workerPoolSize);
    return this.pool;
  }

  #resetPool(force = false) {
    if (!force && !this.pool) return;
    this.pool = null;
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
