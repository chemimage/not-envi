const HOST_LITTLE_ENDIAN = (() => {
  const b = new ArrayBuffer(2);
  new DataView(b).setUint16(0, 0x00ff, true);
  return new Uint8Array(b)[0] === 0xff;
})();

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

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

export async function readBandWindow(meta, ds, band, x0, y0, outW, outH, step, concurrency = 2, out = null) {
  const bytes = meta.dataTypeInfo.bytes;
  const S = meta.samples;
  const L = meta.lines;
  const outArr = ensureOutputArray(meta, out, outW * outH);

  if (meta.interleave === "bip") {
    throw new Error("readBandWindow not used for BIP");
  }

  x0 = clamp(Math.floor(x0), 0, S - 1);
  y0 = clamp(Math.floor(y0), 0, L - 1);

  const maxX = clamp(x0 + outW * step, 0, S);
  const maxY = clamp(y0 + outH * step, 0, L);
  const safeOutW = Math.floor((maxX - x0 + (step - 1)) / step);
  const safeOutH = Math.floor((maxY - y0 + (step - 1)) / step);
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
  return outArr;
}

export async function readBandWindowBIP(meta, ds, band, x0, y0, outW, outH, step, concurrency = 2, out = null) {
  const S = meta.samples;
  const L = meta.lines;
  const B = meta.bands;
  const outArr = ensureOutputArray(meta, out, outW * outH);

  x0 = clamp(Math.floor(x0), 0, S - 1);
  y0 = clamp(Math.floor(y0), 0, L - 1);

  const maxX = clamp(x0 + outW * step, 0, S);
  const maxY = clamp(y0 + outH * step, 0, L);
  const safeOutW = Math.floor((maxX - x0 + (step - 1)) / step);
  const safeOutH = Math.floor((maxY - y0 + (step - 1)) / step);
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
  return outArr;
}

export function toFloat32(arr) {
  if (arr instanceof Float32Array) return arr;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i += 1) out[i] = Number(arr[i]);
  return out;
}
