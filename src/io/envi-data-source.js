import { APP_CONFIG } from "../app/config.js";
import { makeSegmentReader, pixelOffset, segGet } from "../core/raster-io.js";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function allocateOutput(meta, out, length) {
  if (out && typeof out.length === "number" && out.length >= length) return out;
  const Ctor = meta?.dataTypeInfo?.ctor || Float64Array;
  return new Ctor(length);
}

function ensureRasterStats(ds) {
  if (!ds || (typeof ds !== "object" && typeof ds !== "function")) return null;
  if (!ds.stats || typeof ds.stats !== "object") ds.stats = {};
  if (!ds.stats.raster) {
    ds.stats.raster = {
      windowCalls: 0,
      bipWindowCalls: 0,
      slabWindowCalls: 0,
      rowWindowCalls: 0,
      compositeWindowCalls: 0,
      decodedPixels: 0,
      windowReadMs: 0
    };
  } else if (!Number.isFinite(Number(ds.stats.raster.compositeWindowCalls))) {
    ds.stats.raster.compositeWindowCalls = 0;
  }
  return ds.stats.raster;
}

function perfNow() {
  return (typeof performance !== "undefined" && typeof performance.now === "function")
    ? performance.now()
    : Date.now();
}

function fillReadBuffer(source, offset, scratch, length = scratch.byteLength) {
  const want = Math.max(0, Math.min(scratch.byteLength, Number(length) || 0));
  if (want <= 0) return Promise.resolve(scratch.subarray(0, 0));
  if (typeof source?.readInto === "function") {
    return source.readInto(offset, scratch, 0, want).then((bytesRead) => (
      scratch.subarray(0, Math.max(0, bytesRead | 0))
    ));
  }
  return source.read(offset, want).then((u8) => {
    scratch.set(u8.subarray(0, want), 0);
    return scratch.subarray(0, u8.byteLength);
  });
}

async function parallelFor(count, limit, fn, makeState = null) {
  const n = Math.min(Math.max(1, limit | 0), count | 0);
  let next = 0;
  const workers = [];
  for (let index = 0; index < n; index += 1) {
    const state = (typeof makeState === "function") ? makeState(index) : null;
    workers.push((async () => {
      while (true) {
        const current = next++;
        if (current >= count) break;
        await fn(current, state);
      }
    })());
  }
  await Promise.all(workers);
}

function chooseSlabRows(rowStrideBytes, segmentBytes, remainingRows, targetBytes = 512 * 1024, maxOverreadRatio = 2) {
  const stride = Math.max(1, Math.floor(Number(rowStrideBytes) || 1));
  const segment = Math.max(1, Math.floor(Number(segmentBytes) || 1));
  const totalRows = Math.max(1, Math.floor(Number(remainingRows) || 1));
  const maxRowsBySize = Math.max(1, Math.floor((targetBytes - segment) / stride) + 1);
  let rows = Math.min(totalRows, maxRowsBySize);
  while (rows > 1) {
    const slabBytes = ((rows - 1) * stride) + segment;
    if (slabBytes <= (rows * segment * maxOverreadRatio)) return rows;
    rows -= 1;
  }
  return 1;
}

function resolveReadOptions(outOrOptions = null, maybeOptions = null) {
  if (
    outOrOptions
    && typeof outOrOptions === "object"
    && !Array.isArray(outOrOptions)
    && !ArrayBuffer.isView(outOrOptions)
    && maybeOptions == null
  ) {
    return { out: null, options: outOrOptions };
  }
  return {
    out: outOrOptions,
    options: (
      maybeOptions
      && typeof maybeOptions === "object"
      && !Array.isArray(maybeOptions)
      && !ArrayBuffer.isView(maybeOptions)
    )
      ? maybeOptions
      : null
  };
}

function safeWindow(meta, x0, y0, outW, outH, step) {
  const samples = Math.max(1, Number(meta?.samples) || 1);
  const lines = Math.max(1, Number(meta?.lines) || 1);
  const safeStep = Math.max(1, Math.floor(Number(step) || 1));
  const safeX0 = clamp(Math.floor(x0), 0, samples - 1);
  const safeY0 = clamp(Math.floor(y0), 0, lines - 1);
  const maxX = clamp(safeX0 + (Math.max(0, Math.floor(Number(outW) || 0)) * safeStep), 0, samples);
  const maxY = clamp(safeY0 + (Math.max(0, Math.floor(Number(outH) || 0)) * safeStep), 0, lines);
  const safeOutW = Math.floor((maxX - safeX0 + (safeStep - 1)) / safeStep);
  const safeOutH = Math.floor((maxY - safeY0 + (safeStep - 1)) / safeStep);
  return {
    x0: safeX0,
    y0: safeY0,
    outW: Math.max(0, safeOutW),
    outH: Math.max(0, safeOutH),
    step: safeStep
  };
}

function computePreviewFactor(estimatedBytes) {
  const maxBytes = Math.max(1, Number(APP_CONFIG.render.previewMaxReadBytes) || 1);
  if (!Number.isFinite(estimatedBytes) || estimatedBytes <= maxBytes) return 1;
  return clamp(
    Math.ceil(estimatedBytes / maxBytes),
    1,
    Math.max(1, Number(APP_CONFIG.render.tiffPreviewMaxFactor) || 1)
  );
}

export class EnviDataSource {
  constructor(source, meta) {
    this.source = source;
    this.meta = meta;
    this.ownerId = source?.ownerId || "";
    this.chunkSize = Number(source?.chunkSize) || APP_CONFIG.io.defaultChunkSizeBytes;
    this.stats = source?.stats || { bytesRead: 0 };
  }

  get maxBytes() {
    return Number(this.source?.maxBytes) || 0;
  }

  get concurrency() {
    return Number(this.source?.concurrency) || APP_CONFIG.io.defaultConcurrency;
  }

  setConcurrency(next) {
    if (this.source && typeof this.source.setConcurrency === "function") {
      this.source.setConcurrency(next);
    }
  }

  setMaxBytes(next) {
    if (this.source && typeof this.source.setMaxBytes === "function") {
      this.source.setMaxBytes(next);
    }
  }

  cacheBytes() {
    return (this.source && typeof this.source.cacheBytes === "function")
      ? this.source.cacheBytes()
      : 0;
  }

  clear() {
    if (this.source && typeof this.source.clear === "function") this.source.clear();
  }

  close() {
    if (this.source && typeof this.source.close === "function") this.source.close();
    this.source = null;
  }

  read(offset, length) {
    return this.source.read(offset, length);
  }

  readInto(offset, dest, destOffset = 0, length = null) {
    return this.source.readInto(offset, dest, destOffset, length);
  }

  visitPages(offset, length, visitor) {
    return this.source.visitPages(offset, length, visitor);
  }

  hasNativeOverviews() {
    return false;
  }

  supportsCompositeWindow() {
    return Number(this.meta?.bands || 0) >= 3;
  }

  estimateReadWork(meta, band, x0, y0, outW, outH, step) {
    const window = safeWindow(meta, x0, y0, outW, outH, step);
    const bytes = Number(meta?.dataTypeInfo?.bytes) || 1;
    const samples = Math.max(1, Number(meta?.samples) || 1);
    const bands = Math.max(1, Number(meta?.bands) || 1);
    if (window.outW <= 0 || window.outH <= 0) {
      return {
        estimatedBytes: 0,
        spanReads: 0,
        sparseRaw: false,
        previewFactor: 1
      };
    }

    let rowBytes = window.outW * window.step * bytes;
    if (meta?.interleave === "bip") {
      rowBytes *= bands;
    } else if (meta?.interleave === "bil" && window.step === 1) {
      rowBytes = window.outW * bytes;
    } else if (meta?.interleave === "bil") {
      rowBytes = window.outW * window.step * bytes;
    }
    const estimatedBytes = rowBytes * window.outH;
    const sparseRaw = meta?.interleave === "bip" && bands > 4 && window.step > 1;
    const spanReads = window.outH;
    const rowStrideBytes = (meta?.interleave === "bip")
      ? (samples * bands * bytes)
      : (samples * bytes);
    const slabRows = chooseSlabRows(rowStrideBytes, Math.max(bytes, rowBytes), window.outH);
    return {
      estimatedBytes,
      spanReads,
      sparseRaw,
      slabRows,
      previewFactor: (meta?.interleave === "bip" && bands > 4)
        ? computePreviewFactor(estimatedBytes)
        : 1
    };
  }

  estimateCompositeReadWork(meta, x0, y0, outW, outH, step, bands = [0, 1, 2]) {
    const window = safeWindow(meta, x0, y0, outW, outH, step);
    const bytes = Number(meta?.dataTypeInfo?.bytes) || 1;
    const totalBands = Math.max(1, Number(meta?.bands) || 1);
    const selectedBands = Array.isArray(bands) && bands.length
      ? bands.filter((band) => Number.isFinite(Number(band)))
      : [0, 1, 2];
    if (window.outW <= 0 || window.outH <= 0) {
      return {
        estimatedBytes: 0,
        spanReads: 0,
        sparseRaw: false,
        previewFactor: 1
      };
    }

    let estimatedBytes;
    if (meta?.interleave === "bip") {
      estimatedBytes = window.outW * window.outH * window.step * totalBands * bytes;
    } else {
      const bandCount = Math.max(1, selectedBands.length);
      estimatedBytes = window.outW * window.outH * window.step * bytes * bandCount;
    }
    return {
      estimatedBytes,
      spanReads: window.outH,
      sparseRaw: meta?.interleave === "bip" && totalBands > 4 && window.step > 1,
      previewFactor: (meta?.interleave === "bip" && totalBands > 4)
        ? computePreviewFactor(estimatedBytes)
        : 1
    };
  }

  async readCompositeWindow(meta, x0, y0, outW, outH, step, outOrOptions = null, maybeOptions = null) {
    const resolved = resolveReadOptions(outOrOptions, maybeOptions);
    const selectedBands = [0, 1, 2].map((value) => clamp(value, 0, Math.max(0, Number(meta?.bands || 1) - 1)));
    const window = safeWindow(meta, x0, y0, outW, outH, step);
    const outputs = selectedBands.map((band, index) => (
      allocateOutput(meta, Array.isArray(resolved.out) ? resolved.out[index] : null, outW * outH)
    ));
    if (window.outW <= 0 || window.outH <= 0) {
      return { bands: outputs, width: outW, height: outH };
    }

    const stats = ensureRasterStats(this);
    const t0 = perfNow();
    if (stats) {
      stats.windowCalls += 1;
      stats.compositeWindowCalls += 1;
      if (meta?.interleave === "bip") stats.bipWindowCalls += 1;
    }
    const onProgress = typeof resolved.options?.onProgress === "function" ? resolved.options.onProgress : null;
    const cancelled = typeof resolved.options?.cancelled === "function" ? resolved.options.cancelled : null;

    if (onProgress) {
      for (const output of outputs) output.fill(Number.NaN);
    }

    if (meta?.interleave === "bip") {
      await this.#readCompositeWindowBIP(meta, window, selectedBands, outputs, outW, { onProgress, cancelled });
    } else {
      await this.#readCompositeWindowByBand(meta, window, selectedBands, outputs, outW, { onProgress, cancelled });
    }
    if (cancelled && cancelled()) return null;

    if (stats) {
      stats.decodedPixels += window.outW * window.outH * outputs.length;
      stats.windowReadMs += perfNow() - t0;
    }
    return {
      bands: outputs,
      width: outW,
      height: outH
    };
  }

  async #readCompositeWindowByBand(meta, window, selectedBands, outputs, outW, options = {}) {
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    const cancelled = typeof options.cancelled === "function" ? options.cancelled : null;
    for (let index = 0; index < selectedBands.length; index += 1) {
      if (cancelled && cancelled()) return null;
      const band = selectedBands[index];
      const target = outputs[index];
      const raw = await this.#readSingleBandWindow(meta, band, window, outW, target);
      if (raw !== target) target.set(raw.subarray(0, target.length), 0);
      if (onProgress) {
        await onProgress({
          bands: outputs,
          width: outW,
          height: window.outH,
          partial: index < (selectedBands.length - 1)
        });
      }
    }
    return outputs;
  }

  async #readSingleBandWindow(meta, band, window, outW, target) {
    if (meta?.interleave === "bip") {
      throw new Error("Unexpected single-band BIP composite path.");
    }
    const bytes = Number(meta?.dataTypeInfo?.bytes) || 1;
    const rowBytes = window.outW * window.step * bytes;
    await parallelFor(
      window.outH,
      Math.max(1, this.concurrency),
      async (rowIndex, workerState) => {
        const y = window.y0 + (rowIndex * window.step);
        const rowOffset = pixelOffset(meta, window.x0, y, band);
        const scratch = workerState?.scratch || new Uint8Array(rowBytes);
        const u8 = await fillReadBuffer(this.source, rowOffset, scratch, rowBytes);
        const seg = makeSegmentReader(meta, u8);
        const baseOut = rowIndex * outW;
        for (let sx = 0; sx < window.outW; sx += 1) {
          target[baseOut + sx] = segGet(meta, seg, sx * window.step);
        }
      },
      () => ({ scratch: new Uint8Array(rowBytes) })
    );
    return target;
  }

  async #readCompositeWindowBIP(meta, window, selectedBands, outputs, outW, options = {}) {
    const bytes = Number(meta?.dataTypeInfo?.bytes) || 1;
    const bandCount = Math.max(1, Number(meta?.bands) || 1);
    const rowStrideBytes = Number(meta?.samples || 0) * bandCount * bytes;
    const segmentBytes = window.outW * window.step * bandCount * bytes;
    const slabRows = (window.step === 1 && window.outH > 1)
      ? chooseSlabRows(rowStrideBytes, Math.max(segmentBytes, bandCount * bytes), window.outH)
      : 1;
    const groupRows = Math.max(1, slabRows);
    const groupCount = Math.ceil(window.outH / groupRows);
    const maxScratchBytes = ((groupRows - 1) * rowStrideBytes) + segmentBytes;
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    const cancelled = typeof options.cancelled === "function" ? options.cancelled : null;

    await parallelFor(
      groupCount,
      Math.max(1, Math.min(this.concurrency, groupCount)),
      async (groupIndex, workerState) => {
        if (cancelled && cancelled()) return;
        const rowStart = groupIndex * groupRows;
        const rows = Math.min(groupRows, window.outH - rowStart);
        const slabBytes = ((rows - 1) * rowStrideBytes) + segmentBytes;
        const y = window.y0 + (rowStart * window.step);
        const offset = pixelOffset(meta, window.x0, y, 0);
        const scratch = workerState?.scratch || new Uint8Array(maxScratchBytes);
        const u8 = await fillReadBuffer(this.source, offset, scratch, slabBytes);
        for (let localRow = 0; localRow < rows; localRow += 1) {
          if (cancelled && cancelled()) return;
          const rowByteOffset = localRow * rowStrideBytes;
          const rowBytes = u8.subarray(rowByteOffset, rowByteOffset + segmentBytes);
          const seg = makeSegmentReader(meta, rowBytes);
          const baseOut = (rowStart + localRow) * outW;
          for (let sx = 0; sx < window.outW; sx += 1) {
            const baseIndex = sx * window.step * bandCount;
            outputs[0][baseOut + sx] = segGet(meta, seg, baseIndex + selectedBands[0]);
            outputs[1][baseOut + sx] = segGet(meta, seg, baseIndex + selectedBands[1]);
            outputs[2][baseOut + sx] = segGet(meta, seg, baseIndex + selectedBands[2]);
          }
        }
      },
      () => ({ scratch: new Uint8Array(maxScratchBytes) })
    );

    if (onProgress) {
      await onProgress({
        bands: outputs,
        width: outW,
        height: window.outH,
        partial: false
      });
    }
    return outputs;
  }
}
