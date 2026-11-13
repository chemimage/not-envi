import { tone01 } from "../../src/render/display-math.js";

// Original production pixel loop, retained as the experiment's reference.
export function reference(rasters, params, dst, w, rect, transparent) {
  for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) {
    const i = y * w + x, pixel = i * 4;
    if (transparent && rasters.some(r => !Number.isFinite(r.dataF32[i]))) { dst.fill(0, pixel, pixel + 4); continue; }
    for (let c = 0; c < 3; c++) {
      const p = params[c];
      dst[pixel + c] = Math.round(tone01(rasters[c].dataF32[i], p.minVal, p.maxVal, p.brightness, p.gain, p.contrast) * 255);
    }
    dst[pixel + 3] = 255;
  }
}

// Hoist channel state, use one predictable loop per plane, and preserve the
// reference operation order (especially division and explicit Math.round).
export function planar(rasters, params, dst, w, rect, transparent) {
  for (let c = 0; c < 3; c++) {
    const source = rasters[c].dataF32, p = params[c];
    const min = p.minVal, span = p.maxVal - min, contrast = p.contrast, brightness = p.brightness, gain = p.gain;
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      const end = y * w + rect.x + rect.w;
      for (let i = y * w + rect.x; i < end; i++) {
        let v = Math.min(1, Math.max(0, (source[i] - min) / span));
        v = (v - 0.5) * contrast + 0.5;
        v = (v + brightness) * gain;
        dst[i * 4 + c] = Math.round(Math.min(1, Math.max(0, v)) * 255);
      }
    }
  }
  const r = rasters[0].dataF32, g = rasters[1].dataF32, b = rasters[2].dataF32;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    const end = y * w + rect.x + rect.w;
    for (let i = y * w + rect.x; i < end; i++) {
      const pixel = i * 4;
      if (transparent && (!Number.isFinite(r[i]) || !Number.isFinite(g[i]) || !Number.isFinite(b[i]))) {
        dst[pixel] = 0; dst[pixel + 1] = 0; dst[pixel + 2] = 0; dst[pixel + 3] = 0;
      } else dst[pixel + 3] = 255;
    }
  }
}

function byte(v, min, span, contrast, brightness, gain) {
  let x = Math.min(1, Math.max(0, (v - min) / span));
  x = (x - 0.5) * contrast + 0.5;
  x = (x + brightness) * gain;
  return Math.round(Math.min(1, Math.max(0, x)) * 255);
}

export function fused(rasters, params, dst, w, rect, transparent) {
  const r = rasters[0].dataF32, g = rasters[1].dataF32, b = rasters[2].dataF32;
  const [pr, pg, pb] = params;
  const rm = pr.minVal, rs = pr.maxVal - rm, rc = pr.contrast, rb = pr.brightness, rg = pr.gain;
  const gm = pg.minVal, gs = pg.maxVal - gm, gc = pg.contrast, gb = pg.brightness, gg = pg.gain;
  const bm = pb.minVal, bs = pb.maxVal - bm, bc = pb.contrast, bb = pb.brightness, bg = pb.gain;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    const end = y * w + rect.x + rect.w;
    for (let i = y * w + rect.x; i < end; i++) {
      const pixel = i * 4, vr = r[i], vg = g[i], vb = b[i];
      if (transparent && (!Number.isFinite(vr) || !Number.isFinite(vg) || !Number.isFinite(vb))) {
        dst[pixel] = 0; dst[pixel + 1] = 0; dst[pixel + 2] = 0; dst[pixel + 3] = 0;
      } else {
        dst[pixel] = byte(vr, rm, rs, rc, rb, rg);
        dst[pixel + 1] = byte(vg, gm, gs, gc, gb, gg);
        dst[pixel + 2] = byte(vb, bm, bs, bc, bb, bg);
        dst[pixel + 3] = 255;
      }
    }
  }
}
