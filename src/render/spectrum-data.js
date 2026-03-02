import { makeSegmentReader, pixelOffset, segGet } from "../core/raster-io.js";

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

export async function probeValueAtBand(ds, ix, iy, band) {
  const m = ds.meta;
  if (ix < 0 || iy < 0 || ix >= m.samples || iy >= m.lines) return null;
  const bytes = m.dataTypeInfo.bytes;
  const offset = pixelOffset(m, ix, iy, band);
  const u8 = await ds.ds.read(offset, bytes);
  const seg = makeSegmentReader(m, u8);
  return Number(segGet(m, seg, 0));
}

export async function readSpectrumAtPixel(ds, ix, iy, concurrency = 2) {
  const meta = ds.meta;
  const B = meta.bands;
  const bytes = meta.dataTypeInfo.bytes;
  const out = new Float32Array(B);

  if (meta.interleave === "bip") {
    const off = pixelOffset(meta, ix, iy, 0);
    const u8 = await ds.ds.read(off, B * bytes);
    const seg = makeSegmentReader(meta, u8);
    for (let b = 0; b < B; b += 1) {
      out[b] = Number(segGet(meta, seg, b));
    }
    return out;
  }

  await parallelFor(B, concurrency, async (b) => {
    const off = pixelOffset(meta, ix, iy, b);
    const u8 = await ds.ds.read(off, bytes);
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
    const n = Number(wl[i]);
    if (!Number.isFinite(n)) return null;
    out[i] = n;
  }
  return out;
}
