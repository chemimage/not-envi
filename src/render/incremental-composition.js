import { computeHistogram, histogramFromUint8Counts } from "./display-math.js";

let nextPlaneId = 1;
const tileIds = new WeakMap();
let nextTileId = 1;

export function mergeDirtyRects(rectangles) {
  const out = [];
  for (const input of rectangles) {
    let rect = { ...input };
    for (let i = 0; i < out.length;) {
      const other = out[i];
      if (rect.x > other.x + other.w || other.x > rect.x + rect.w
        || rect.y > other.y + other.h || other.y > rect.y + rect.h) { i += 1; continue; }
      const x = Math.min(rect.x, other.x), y = Math.min(rect.y, other.y);
      rect = { x, y, w: Math.max(rect.x + rect.w, other.x + other.w) - x,
        h: Math.max(rect.y + rect.h, other.y + other.h) - y };
      out.splice(i, 1); i = 0;
    }
    out.push(rect);
  }
  return out;
}

/** Renderer-owned mutable plane. Revisions/damage describe writes; consumers
 * must not treat data as an immutable export snapshot. No tile data is retained
 * here: weak identity stamps let the tile cache evict its original arrays. */
export class CompositionPlane {
  constructor(viewKey, geometry, uint8 = false) {
    Object.assign(this, geometry);
    this.viewKey = viewKey;
    this.id = nextPlaneId++;
    this.data = new Float32Array(this.w * this.h).fill(Number.NaN);
    this.quality = new Uint8Array(this.w * this.h).fill(255);
    this.counts = uint8 ? new Uint32Array(256) : null;
    this.bytes = this.data.byteLength + this.quality.byteLength + (this.counts?.byteLength || 0);
    this.sources = new Map();
    this.filledCount = 0; this.fineCount = 0; this.bestLevel = null; this.revision = 0;
  }

  begin() { this.previousRevision = this.revision; this.rectangles = []; this.changedPixels = 0; }

  apply(tile, key, rect, factor, originX, originY, tileX, tileY) {
    let stamp = tileIds.get(tile);
    if (!stamp) { stamp = nextTileId++; tileIds.set(tile, stamp); }
    if (this.sources.get(key) === stamp) return false;
    this.sources.set(key, stamp);
    let changed = 0;
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      const srcRow = (Math.floor((y - originY) / factor) - tileY) * tile.w;
      for (let x = rect.x; x < rect.x + rect.w; x += 1) {
        const index = y * this.w + x;
        const oldLevel = this.quality[index];
        if (oldLevel < tile.level) continue;
        const value = tile.data[srcRow + Math.floor((x - originX) / factor) - tileX];
        const previous = this.data[index];
        if (oldLevel === tile.level && (previous === value || (Number.isNaN(previous) && Number.isNaN(value)))) continue;
        if (this.counts) {
          if (Number.isFinite(previous)) this.counts[previous] -= 1;
          if (Number.isFinite(value)) this.counts[value] += 1;
        }
        if (oldLevel === 255) this.filledCount += 1;
        if (tile.level === this.idealLevel && oldLevel !== this.idealLevel) this.fineCount += 1;
        this.data[index] = value; this.quality[index] = tile.level; changed += 1;
      }
    }
    if (changed) {
      this.bestLevel = this.bestLevel == null ? tile.level : Math.min(this.bestLevel, tile.level);
      this.rectangles.push(rect); this.changedPixels += changed;
    }
    return true;
  }

  finish(requiredPixels) {
    if (this.changedPixels) this.revision += 1;
    const complete = this.fineCount >= requiredPixels;
    if (this.counts && (this.changedPixels || !this.histogramStats)) {
      this.histogramStats = histogramFromUint8Counts(this.counts);
    } else if (!this.counts && (!this.histogramStats?.count || (complete && !this.finalStatistics))) {
      if (complete) this.histogramStats = computeHistogram(this.data);
      else {
        const stride = Math.max(1, Math.ceil(this.data.length / 4096));
        const samples = [];
        for (let i = 0; i < this.data.length; i += stride) if (Number.isFinite(this.data[i])) samples.push(this.data[i]);
        this.histogramStats = computeHistogram(samples);
      }
    }
    if (complete) this.finalStatistics = true;
    // Keep automatic display ranges steady while tiles refine. Exact final
    // statistics can change them once, correctly invalidating all RGB pixels.
    if (!this.displayRangeStats && this.histogramStats?.count) this.displayRangeStats = this.histogramStats;
    return { compositionId: this.id, revision: this.revision, previousRevision: this.previousRevision,
      dirtyRects: mergeDirtyRects(this.rectangles), histogramStats: this.histogramStats,
      displayRangeStats: complete ? this.histogramStats : this.displayRangeStats };
  }
}

/** Per-pyramid display cache, separate from source tiles. At most six planes and
 * 64 MiB (or the smaller pyramid limit) are retained. Oversized views compose
 * without retention. App-wide/caller-owned output budgeting remains issue #24. */
export class CompositionCache {
  constructor(limit) { this.entries = new Map(); this.bytes = 0; this.setLimit(limit); }
  setLimit(limit) {
    this.limit = Math.max(0, Math.min(64 * 1024 * 1024, Number(limit) || 0));
    this.trim();
  }
  trim() {
    while (this.bytes > this.limit || this.entries.size > 6) {
      const key = this.entries.keys().next().value;
      this.bytes -= this.entries.get(key).bytes; this.entries.delete(key);
    }
  }
  peek(key, viewKey) { const plane = this.entries.get(key); return plane?.viewKey === viewKey ? plane : null; }
  get(key, viewKey, geometry, uint8) {
    let plane = this.entries.get(key);
    if (plane) { this.entries.delete(key); this.bytes -= plane.bytes; }
    if (!plane || plane.viewKey !== viewKey) plane = new CompositionPlane(viewKey, geometry, uint8);
    if (plane.bytes <= this.limit) { this.entries.set(key, plane); this.bytes += plane.bytes; this.trim(); }
    return plane;
  }
  clear() { this.entries.clear(); this.bytes = 0; }
}
