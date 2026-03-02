import { clamp } from "../core/utils.js";

export function computeMaxPyramidLevel(meta, tileSize) {
  const maxDim = Math.max(meta.samples, meta.lines);
  if (!Number.isFinite(maxDim) || maxDim <= 0) return 1;
  const L = Math.ceil(Math.log2(Math.max(1, maxDim / tileSize)));
  return clamp(L, 1, 30);
}

export function bandTileKey(band, level, tx, ty) {
  return `${band}|${level}:${tx}:${ty}`;
}

export function pyramidLevelForEff(ds, eff) {
  const pyr = ds.pyramid;
  if (!pyr) return 0;
  if (eff >= 1) return 0;
  const idealStep = Math.ceil(1 / eff);
  return clamp(Math.floor(Math.log2(idealStep)), 1, pyr.maxLevel);
}

export function levelInfo(ds, pyr, level) {
  const step = 1 << level;
  const downW = Math.ceil(ds.meta.samples / step);
  const downH = Math.ceil(ds.meta.lines / step);
  const tilesX = Math.max(1, Math.ceil(downW / pyr.tileSize));
  const tilesY = Math.max(1, Math.ceil(downH / pyr.tileSize));
  return { step, downW, downH, tilesX, tilesY };
}

export function viewTileBounds(ds, pyr, level, eff, viewportW, viewportH) {
  const info = levelInfo(ds, pyr, level);
  const viewW = viewportW / eff;
  const viewH = viewportH / eff;
  const step = info.step;
  const x0 = ds.view.x;
  const y0 = ds.view.y;
  const lx0 = Math.floor(x0 / step);
  const ly0 = Math.floor(y0 / step);
  const lx1 = Math.ceil((x0 + viewW) / step);
  const ly1 = Math.ceil((y0 + viewH) / step);
  const tx0 = clamp(Math.floor(lx0 / pyr.tileSize), 0, info.tilesX - 1);
  const ty0 = clamp(Math.floor(ly0 / pyr.tileSize), 0, info.tilesY - 1);
  const tx1 = clamp(Math.floor((lx1 - 1) / pyr.tileSize), 0, info.tilesX - 1);
  const ty1 = clamp(Math.floor((ly1 - 1) / pyr.tileSize), 0, info.tilesY - 1);
  return { info, step, x0, y0, lx0, ly0, lx1, ly1, tx0, ty0, tx1, ty1 };
}

export function createPyramidController(deps) {
  const {
    now,
    requestIdle,
    cancelIdle,
    readBandWindow,
    readBandWindowBIP,
    onPerfUpdate,
    onProgressiveRender,
    getActiveDatasetId,
    getDevicePixelRatio,
    getViewportSize,
    getIOConcurrency
  } = deps;

  function touchTile(pyr, key) {
    const tile = pyr.tiles.get(key);
    if (!tile) return;
    tile.t = ++pyr.tick;
    pyr.tiles.delete(key);
    pyr.tiles.set(key, tile);
  }

  function evictPyramidIfNeeded(pyr) {
    while (pyr.totalBytes > pyr.limitBytes && pyr.tiles.size) {
      const oldestKey = pyr.tiles.keys().next().value;
      const tile = pyr.tiles.get(oldestKey);
      pyr.tiles.delete(oldestKey);
      if (tile) pyr.totalBytes -= tile.bytes || 0;
    }
  }

  function initPyramid(ds) {
    const tileSize = 256;
    const maxLevel = computeMaxPyramidLevel(ds.meta, tileSize);
    const ioConcurrency = Math.max(1, getIOConcurrency());
    ds.pyramid = {
      tileSize,
      maxLevel,
      limitBytes: ds.pyramidBudgetBytes || (256 * 1024 * 1024),
      totalBytes: 0,
      tiles: new Map(),
      pending: new Map(),
      inflight: new Set(),
      maxInflight: clamp(Math.floor(ioConcurrency / 2) + 1, 1, 4),
      queued: new Set(),
      tick: 0,
      cancelled: false,
      qHi: [],
      qLo: [],
      bgIter: new Map(),
      _idleHandle: null,
      _lastKick: 0
    };
  }

  function ensurePyramid(ds) {
    if (!ds.pyramid) initPyramid(ds);
  }

  function updateInflightForIO(ds) {
    if (!ds?.pyramid) return;
    const ioConcurrency = Math.max(1, getIOConcurrency());
    ds.pyramid.maxInflight = clamp(Math.floor(ioConcurrency / 2) + 1, 1, 4);
  }

  function disposePyramid(pyr) {
    if (!pyr) return;
    pyr.cancelled = true;
    if (pyr._idleHandle) {
      try { cancelIdle(pyr._idleHandle); } catch (_err) {}
      pyr._idleHandle = null;
    }
    pyr.tiles.clear();
    pyr.pending.clear();
    if (pyr.inflight) pyr.inflight.clear();
    pyr.queued.clear();
    pyr.qHi.length = 0;
    pyr.qLo.length = 0;
    pyr.bgIter.clear();
    pyr.totalBytes = 0;
  }

  function pruneQueuesToBand(pyr, band) {
    const prune = (arr) => {
      if (!arr.length) return;
      let w = 0;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i].band === band) arr[w++] = arr[i];
      }
      arr.length = w;
    };
    prune(pyr.qHi);
    prune(pyr.qLo);
  }

  function enqueueBandTask(ds, band, level, tx, ty, hi) {
    ensurePyramid(ds);
    const pyr = ds.pyramid;
    if (!pyr || pyr.cancelled) return;

    const key = bandTileKey(band, level, tx, ty);
    if (pyr.tiles.has(key) || pyr.pending.has(key) || pyr.queued.has(key)) return;

    pyr.queued.add(key);
    const task = { band, level, tx, ty, key };
    if (hi) pyr.qHi.push(task);
    else pyr.qLo.push(task);
  }

  function pumpBackgroundTasks(ds, band, minLevel) {
    const pyr = ds.pyramid;
    if (!pyr || pyr.cancelled) return;

    let it = pyr.bgIter.get(band);
    if (!it || it.minLevel !== minLevel) {
      it = { lvl: minLevel, tx: 0, ty: 0, minLevel };
      pyr.bgIter.set(band, it);
    }

    const budget = 120;
    let n = 0;
    while (n < budget) {
      const info = levelInfo(ds, pyr, it.lvl);
      enqueueBandTask(ds, band, it.lvl, it.tx, it.ty, false);

      it.tx++;
      if (it.tx >= info.tilesX) {
        it.tx = 0;
        it.ty++;
        if (it.ty >= info.tilesY) {
          it.ty = 0;
          it.lvl++;
          if (it.lvl > pyr.maxLevel) it.lvl = minLevel;
        }
      }
      n++;
    }
  }

  async function getBandTile(ds, band, level, tx, ty) {
    ensurePyramid(ds);
    const pyr = ds.pyramid;
    if (!pyr || pyr.cancelled) return null;

    const key = bandTileKey(band, level, tx, ty);
    const existing = pyr.tiles.get(key);
    if (existing) {
      touchTile(pyr, key);
      return existing;
    }
    const pending = pyr.pending.get(key);
    if (pending) return pending;

    pyr.queued.add(key);

    const p = (async () => {
      const step = 1 << level;
      const x0 = tx * pyr.tileSize * step;
      const y0 = ty * pyr.tileSize * step;

      const outW = Math.min(pyr.tileSize, Math.ceil((ds.meta.samples - x0) / step));
      const outH = Math.min(pyr.tileSize, Math.ceil((ds.meta.lines - y0) / step));
      if (outW <= 0 || outH <= 0) return null;

      let data;
      if (ds.meta.interleave === "bip") {
        data = await readBandWindowBIP(ds.meta, ds.ds, band, x0, y0, outW, outH, step);
      } else {
        data = await readBandWindow(ds.meta, ds.ds, band, x0, y0, outW, outH, step);
      }

      if (!ds.pyramid || ds.pyramid.cancelled) return null;

      const tile = { band, level, tx, ty, data, w: outW, h: outH, bytes: data.byteLength, t: ++ds.pyramid.tick };
      ds.pyramid.pending.delete(key);
      ds.pyramid.tiles.set(key, tile);
      ds.pyramid.totalBytes += tile.bytes;
      evictPyramidIfNeeded(ds.pyramid);
      return tile;
    })().catch((err) => {
      try { pyr.pending.delete(key); } catch (_err) {}
      throw err;
    }).finally(() => {
      try { pyr.queued.delete(key); } catch (_err) {}
    });

    pyr.pending.set(key, p);
    return p;
  }

  function schedulePyramidWork(ds) {
    const pyr = ds.pyramid;
    if (!pyr || pyr.cancelled) return;
    if (getActiveDatasetId() !== ds.id) return;
    if (pyr._idleHandle) return;

    pyr._idleHandle = requestIdle(() => {
      pyr._idleHandle = null;
      if (!ds.pyramid || ds.pyramid.cancelled) return;
      if (getActiveDatasetId() !== ds.id) return;

      const maxInflight = pyr.maxInflight || 2;
      while (pyr.inflight && pyr.inflight.size < maxInflight) {
        const task = (pyr.qHi.length ? pyr.qHi.shift() : pyr.qLo.shift()) || null;
        if (!task) break;

        const p = getBandTile(ds, task.band, task.level, task.tx, task.ty)
          .catch(() => {})
          .finally(() => {
            try { if (pyr.inflight) pyr.inflight.delete(p); } catch (_err) {}
            onPerfUpdate();

            const tKick = now();
            if (!pyr._lastKick || (tKick - pyr._lastKick) > 90) {
              pyr._lastKick = tKick;
              onProgressiveRender();
            }

            if (ds.activeBand != null && ds.pyramid && !ds.pyramid.cancelled) {
              const eff = ds.view.scale * getDevicePixelRatio();
              const lvl = pyramidLevelForEff(ds, eff);
              pumpBackgroundTasks(ds, ds.activeBand, Math.max(lvl, 2));
            }

            if (ds.pyramid && !ds.pyramid.cancelled) {
              schedulePyramidWork(ds);
            }
          });

        pyr.inflight.add(p);
      }

      if (!pyr.qHi.length && !pyr.qLo.length && ds.activeBand != null) {
        const eff = ds.view.scale * getDevicePixelRatio();
        const lvl = pyramidLevelForEff(ds, eff);
        pumpBackgroundTasks(ds, ds.activeBand, Math.max(lvl, 2));
      }

      onPerfUpdate();

      if (ds.pyramid && !ds.pyramid.cancelled && (pyr.qHi.length || pyr.qLo.length || (pyr.inflight && pyr.inflight.size))) {
        schedulePyramidWork(ds);
      } else {
        onProgressiveRender();
      }
    }, { timeout: 250 });
  }

  async function tryRasterFromPyramid(ds, band, eff) {
    ensurePyramid(ds);
    const pyr = ds.pyramid;
    if (!pyr || pyr.cancelled) return null;

    const lvl = pyramidLevelForEff(ds, eff);
    if (lvl <= 0) return null;

    const viewport = getViewportSize();
    const b = viewTileBounds(ds, pyr, lvl, eff, viewport.width, viewport.height);
    if (!b) return null;

    let total = 0;
    let cached = 0;
    for (let ty = b.ty0; ty <= b.ty1; ty++) {
      for (let tx = b.tx0; tx <= b.tx1; tx++) {
        total++;
        const key = bandTileKey(band, lvl, tx, ty);
        if (pyr.tiles.has(key)) cached++;
      }
    }
    const frac = total ? (cached / total) : 0;
    const prefer = ds.__pyrPreferImmediate || frac >= 0.20;

    for (let ty = b.ty0; ty <= b.ty1; ty++) {
      for (let tx = b.tx0; tx <= b.tx1; tx++) {
        const key = bandTileKey(band, lvl, tx, ty);
        if (!pyr.tiles.has(key) && !pyr.pending.has(key)) {
          enqueueBandTask(ds, band, lvl, tx, ty, true);
        }
      }
    }
    pruneQueuesToBand(pyr, band);
    schedulePyramidWork(ds);
    pumpBackgroundTasks(ds, band, Math.max(lvl, 2));

    if (!prefer) return null;

    const tileSize = pyr.tileSize;
    const winX0 = b.lx0;
    const winY0 = b.ly0;
    const winW = Math.max(1, b.lx1 - b.lx0);
    const winH = Math.max(1, b.ly1 - b.ly0);

    const out = new Float32Array(winW * winH);
    out.fill(Number.NaN);

    let any = false;
    for (let ty = b.ty0; ty <= b.ty1; ty++) {
      for (let tx = b.tx0; tx <= b.tx1; tx++) {
        const key = bandTileKey(band, lvl, tx, ty);
        const tile = pyr.tiles.get(key);
        if (!tile) continue;

        touchTile(pyr, key);
        const tileDx0 = tx * tileSize;
        const tileDy0 = ty * tileSize;
        const tileDx1 = tileDx0 + tile.w;
        const tileDy1 = tileDy0 + tile.h;

        const ovX0 = Math.max(tileDx0, winX0);
        const ovY0 = Math.max(tileDy0, winY0);
        const ovX1 = Math.min(tileDx1, winX0 + winW);
        const ovY1 = Math.min(tileDy1, winY0 + winH);
        if (ovX1 <= ovX0 || ovY1 <= ovY0) continue;

        for (let dy = ovY0; dy < ovY1; dy++) {
          const srcStart = (dy - tileDy0) * tile.w + (ovX0 - tileDx0);
          const srcEnd = srcStart + (ovX1 - ovX0);
          const dstStart = (dy - winY0) * winW + (ovX0 - winX0);
          out.set(tile.data.subarray(srcStart, srcEnd), dstStart);
        }

        any = true;
      }
    }

    if (!any) return null;
    return { band, dataF32: out, w: winW, h: winH, source: "pyramid", level: lvl, step: (1 << lvl), x0: ds.view.x, y0: ds.view.y };
  }

  return {
    ensurePyramid,
    disposePyramid,
    updateInflightForIO,
    tryRasterFromPyramid
  };
}
