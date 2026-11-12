import { makeSegmentReader, pixelOffset, segGet } from "../core/raster-io.js";

function abortError() {
  const error = new Error("Read cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfCancelled(options) {
  if (options?.signal?.aborted || (typeof options?.cancelled === "function" && options.cancelled())) throw abortError();
}

async function parallelFor(count, limit, fn) {
  const n = Math.min(Math.max(1, limit | 0), count | 0);
  let next = 0;
  const workers = [];
  for (let w = 0; w < n; w += 1) {
    workers.push((async () => {
      while (true) {
        const i = next++;
        if (i >= count) break;
        await fn(i);
      }
    })());
  }
  await Promise.all(workers);
}

export async function probeValueAtBand(ds, ix, iy, band, options = null) {
  throwIfCancelled(options);
  const m = ds.meta;
  if (ix < 0 || iy < 0 || ix >= m.samples || iy >= m.lines) return null;
  if (typeof ds?.ds?.probeValueAtBand === "function") {
    return options ? ds.ds.probeValueAtBand(m, ix, iy, band, options) : ds.ds.probeValueAtBand(m, ix, iy, band);
  }
  if (typeof ds?.ds?.readBandWindow === "function") {
    const out = options ? await ds.ds.readBandWindow(m, band, ix, iy, 1, 1, 1, null, options)
      : await ds.ds.readBandWindow(m, band, ix, iy, 1, 1, 1);
    return Number(out?.[0]);
  }
  const bytes = m.dataTypeInfo.bytes;
  const offset = pixelOffset(m, ix, iy, band);
  const u8 = await ds.ds.read(offset, bytes);
  const seg = makeSegmentReader(m, u8);
  return Number(segGet(m, seg, 0));
}

export async function readSpectrumAtPixel(ds, ix, iy, concurrency = 2, options = null) {
  const meta = ds.meta;
  const B = meta.bands;
  throwIfCancelled(options);
  if (ds.ds?.maxWindowResultBytes != null
      && (!Number.isSafeInteger(B * Float32Array.BYTES_PER_ELEMENT)
          || B * Float32Array.BYTES_PER_ELEMENT > ds.ds.maxWindowResultBytes)) {
    throw new RangeError(`Spectrum exceeds the ${ds.ds.maxWindowResultBytes}-byte output limit.`);
  }
  if (ix < 0 || iy < 0 || ix >= meta.samples || iy >= meta.lines) {
    return new Float32Array(B);
  }
  if (typeof ds?.ds?.readSpectrumAtPixel === "function") {
    return options
      ? ds.ds.readSpectrumAtPixel(meta, ix, iy, concurrency, options)
      : ds.ds.readSpectrumAtPixel(meta, ix, iy, concurrency);
  }
  const bytes = meta.dataTypeInfo.bytes;
  const out = new Float32Array(B);

  if (meta.interleave === "bip") {
    const off = pixelOffset(meta, ix, iy, 0);
    const u8 = await ds.ds.read(off, B * bytes, options || {});
    throwIfCancelled(options);
    const seg = makeSegmentReader(meta, u8);
    for (let b = 0; b < B; b += 1) {
      out[b] = Number(segGet(meta, seg, b));
    }
    return out;
  }

  await parallelFor(B, concurrency, async (b) => {
    throwIfCancelled(options);
    const off = pixelOffset(meta, ix, iy, b);
    const u8 = await ds.ds.read(off, bytes, options || {});
    throwIfCancelled(options);
    const seg = makeSegmentReader(meta, u8);
    out[b] = Number(segGet(meta, seg, 0));
  });

  return out;
}

export function wavelengthArrayOrNull(ds) {
  const wl = ds.meta.wavelengths;
  if (!Array.isArray(wl) || wl.length !== ds.meta.bands) return null;
  const out = new Array(wl.length);
  for (let i = 0; i < wl.length; i += 1) {
    const n = parseSpectralNumber(wl[i]);
    if (!Number.isFinite(n)) return null;
    out[i] = n;
  }
  return out;
}

function parseSpectralNumber(v) {
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  if (typeof v !== "string") return Number.NaN;
  const s = v.trim().replace(/,/g, "");
  if (!s) return Number.NaN;
  const m = s.match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/);
  if (!m) return Number.NaN;
  const parsed = Number(m[0]);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
