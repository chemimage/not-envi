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

  function resolveMaxInflight(ioConcurrency) {
    return clamp(Math.floor(Math.max(1, ioConcurrency) * 0.75) + 1, 2, 8);
  }

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
    const tileSize = 128;
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
      maxInflight: resolveMaxInflight(ioConcurrency),
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
    ds.pyramid.maxInflight = resolveMaxInflight(ioConcurrency);
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

  function collectViewportLevel(ds, pyr, band, level, eff, viewportW, viewportH) {
    const bounds = viewTileBounds(ds, pyr, level, eff, viewportW, viewportH);
    if (!bounds) return null;
    const tasks = [];
    let total = 0;
    let cached = 0;
    for (let ty = bounds.ty0; ty <= bounds.ty1; ty++) {
      for (let tx = bounds.tx0; tx <= bounds.tx1; tx++) {
        total += 1;
        const key = bandTileKey(band, level, tx, ty);
        if (pyr.tiles.has(key)) cached += 1;
        tasks.push({ band, level, tx, ty, key });
      }
    }
    return { level, bounds, tasks, total, cached };
  }

  function enqueueViewportTasks(ds, band, minLevel, eff, viewportW, viewportH) {
    const pyr = ds.pyramid;
    const levels = [];
    for (let level = pyr.maxLevel; level >= minLevel; level -= 1) {
      const info = collectViewportLevel(ds, pyr, band, level, eff, viewportW, viewportH);
      if (!info) continue;
      levels.push(info);
      for (const task of info.tasks) {
        if (!pyr.tiles.has(task.key) && !pyr.pending.has(task.key)) {
          enqueueBandTask(ds, band, task.level, task.tx, task.ty, true);
        }
      }
    }
    return levels;
  }

  async function ensureViewportLevelCached(ds, band, level, eff, viewportW, viewportH, maxTiles = 16) {
    const pyr = ds.pyramid;
    const info = collectViewportLevel(ds, pyr, band, level, eff, viewportW, viewportH);
    if (!info || !info.total) return false;
    const missing = info.tasks.filter((task) => !pyr.tiles.has(task.key));
    if (!missing.length) return true;
    if (missing.length > maxTiles) return false;
    await Promise.all(missing.map((task) => (
      getBandTile(ds, band, task.level, task.tx, task.ty).catch(() => null)
    )));
    return true;
  }

  function composePyramidRaster(ds, band, idealLevel, eff, viewportW, viewportH) {
    const pyr = ds.pyramid;
    const ideal = collectViewportLevel(ds, pyr, band, idealLevel, eff, viewportW, viewportH);
    if (!ideal) return null;

    const winX0 = ideal.bounds.lx0;
    const winY0 = ideal.bounds.ly0;
    const winW = Math.max(1, ideal.bounds.lx1 - ideal.bounds.lx0);
    const winH = Math.max(1, ideal.bounds.ly1 - ideal.bounds.ly0);
    const out = new Float32Array(winW * winH);
    out.fill(Number.NaN);
    const filled = new Uint8Array(winW * winH);
    let filledCount = 0;
    let bestLevel = null;

    for (let level = pyr.maxLevel; level >= idealLevel; level -= 1) {
      const info = collectViewportLevel(ds, pyr, band, level, eff, viewportW, viewportH);
      if (!info || !info.cached) continue;
      const factor = 1 << (level - idealLevel);
      for (const task of info.tasks) {
        const tile = pyr.tiles.get(task.key);
        if (!tile) continue;

        touchTile(pyr, task.key);
        const tileDx0 = task.tx * pyr.tileSize;
        const tileDy0 = task.ty * pyr.tileSize;
        const tileDx1 = tileDx0 + tile.w;
        const tileDy1 = tileDy0 + tile.h;

        const ovX0 = Math.max(tileDx0, info.bounds.lx0);
        const ovY0 = Math.max(tileDy0, info.bounds.ly0);
        const ovX1 = Math.min(tileDx1, info.bounds.lx1);
        const ovY1 = Math.min(tileDy1, info.bounds.ly1);
        if (ovX1 <= ovX0 || ovY1 <= ovY0) continue;

        bestLevel = bestLevel == null ? level : Math.min(bestLevel, level);
        for (let sy = ovY0; sy < ovY1; sy += 1) {
          const dstY0 = Math.max(0, (sy * factor) - winY0);
          const dstY1 = Math.min(winH, dstY0 + factor);
          const srcRow = (sy - tileDy0) * tile.w;
          for (let sx = ovX0; sx < ovX1; sx += 1) {
            const value = tile.data[srcRow + (sx - tileDx0)];
            const dstX0 = Math.max(0, (sx * factor) - winX0);
            const dstX1 = Math.min(winW, dstX0 + factor);
            for (let dy = dstY0; dy < dstY1; dy += 1) {
              const rowOff = dy * winW;
              for (let dx = dstX0; dx < dstX1; dx += 1) {
                const idx = rowOff + dx;
                out[idx] = value;
                if (!filled[idx]) {
                  filled[idx] = 1;
                  filledCount += 1;
                }
              }
            }
          }
        }
      }
    }

    if (!filledCount) return null;
    return {
      band,
      dataF32: out,
      w: winW,
      h: winH,
      source: "pyramid",
      level: bestLevel == null ? idealLevel : bestLevel,
      idealLevel,
      step: (1 << (bestLevel == null ? idealLevel : bestLevel)),
      x0: ds.view.x,
      y0: ds.view.y,
      partial: filledCount < out.length,
      coverage: filledCount / Math.max(1, out.length),
      approximate: ideal.cached < ideal.total
    };
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
    }, { timeout: pyr.qHi.length ? 24 : 120 });
  }

  async function tryRasterFromPyramid(ds, band, eff) {
    ensurePyramid(ds);
    const pyr = ds.pyramid;
    if (!pyr || pyr.cancelled) return null;

    const lvl = pyramidLevelForEff(ds, eff);
    const viewport = getViewportSize();
    const levels = enqueueViewportTasks(ds, band, lvl, eff, viewport.width, viewport.height);
    const visible = levels.find((info) => info.level === lvl) || null;
    const visibleCached = levels.reduce((sum, info) => sum + info.cached, 0);
    const prefer = ds.__pyrPreferImmediate || visibleCached > 0;

    pruneQueuesToBand(pyr, band);
    schedulePyramidWork(ds);
    pumpBackgroundTasks(ds, band, Math.max(lvl, 2));

    let raster = prefer ? composePyramidRaster(ds, band, lvl, eff, viewport.width, viewport.height) : null;
    const needImmediateCoarse = !raster || raster.partial;
    if (needImmediateCoarse && pyr.maxLevel > lvl) {
      const loaded = await ensureViewportLevelCached(ds, band, pyr.maxLevel, eff, viewport.width, viewport.height, 16);
      if (loaded) {
        raster = composePyramidRaster(ds, band, lvl, eff, viewport.width, viewport.height);
      }
    }

    if (!raster && visible && visible.total <= 16) {
      const loaded = await ensureViewportLevelCached(ds, band, lvl, eff, viewport.width, viewport.height, 16);
      if (loaded) {
        raster = composePyramidRaster(ds, band, lvl, eff, viewport.width, viewport.height);
      }
    }

    return raster;
  }

  return {
    ensurePyramid,
    disposePyramid,
    updateInflightForIO,
    tryRasterFromPyramid
  };
}
