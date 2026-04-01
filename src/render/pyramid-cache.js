import { clamp } from "../core/utils.js";
import { resolveRasterSampling } from "./raster-geometry.js";
import { APP_CONFIG } from "../app/config.js";

const perfNow = () => (
  (typeof performance !== "undefined" && typeof performance.now === "function")
    ? performance.now()
    : Date.now()
);

export function computeMaxPyramidLevel(meta, tileSize) {
  const maxDim = Math.max(meta.samples, meta.lines);
  if (!Number.isFinite(maxDim) || maxDim <= 0) return 1;
  const L = Math.ceil(Math.log2(Math.max(1, maxDim / tileSize)));
  return clamp(L, 1, 30);
}

export function bandTileKey(band, level, tx, ty) {
  return `${band}|${level}:${tx}:${ty}`;
}

export function buildBandProximityOrder(centerBand, bandCount, maxDistance = null) {
  const totalBands = Math.max(1, Math.floor(Number(bandCount) || 0));
  const center = clamp(Math.floor(Number(centerBand) || 0), 0, totalBands - 1);
  const maxDist = clamp(
    Math.floor(Number(maxDistance == null ? (totalBands - 1) : maxDistance) || 0),
    0,
    totalBands - 1
  );
  const out = [center];
  for (let dist = 1; dist <= maxDist; dist += 1) {
    const prev = center - dist;
    const next = center + dist;
    if (prev >= 0) out.push(prev);
    if (next < totalBands) out.push(next);
  }
  return out;
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

function clearLowPriorityQueue(pyr) {
  if (!pyr?.qLo?.length) return;
  const hiKeys = new Set(Array.isArray(pyr.qHi) ? pyr.qHi.map((task) => task.key) : []);
  for (const task of pyr.qLo) {
    if (!task?.key || hiKeys.has(task.key)) continue;
    pyr.queued.delete(task.key);
  }
  pyr.qLo.length = 0;
}

function collectRingTasks(bounds, band, level, radius) {
  const tasks = [];
  const tilesX = Math.max(1, Number(bounds?.info?.tilesX) || 1);
  const tilesY = Math.max(1, Number(bounds?.info?.tilesY) || 1);
  const tx0 = Number(bounds?.tx0) || 0;
  const ty0 = Number(bounds?.ty0) || 0;
  const tx1 = Number(bounds?.tx1) || tx0;
  const ty1 = Number(bounds?.ty1) || ty0;
  const ring = Math.max(0, Math.floor(Number(radius) || 0));
  const minTx = clamp(tx0 - ring, 0, tilesX - 1);
  const minTy = clamp(ty0 - ring, 0, tilesY - 1);
  const maxTx = clamp(tx1 + ring, 0, tilesX - 1);
  const maxTy = clamp(ty1 + ring, 0, tilesY - 1);
  const centerX = (tx0 + tx1) * 0.5;
  const centerY = (ty0 + ty1) * 0.5;

  for (let ty = minTy; ty <= maxTy; ty += 1) {
    for (let tx = minTx; tx <= maxTx; tx += 1) {
      const dx = tx < tx0 ? (tx0 - tx) : (tx > tx1 ? (tx - tx1) : 0);
      const dy = ty < ty0 ? (ty0 - ty) : (ty > ty1 ? (ty - ty1) : 0);
      const tileRing = Math.max(dx, dy);
      if (tileRing !== ring) continue;
      tasks.push({
        band,
        level,
        tx,
        ty,
        key: bandTileKey(band, level, tx, ty),
        radius: ring,
        centerDistance: Math.abs(tx - centerX) + Math.abs(ty - centerY)
      });
    }
  }
  return tasks;
}

export function buildPyramidPrefetchPlan(ds, focusBand, minLevel, eff, viewportW, viewportH, limit = 96, maxSpectralDistance = 6) {
  const pyr = ds?.pyramid;
  if (!pyr || !ds?.meta) return [];

  const bandCount = Math.max(1, Math.floor(Number(ds.meta.bands) || 0));
  const band = clamp(Math.floor(Number(focusBand) || 0), 0, bandCount - 1);
  const startLevel = clamp(Math.floor(Number(minLevel) || 0), 0, pyr.maxLevel);
  const width = Math.max(1, Number(viewportW) || 1);
  const height = Math.max(1, Number(viewportH) || 1);
  const spectralBands = buildBandProximityOrder(band, bandCount, Math.min(maxSpectralDistance, bandCount - 1));
  const levelInfos = [];
  for (let level = startLevel; level <= pyr.maxLevel; level += 1) {
    const bounds = viewTileBounds(ds, pyr, level, eff, width, height);
    if (!bounds) continue;
    const maxRadius = Math.max(
      Number(bounds.tx0) || 0,
      Number(bounds.ty0) || 0,
      Math.max(0, (Number(bounds.info?.tilesX) || 1) - 1 - (Number(bounds.tx1) || 0)),
      Math.max(0, (Number(bounds.info?.tilesY) || 1) - 1 - (Number(bounds.ty1) || 0))
    );
    levelInfos.push({ level, levelIndex: level - startLevel, bounds, maxRadius });
  }
  if (!levelInfos.length) return [];

  const candidates = [];
  const maxCandidates = Math.max(limit * 3, limit);
  for (let radius = 0, hasMore = true; hasMore && candidates.length < maxCandidates; radius += 1) {
    hasMore = false;
    for (const info of levelInfos) {
      if (radius > info.maxRadius) continue;
      hasMore = true;
      for (const targetBand of spectralBands) {
        const bandDistance = Math.abs(targetBand - band);
        const ringTasks = collectRingTasks(info.bounds, targetBand, info.level, radius);
        for (const task of ringTasks) {
          if (pyr.tiles.has(task.key) || pyr.pending.has(task.key) || pyr.queued.has(task.key)) continue;
          candidates.push({
            ...task,
            bandDistance,
            score: (task.radius * 8) + (bandDistance * 10) + (info.levelIndex * 3) + (task.centerDistance * 0.25)
          });
          if (candidates.length >= maxCandidates) break;
        }
        if (candidates.length >= maxCandidates) break;
      }
      if (candidates.length >= maxCandidates) break;
    }
  }

  candidates.sort((a, b) => (
    a.score - b.score
    || a.bandDistance - b.bandDistance
    || a.radius - b.radius
    || a.level - b.level
    || a.centerDistance - b.centerDistance
    || a.ty - b.ty
    || a.tx - b.tx
  ));
  return candidates.slice(0, limit);
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
    getViewportSize,
    getIOConcurrency
  } = deps;

  function resolveMaxInflight(ioConcurrency) {
    return clamp(
      Math.floor(Math.max(1, ioConcurrency) * APP_CONFIG.pyramid.inflightFactor) + APP_CONFIG.pyramid.inflightBias,
      APP_CONFIG.pyramid.inflightMin,
      APP_CONFIG.pyramid.inflightMax
    );
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
    const tileSize = APP_CONFIG.pyramid.tileSize;
    const maxLevel = computeMaxPyramidLevel(ds.meta, tileSize);
    const ioConcurrency = Math.max(1, getIOConcurrency());
    ds.pyramid = {
      tileSize,
      maxLevel,
      limitBytes: ds.pyramidBudgetBytes || APP_CONFIG.pyramid.defaultLimitBytes,
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
      focus: null,
      _idleHandle: null,
      _lastKick: 0,
      stats: {
        tileReads: 0,
        tilePixelsRead: 0,
        tileReadMs: 0,
        composeCalls: 0,
        tilesComposed: 0,
        composePixels: 0,
        composeMs: 0
      }
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
    pyr.focus = null;
    pyr.totalBytes = 0;
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

  function updatePyramidFocus(ds, band, minLevel, eff, viewportW, viewportH) {
    const pyr = ds.pyramid;
    if (!pyr) return;
    const bounds = viewTileBounds(ds, pyr, minLevel, eff, viewportW, viewportH);
    const key = [
      Math.floor(Number(band) || 0),
      Math.floor(Number(minLevel) || 0),
      Math.floor(Number(bounds?.tx0) || 0),
      Math.floor(Number(bounds?.ty0) || 0),
      Math.floor(Number(bounds?.tx1) || 0),
      Math.floor(Number(bounds?.ty1) || 0),
      Math.round(Number(viewportW) || 0),
      Math.round(Number(viewportH) || 0)
    ].join("|");
    if (pyr.focus?.key !== key) clearLowPriorityQueue(pyr);
    pyr.focus = {
      key,
      band: Math.floor(Number(band) || 0),
      minLevel: Math.floor(Number(minLevel) || 0),
      eff,
      viewportW,
      viewportH
    };
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
    const composeStart = perfNow();
    const ideal = collectViewportLevel(ds, pyr, band, idealLevel, eff, viewportW, viewportH);
    if (!ideal) return null;

    const sampling = (idealLevel === 0)
      ? resolveRasterSampling(ds, viewportW, viewportH, eff)
      : null;
    const winX0 = sampling ? Math.floor(sampling.srcX0) : ideal.bounds.lx0;
    const winY0 = sampling ? Math.floor(sampling.srcY0) : ideal.bounds.ly0;
    const winW = sampling ? Math.max(1, sampling.rasterW) : Math.max(1, ideal.bounds.lx1 - ideal.bounds.lx0);
    const winH = sampling ? Math.max(1, sampling.rasterH) : Math.max(1, ideal.bounds.ly1 - ideal.bounds.ly0);
    const dstOriginX = sampling
      ? ((Math.floor(Number(sampling.colStart) || 0)) - winX0)
      : (-winX0);
    const dstOriginY = sampling
      ? ((Math.floor(Number(sampling.rowStart) || 0)) - winY0)
      : (-winY0);
    const out = new Float32Array(winW * winH);
    out.fill(Number.NaN);
    const filled = new Uint8Array(winW * winH);
    let filledCount = 0;
    let bestLevel = null;
    let tilesUsed = 0;

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
        tilesUsed += 1;
        for (let sy = ovY0; sy < ovY1; sy += 1) {
          const dstY0 = Math.max(0, dstOriginY + (sy * factor));
          const dstY1 = Math.min(winH, dstY0 + factor);
          const srcRow = (sy - tileDy0) * tile.w;
          for (let sx = ovX0; sx < ovX1; sx += 1) {
            const value = tile.data[srcRow + (sx - tileDx0)];
            const dstX0 = Math.max(0, dstOriginX + (sx * factor));
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

    pyr.stats.composeCalls += 1;
    pyr.stats.tilesComposed += tilesUsed;
    pyr.stats.composePixels += filledCount;
    pyr.stats.composeMs += perfNow() - composeStart;
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

  function refillBackgroundTasks(ds) {
    const pyr = ds.pyramid;
    if (!pyr || pyr.cancelled) return;
    const focus = pyr.focus;
    if (!focus) return;
    if (pyr.qLo.length >= 96) return;
    const plan = buildPyramidPrefetchPlan(ds, focus.band, focus.minLevel, focus.eff, focus.viewportW, focus.viewportH, 128, 6);
    for (const task of plan) enqueueBandTask(ds, task.band, task.level, task.tx, task.ty, false);
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
      const readStart = perfNow();
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
      ds.pyramid.stats.tileReads += 1;
      ds.pyramid.stats.tilePixelsRead += outW * outH;
      ds.pyramid.stats.tileReadMs += perfNow() - readStart;
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

            refillBackgroundTasks(ds);

            if (ds.pyramid && !ds.pyramid.cancelled) {
              schedulePyramidWork(ds);
            }
          });

        pyr.inflight.add(p);
      }

      if (!pyr.qHi.length && !pyr.qLo.length) refillBackgroundTasks(ds);

      onPerfUpdate();

      if (ds.pyramid && !ds.pyramid.cancelled && (pyr.qHi.length || pyr.qLo.length || (pyr.inflight && pyr.inflight.size))) {
        schedulePyramidWork(ds);
      } else {
        onProgressiveRender();
      }
    }, { timeout: pyr.qHi.length ? 24 : 120 });
  }

  async function tryRasterFromPyramid(ds, band, eff, viewportW = null, viewportH = null) {
    ensurePyramid(ds);
    const pyr = ds.pyramid;
    if (!pyr || pyr.cancelled) return null;

    const lvl = pyramidLevelForEff(ds, eff);
    const fallbackViewport = ((viewportW == null || viewportH == null) && typeof getViewportSize === "function")
      ? getViewportSize()
      : null;
    const width = Math.max(1, Number(viewportW ?? fallbackViewport?.width) || 1);
    const height = Math.max(1, Number(viewportH ?? fallbackViewport?.height) || 1);
    const levels = enqueueViewportTasks(ds, band, lvl, eff, width, height);
    const visible = levels.find((info) => info.level === lvl) || null;
    const visibleCached = levels.reduce((sum, info) => sum + info.cached, 0);
    const prefer = ds.__pyrPreferImmediate || visibleCached > 0;

    updatePyramidFocus(ds, band, lvl, eff, width, height);
    refillBackgroundTasks(ds);
    schedulePyramidWork(ds);

    let raster = prefer ? composePyramidRaster(ds, band, lvl, eff, width, height) : null;
    const needImmediateCoarse = !raster || raster.partial;
    if (needImmediateCoarse && pyr.maxLevel > lvl) {
      const loaded = await ensureViewportLevelCached(ds, band, pyr.maxLevel, eff, width, height, 16);
      if (loaded) {
        raster = composePyramidRaster(ds, band, lvl, eff, width, height);
      }
    }

    if (!raster && visible && visible.total <= 16) {
      const loaded = await ensureViewportLevelCached(ds, band, lvl, eff, width, height, 16);
      if (loaded) {
        raster = composePyramidRaster(ds, band, lvl, eff, width, height);
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
