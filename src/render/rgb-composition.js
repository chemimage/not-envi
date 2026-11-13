import { mergeDirtyRects } from "./incremental-composition.js";

/** Retained RGBA canvases. Exact revision continuity permits dirty updates;
 * skipped revisions, changed tone parameters, or untracked/direct rasters force
 * a complete recolor. Canvas presentation can still scale/blit the full image.
 * Factories keep the pixel algorithm testable and usable by a future worker. */
export function createRgbCompositor({ createCanvas, createImageData, tone01, colorize, maxBytes = 64 * 1024 * 1024 }) {
  const entries = new Map();
  const stats = { pixelsColored: 0, fullUpdates: 0, patchUpdates: 0, bytes: 0 };
  const clear = () => { entries.clear(); stats.bytes = 0; };
  function compose(rasters, params, { transparentNoData = false } = {}) {
    if (!Array.isArray(rasters) || rasters.length < 3 || rasters.some((raster) => !raster)) return;
    const { w, h } = rasters[0];
    const tracked = rasters.every((raster) => Number.isSafeInteger(raster.compositionId)
      && Number.isSafeInteger(raster.revision) && raster.w === w && raster.h === h);
    const key = `${tracked ? rasters.map((raster) => raster.compositionId).join(",") : "direct"}:${w}:${h}:${transparentNoData}`;
    let entry = entries.get(key);
    if (entry) entries.delete(key);
    const fresh = !entry;
    if (!entry) {
      const canvas = createCanvas(); canvas.width = w; canvas.height = h;
      entry = { canvas, ctx: canvas.getContext("2d", { alpha: transparentNoData }), image: createImageData(w, h), revisions: [] };
    }
    const paramsKey = JSON.stringify(params);
    let full = fresh || !tracked || entry.paramsKey !== paramsKey;
    const damage = [];
    if (!full) for (let channel = 0; channel < 3; channel += 1) {
      const raster = rasters[channel];
      if (entry.revisions[channel] === raster.revision) continue;
      if (entry.revisions[channel] !== raster.previousRevision) { full = true; break; }
      damage.push(...raster.dirtyRects);
    }
    const rectangles = full ? [{ x: 0, y: 0, w, h }] : mergeDirtyRects(damage);
    const dst = entry.image.data;
    for (const rect of rectangles) {
      if (colorize) colorize(rasters, params, dst, w, rect, transparentNoData);
      else {
        for (let y = rect.y; y < rect.y + rect.h; y += 1) for (let x = rect.x; x < rect.x + rect.w; x += 1) {
          const index = y * w + x, pixel = index * 4;
          if (transparentNoData && rasters.some((raster) => !Number.isFinite(raster.dataF32[index]))) {
            dst.fill(0, pixel, pixel + 4); continue;
          }
          for (let channel = 0; channel < 3; channel += 1) {
            const p = params[channel];
            dst[pixel + channel] = Math.round(tone01(rasters[channel].dataF32[index], p.minVal, p.maxVal,
              p.brightness, p.gain, p.contrast) * 255);
          }
          dst[pixel + 3] = 255;
        }
      }
      entry.ctx.putImageData(entry.image, 0, 0, rect.x, rect.y, rect.w, rect.h);
      stats.pixelsColored += rect.w * rect.h;
    }
    if (rectangles.length) { if (full) stats.fullUpdates += 1; else stats.patchUpdates += 1; }
    entry.paramsKey = paramsKey; entry.revisions = rasters.map((raster) => raster.revision);
    if (fresh) stats.bytes += entry.image.data.byteLength;
    entries.set(key, entry);
    while (entries.size > 2 || stats.bytes > maxBytes) {
      const oldest = entries.keys().next().value;
      stats.bytes -= entries.get(oldest).image.data.byteLength; entries.delete(oldest);
    }
    return entry.canvas;
  }
  return { compose, clear, stats };
}
