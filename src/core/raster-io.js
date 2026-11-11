const HOST_LITTLE_ENDIAN = (() => {
  const b = new ArrayBuffer(2);
  new DataView(b).setUint16(0, 0x00ff, true);
  return new Uint8Array(b)[0] === 0xff;
})();

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const perfNow = () => (
  (typeof performance !== "undefined" && typeof performance.now === "function")
    ? performance.now()
    : Date.now()
);

export function pixelOffset(meta, x, y, b) {
  const bytes = meta.dataTypeInfo.bytes;
  const S = meta.samples;
  const L = meta.lines;
  const B = meta.bands;
  const base = meta.headerOffset;
  if (meta.interleave === "bsq") {
    return base + (((b * L + y) * S + x) * bytes);
  }
  if (meta.interleave === "bil") {
    return base + ((((y * B + b) * S + x) * bytes));
  }
  return base + ((((y * S + x) * B + b) * bytes));
}

export function makeSegmentReader(meta, u8) {
  const info = meta.dataTypeInfo;
  const bytes = info.bytes;
  const little = meta.littleEndian;
  if (info.ctor && little === HOST_LITTLE_ENDIAN && (u8.byteOffset % bytes === 0) && (u8.byteLength % bytes === 0)) {
    const arr = new info.ctor(u8.buffer, u8.byteOffset, u8.byteLength / bytes);
    return { kind: "typed", bytes, arr };
  }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return { kind: "dv", bytes, dv };
}

export function segGet(meta, seg, i) {
  const info = meta.dataTypeInfo;
  if (seg.kind === "typed") return seg.arr[i];
  const o = i * seg.bytes;
  const dv = seg.dv;
  const little = meta.littleEndian;
  switch (info.dv) {
    case "getUint8": return dv.getUint8(o);
    case "getInt16": return dv.getInt16(o, little);
    case "getUint16": return dv.getUint16(o, little);
    case "getInt32": return dv.getInt32(o, little);
    case "getUint32": return dv.getUint32(o, little);
    case "getFloat32": return dv.getFloat32(o, little);
    case "getFloat64": return dv.getFloat64(o, little);
    case "getBigInt64": return Number(dv.getBigInt64(o, little));
    case "getBigUint64": return Number(dv.getBigUint64(o, little));
    default: return dv.getFloat32(o, little);
  }
}

function allocBandArray(meta, n) {
  const info = meta.dataTypeInfo;
  if (info && info.ctor) return new info.ctor(n);
  return new Float64Array(n);
}

function ensureOutputArray(meta, out, n) {
  if (out && typeof out.length === "number" && out.length >= n) return out;
  return allocBandArray(meta, n);
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
      decodedPixels: 0,
      windowReadMs: 0
    };
  }
  return ds.stats.raster;
}

async function fillReadBuffer(ds, offset, scratch, length = scratch.byteLength) {
  const want = Math.max(0, Math.min(scratch.byteLength, Number(length) || 0));
  if (want <= 0) return scratch.subarray(0, 0);
  if (typeof ds?.readInto === "function") {
    const bytesRead = await ds.readInto(offset, scratch, 0, want);
    return scratch.subarray(0, Math.max(0, bytesRead | 0));
  }
  const u8 = await ds.read(offset, want);
  scratch.set(u8.subarray(0, want), 0);
  return scratch.subarray(0, u8.byteLength);
}

async function parallelFor(count, limit, fn, makeState = null) {
  const n = Math.min(Math.max(1, limit | 0), count | 0);
  let next = 0;
  const workers = [];
  for (let w = 0; w < n; w += 1) {
    const state = (typeof makeState === "function") ? makeState(w) : null;
    workers.push((async () => {
      while (true) {
        const i = next++;
        if (i >= count) break;
        await fn(i, state);
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

async function readViaCustomWindowReader(meta, reader, band, x0, y0, outW, outH, step, outArr, options = null) {
  const S = meta.samples;
  const L = meta.lines;
  const safeX0 = clamp(Math.floor(x0), 0, S - 1);
  const safeY0 = clamp(Math.floor(y0), 0, L - 1);
  const maxX = clamp(safeX0 + outW * step, 0, S);
  const maxY = clamp(safeY0 + outH * step, 0, L);
  const safeOutW = Math.floor((maxX - safeX0 + (step - 1)) / step);
  const safeOutH = Math.floor((maxY - safeY0 + (step - 1)) / step);
  if (safeOutW <= 0 || safeOutH <= 0) {
    return { out: outArr, safeOutW: 0, safeOutH: 0 };
  }

  const target = (safeOutW === outW && safeOutH === outH)
    ? outArr
    : allocBandArray(meta, safeOutW * safeOutH);
  const src = await reader(meta, band, safeX0, safeY0, safeOutW, safeOutH, step, target, options) || target;
  if (src !== outArr) {
    for (let row = 0; row < safeOutH; row += 1) {
      const srcStart = row * safeOutW;
      const dstStart = row * outW;
      outArr.set(src.subarray(srcStart, srcStart + safeOutW), dstStart);
    }
  }
  return { out: outArr, safeOutW, safeOutH };
}

async function decodeBandRowSlabs(meta, ds, band, x0, y0, outW, safeOutW, safeOutH, concurrency, outArr) {
  const bytes = meta.dataTypeInfo.bytes;
  const rowStrideBytes = (meta.interleave === "bil")
    ? (meta.bands * meta.samples * bytes)
    : (meta.samples * bytes);
  const segmentBytes = safeOutW * bytes;
  const slabRows = chooseSlabRows(rowStrideBytes, segmentBytes, safeOutH);
  if (slabRows <= 1) return false;

  const groupCount = Math.ceil(safeOutH / slabRows);
  const maxScratchBytes = ((slabRows - 1) * rowStrideBytes) + segmentBytes;
  await parallelFor(groupCount, concurrency, async (groupIndex, workerState) => {
    const rowStart = groupIndex * slabRows;
    const rows = Math.min(slabRows, safeOutH - rowStart);
    const slabBytes = ((rows - 1) * rowStrideBytes) + segmentBytes;
    const y = y0 + rowStart;
    const offset = pixelOffset(meta, x0, y, band);
    const scratch = workerState?.scratch || new Uint8Array(maxScratchBytes);
    const u8 = await fillReadBuffer(ds, offset, scratch, slabBytes);
    for (let localRow = 0; localRow < rows; localRow += 1) {
      const rowByteOffset = localRow * rowStrideBytes;
      const rowBytes = u8.subarray(rowByteOffset, rowByteOffset + segmentBytes);
      const seg = makeSegmentReader(meta, rowBytes);
      const baseOut = (rowStart + localRow) * outW;
      for (let sx = 0; sx < safeOutW; sx += 1) {
        outArr[baseOut + sx] = segGet(meta, seg, sx);
      }
    }
  }, () => ({ scratch: new Uint8Array(maxScratchBytes) }));
  return true;
}

async function decodeBipRowSlabs(meta, ds, band, x0, y0, outW, safeOutW, safeOutH, concurrency, outArr) {
  const bytes = meta.dataTypeInfo.bytes;
  const rowStrideBytes = meta.samples * meta.bands * bytes;
  const segmentBytes = safeOutW * meta.bands * bytes;
  const slabRows = chooseSlabRows(rowStrideBytes, segmentBytes, safeOutH);
  if (slabRows <= 1) return false;

  const groupCount = Math.ceil(safeOutH / slabRows);
  const maxScratchBytes = ((slabRows - 1) * rowStrideBytes) + segmentBytes;
  await parallelFor(groupCount, concurrency, async (groupIndex, workerState) => {
    const rowStart = groupIndex * slabRows;
    const rows = Math.min(slabRows, safeOutH - rowStart);
    const slabBytes = ((rows - 1) * rowStrideBytes) + segmentBytes;
    const y = y0 + rowStart;
    const offset = pixelOffset(meta, x0, y, 0);
    const scratch = workerState?.scratch || new Uint8Array(maxScratchBytes);
    const u8 = await fillReadBuffer(ds, offset, scratch, slabBytes);
    for (let localRow = 0; localRow < rows; localRow += 1) {
      const rowByteOffset = localRow * rowStrideBytes;
      const rowBytes = u8.subarray(rowByteOffset, rowByteOffset + segmentBytes);
      const seg = makeSegmentReader(meta, rowBytes);
      const baseOut = (rowStart + localRow) * outW;
      for (let sx = 0; sx < safeOutW; sx += 1) {
        outArr[baseOut + sx] = segGet(meta, seg, (sx * meta.bands) + band);
      }
    }
  }, () => ({ scratch: new Uint8Array(maxScratchBytes) }));
  return true;
}

export async function readBandWindow(meta, ds, band, x0, y0, outW, outH, step, concurrency = 2, out = null, options = null) {
  const outArr = ensureOutputArray(meta, out, outW * outH);
  const stats = ensureRasterStats(ds);
  const t0 = perfNow();
  if (stats) stats.windowCalls += 1;

  if (typeof ds?.readBandWindow === "function") {
    const custom = await readViaCustomWindowReader(meta, ds.readBandWindow.bind(ds), band, x0, y0, outW, outH, step, outArr, options);
    if (stats) {
      stats.rowWindowCalls += 1;
      stats.decodedPixels += custom.safeOutW * custom.safeOutH;
      stats.windowReadMs += perfNow() - t0;
    }
    return custom.out;
  }

  const bytes = meta.dataTypeInfo.bytes;
  const S = meta.samples;
  const L = meta.lines;

  if (meta.interleave === "bip") {
    throw new Error("readBandWindow not used for BIP");
  }

  x0 = clamp(Math.floor(x0), 0, S - 1);
  y0 = clamp(Math.floor(y0), 0, L - 1);

  const maxX = clamp(x0 + outW * step, 0, S);
  const maxY = clamp(y0 + outH * step, 0, L);
  const safeOutW = Math.floor((maxX - x0 + (step - 1)) / step);
  const safeOutH = Math.floor((maxY - y0 + (step - 1)) / step);
  if (step === 1 && safeOutW > 0 && safeOutH > 1) {
    const usedSlabs = await decodeBandRowSlabs(meta, ds, band, x0, y0, outW, safeOutW, safeOutH, concurrency, outArr);
    if (usedSlabs) {
      if (stats) {
        stats.slabWindowCalls += 1;
        stats.decodedPixels += safeOutW * safeOutH;
        stats.windowReadMs += perfNow() - t0;
      }
      return outArr;
    }
  }
  const spanPixels = safeOutW * step;
  const rowBytes = spanPixels * bytes;

  const rowWorker = async (sy, workerState) => {
    const y = y0 + sy * step;
    const rowOffset = pixelOffset(meta, x0, y, band);
    const scratch = workerState?.scratch || new Uint8Array(rowBytes);
    const u8 = await fillReadBuffer(ds, rowOffset, scratch, rowBytes);
    const seg = makeSegmentReader(meta, u8);
    const baseOut = sy * outW;
    for (let sx = 0; sx < safeOutW; sx += 1) {
      outArr[baseOut + sx] = segGet(meta, seg, sx * step);
    }
  };

  await parallelFor(safeOutH, concurrency, rowWorker, () => ({ scratch: new Uint8Array(rowBytes) }));
  if (stats) {
    stats.rowWindowCalls += 1;
    stats.decodedPixels += safeOutW * safeOutH;
    stats.windowReadMs += perfNow() - t0;
  }
  return outArr;
}

export async function readBandWindowBIP(meta, ds, band, x0, y0, outW, outH, step, concurrency = 2, out = null, options = null) {
  const outArr = ensureOutputArray(meta, out, outW * outH);
  const stats = ensureRasterStats(ds);
  const t0 = perfNow();
  if (stats) {
    stats.windowCalls += 1;
    stats.bipWindowCalls += 1;
  }

  const customReader = (typeof ds?.readBandWindowBIP === "function")
    ? ds.readBandWindowBIP.bind(ds)
    : ((typeof ds?.readBandWindow === "function") ? ds.readBandWindow.bind(ds) : null);
  if (customReader) {
    const custom = await readViaCustomWindowReader(meta, customReader, band, x0, y0, outW, outH, step, outArr, options);
    if (stats) {
      stats.rowWindowCalls += 1;
      stats.decodedPixels += custom.safeOutW * custom.safeOutH;
      stats.windowReadMs += perfNow() - t0;
    }
    return custom.out;
  }

  const S = meta.samples;
  const L = meta.lines;
  const B = meta.bands;

  x0 = clamp(Math.floor(x0), 0, S - 1);
  y0 = clamp(Math.floor(y0), 0, L - 1);

  const maxX = clamp(x0 + outW * step, 0, S);
  const maxY = clamp(y0 + outH * step, 0, L);
  const safeOutW = Math.floor((maxX - x0 + (step - 1)) / step);
  const safeOutH = Math.floor((maxY - y0 + (step - 1)) / step);
  if (step === 1 && safeOutW > 0 && safeOutH > 1) {
    const usedSlabs = await decodeBipRowSlabs(meta, ds, band, x0, y0, outW, safeOutW, safeOutH, concurrency, outArr);
    if (usedSlabs) {
      if (stats) {
        stats.slabWindowCalls += 1;
        stats.decodedPixels += safeOutW * safeOutH;
        stats.windowReadMs += perfNow() - t0;
      }
      return outArr;
    }
  }
  const spanPixels = safeOutW * step;
  const rowBytes = spanPixels * B * meta.dataTypeInfo.bytes;

  const rowWorker = async (sy, workerState) => {
    const y = y0 + sy * step;
    const scratch = workerState?.scratch || new Uint8Array(rowBytes);
    const rowOffset = pixelOffset(meta, x0, y, 0);
    const u8 = await fillReadBuffer(ds, rowOffset, scratch, rowBytes);
    const seg = makeSegmentReader(meta, u8);
    const baseOut = sy * outW;
    for (let sx = 0; sx < safeOutW; sx += 1) {
      const rawPix = sx * step;
      const idx = rawPix * B + band;
      outArr[baseOut + sx] = segGet(meta, seg, idx);
    }
  };

  await parallelFor(safeOutH, concurrency, rowWorker, () => ({ scratch: new Uint8Array(rowBytes) }));
  if (stats) {
    stats.rowWindowCalls += 1;
    stats.decodedPixels += safeOutW * safeOutH;
    stats.windowReadMs += perfNow() - t0;
  }
  return outArr;
}

export function toFloat32(arr, out = null) {
  if (arr instanceof Float32Array && (!out || out === arr)) return arr;
  const length = Math.max(0, Number(arr?.length) || 0);
  const dst = (out instanceof Float32Array && out.length >= length) ? out : new Float32Array(length);
  if (arr instanceof Float32Array) {
    if (arr !== dst) dst.set(arr, 0);
    return dst;
  }
  for (let i = 0; i < length; i += 1) dst[i] = Number(arr[i]);
  return dst;
}
