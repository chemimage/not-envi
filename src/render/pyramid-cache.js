import { clamp } from "../core/utils.js";
import { resolveRasterSampling } from "./raster-geometry.js";
import { APP_CONFIG } from "../app/config.js";

const perfNow = () => (
  (typeof performance !== "undefined" && typeof performance.now === "function")
    ? performance.now()
    : Date.now()
);

function pyramidAbortError(message = "Pyramid tile read cancelled.") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function createTileReadAdmission(initialLimit) {
  let limit = Math.max(1, Math.floor(Number(initialLimit) || 1));
  let active = 0;
  let closed = false;
  const foreground = [];
  const background = [];

  const releaseSlot = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
      drain();
    };
  };

  const drain = () => {
    if (closed) return;
    while (active < limit) {
      const waiter = foreground.shift() || background.shift();
      if (!waiter) break;
      waiter.cleanup();
      if (waiter.signal?.aborted) {
        waiter.reject(pyramidAbortError());
        continue;
      }
      active += 1;
      waiter.resolve(releaseSlot());
    }
  };

  return {
    acquire(priority = "foreground", { signal } = {}) {
      if (closed || signal?.aborted) return Promise.reject(pyramidAbortError());
      return new Promise((resolve, reject) => {
        const queue = priority === "background" ? background : foreground;
        const onAbort = () => {
          const index = queue.indexOf(waiter);
          if (index < 0) return;
          queue.splice(index, 1);
          waiter.cleanup();
          reject(pyramidAbortError());
          drain();
        };
        const waiter = { resolve, reject, signal,
          cleanup: () => signal?.removeEventListener("abort", onAbort) };
        signal?.addEventListener("abort", onAbort, { once: true });
        queue.push(waiter);
        drain();
      });
    },
    setLimit(value) {
      limit = Math.max(1, Math.floor(Number(value) || 1));
      drain();
    },
    cancel() {
      if (closed) return;
      closed = true;
      const error = pyramidAbortError();
      for (const waiter of [...foreground.splice(0), ...background.splice(0)]) {
        waiter.cleanup();
        waiter.reject(error);
      }
    },
    get active() { return active; },
    get waiting() { return foreground.length + background.length; }
  };
}

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
  if (!ds?.meta || !pyr || !Number.isFinite(Number(pyr.tileSize)) || Number(pyr.tileSize) <= 0) {
    return null;
  }
  const step = 1 << level;
  const downW = Math.ceil(ds.meta.samples / step);
  const downH = Math.ceil(ds.meta.lines / step);
  const tilesX = Math.max(1, Math.ceil(downW / pyr.tileSize));
  const tilesY = Math.max(1, Math.ceil(downH / pyr.tileSize));
  return { step, downW, downH, tilesX, tilesY };
}

export function viewTileBounds(ds, pyr, level, eff, viewportW, viewportH) {
  const info = levelInfo(ds, pyr, level);
  if (!info || !ds?.view) return null;
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

function clearTaskQueue(pyr, queueName) {
  const queue = pyr?.[queueName];
  if (!Array.isArray(queue) || !queue.length) return;
  for (const task of queue) {
    if (task?.key) pyr.queued.delete(task.key);
  }
  queue.length = 0;
}

function clearQueuedFocusTasks(pyr) {
  clearTaskQueue(pyr, "qHi");
  clearTaskQueue(pyr, "qLo");
}

function getPinnedOverviewLevels(pyr) {
  const count = clamp(
    Math.floor(Number(APP_CONFIG.pyramid.pinnedOverviewLevels) || 0),
    0,
    Math.max(0, Number(pyr?.maxLevel) || 0) + 1
  );
  const levels = [];
  for (let index = 0; index < count; index += 1) {
    levels.push(Math.max(0, Number(pyr?.maxLevel) - index));
  }
  return levels;
}

function isPinnedOverviewLevel(pyr, level) {
  return getPinnedOverviewLevels(pyr).includes(Math.max(0, Math.floor(Number(level) || 0)));
}

function resolveDirectionalIntent(ds) {
  const motion = ds?.prefetchMotion || null;
  if (!motion) return null;
  const age = perfNow() - (Number(motion.at) || 0);
  if (age > Number(APP_CONFIG.pyramid.directionalIntentMaxAgeMs || 0)) return null;
  const dx = Number(motion.dx) || 0;
  const dy = Number(motion.dy) || 0;
  const magnitude = Math.hypot(dx, dy);
  if (magnitude < Number(APP_CONFIG.pyramid.directionalIntentMinImageDelta || 0)) return null;
  return {
    dx: dx / magnitude,
    dy: dy / magnitude
  };
}

function resolveDirectionalBucket(ds) {
  const intent = resolveDirectionalIntent(ds);
  if (!intent) return "0:0";
  const bucketX = Math.abs(intent.dx) < 0.35 ? 0 : (intent.dx > 0 ? 1 : -1);
  const bucketY = Math.abs(intent.dy) < 0.35 ? 0 : (intent.dy > 0 ? 1 : -1);
  return `${bucketX}:${bucketY}`;
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
        centerDistance: Math.abs(tx - centerX) + Math.abs(ty - centerY),
        tileCenterX: tx + 0.5,
        tileCenterY: ty + 0.5,
        viewportCenterX: centerX + 0.5,
        viewportCenterY: centerY + 0.5
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
  const intent = resolveDirectionalIntent(ds);
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
          const offsetX = Number(task.tileCenterX || 0) - Number(task.viewportCenterX || 0);
          const offsetY = Number(task.tileCenterY || 0) - Number(task.viewportCenterY || 0);
          const forward = intent
            ? ((offsetX * intent.dx) + (offsetY * intent.dy))
            : 0;
          const lateral = intent
            ? Math.abs((-intent.dy * offsetX) + (intent.dx * offsetY))
            : 0;
          candidates.push({
            ...task,
            bandDistance,
            score: (task.radius * 8)
              + (bandDistance * 10)
              + (info.levelIndex * 3)
              + (task.centerDistance * 0.25)
              - (Math.max(-2, Math.min(4, forward)) * Number(APP_CONFIG.pyramid.directionalBiasFactor || 0))
              + (Math.max(0, Math.min(4, lateral)) * Number(APP_CONFIG.pyramid.directionalLateralPenalty || 0))
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
    getVisibleDatasetIds,
    getVisibleViews,
    getViewportSize,
    getIOConcurrency
  } = deps;

  function isDatasetForeground(dsId) {
    if (typeof getVisibleDatasetIds === "function") {
      const ids = getVisibleDatasetIds();
      if (Array.isArray(ids) && ids.length) {
        const key = String(dsId ?? "");
        return ids.some((id) => String(id ?? "") === key);
      }
    }
    return getActiveDatasetId() === dsId;
  }

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
      let oldestKey = null;
      for (const key of pyr.tiles.keys()) {
        if (!pyr.pinnedKeys?.has(key)) {
          oldestKey = key;
          break;
        }
        if (oldestKey == null) oldestKey = key;
      }
      if (!oldestKey) break;
      const tile = pyr.tiles.get(oldestKey);
      pyr.tiles.delete(oldestKey);
      pyr.pinnedKeys?.delete(oldestKey);
      if (tile) pyr.totalBytes -= tile.bytes || 0;
    }
  }

  function initPyramid(ds) {
    const tileSize = APP_CONFIG.pyramid.tileSize;
    const maxLevel = computeMaxPyramidLevel(ds.meta, tileSize);
    const ioConcurrency = Math.max(1, getIOConcurrency());
    const maxInflight = resolveMaxInflight(ioConcurrency);
    ds.pyramid = {
      tileSize,
      maxLevel,
      limitBytes: ds.pyramidBudgetBytes || APP_CONFIG.pyramid.defaultLimitBytes,
      totalBytes: 0,
      tiles: new Map(),
      pending: new Map(),
      requests: new Map(),
      inflight: new Set(),
      maxInflight,
      readAdmission: createTileReadAdmission(maxInflight),
      queued: new Set(),
      pinnedKeys: new Set(),
      tick: 0,
      cancelled: false,
      qHi: [],
      qLo: [],
      focus: null,
      focusEpoch: 0,
      _idleHandle: null,
      _lastKick: 0,
      stats: {
        tileReads: 0,
        tilePixelsRead: 0,
        tileReadMs: 0,
        cancelledTileReads: 0,
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
    ds.pyramid.readAdmission?.setLimit(ds.pyramid.maxInflight);
  }

  function disposePyramid(pyr) {
    if (!pyr) return;
    pyr.cancelled = true;
    for (const request of pyr.requests.values()) cancelTileRequest(pyr, request);
    pyr.readAdmission?.cancel();
    if (pyr._idleHandle) {
      try { cancelIdle(pyr._idleHandle); } catch (_err) {}
      pyr._idleHandle = null;
    }
    pyr.tiles.clear();
    pyr.pending.clear();
    if (pyr.inflight) pyr.inflight.clear();
    pyr.queued.clear();
    pyr.pinnedKeys?.clear();
    pyr.qHi.length = 0;
    pyr.qLo.length = 0;
    pyr.focus = null;
    pyr.totalBytes = 0;
  }

  function cancelTileRequest(pyr, request) {
    if (request.controller.signal.aborted) return;
    // Detach before aborting: returning to this tile may create a replacement
    // while the cancelled backend still settles. Old finalizers must not remove
    // that replacement's pending promise or queue membership.
    if (pyr.requests.get(request.key) === request) {
      pyr.requests.delete(request.key);
      pyr.pending.delete(request.key);
      pyr.queued.delete(request.key);
    }
    pyr.stats.cancelledTileReads += 1;
    request.controller.abort();
  }

  function tileStillUseful(ds, request, bands, minLevel, eff, width, height, view = ds.view) {
    const pyr = ds.pyramid;
    if (!bands.includes(request.band)) return false;
    // Complete overview tiles remain useful across pans. Visible overlapping
    // tiles keep their original request/lease rather than restarting the read.
    if (isPinnedOverviewLevel(pyr, request.level)) return true;
    if (request.level < minLevel) return false;
    const bounds = viewTileBounds({ meta: ds.meta, view }, pyr, request.level, eff, width, height);
    return !!bounds && request.tx >= bounds.tx0 && request.tx <= bounds.tx1
      && request.ty >= bounds.ty0 && request.ty <= bounds.ty1;
  }

  function enqueueBandTask(ds, band, level, tx, ty, hi) {
    ensurePyramid(ds);
    const pyr = ds.pyramid;
    if (!pyr || pyr.cancelled) return;

    const key = bandTileKey(band, level, tx, ty);
    if (pyr.tiles.has(key) || pyr.pending.has(key) || pyr.queued.has(key)) return;

    pyr.queued.add(key);
    const task = { band, level, tx, ty, key };
    if (hi) {
      pyr.qHi.push(task);
      pyr.foregroundDirty = true;
    }
    else pyr.qLo.push(task);
  }

  function collectViewportLevel(ds, pyr, band, level, eff, viewportW, viewportH) {
    if (!pyr) return null;
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

  function collectOverviewTasks(ds, band) {
    const pyr = ds?.pyramid;
    if (!pyr) return [];
    const tasks = [];
    for (const level of getPinnedOverviewLevels(pyr)) {
      const info = levelInfo(ds, pyr, level);
      if (!info) continue;
      for (let ty = 0; ty < info.tilesY; ty += 1) {
        for (let tx = 0; tx < info.tilesX; tx += 1) {
          tasks.push({
            band,
            level,
            tx,
            ty,
            key: bandTileKey(band, level, tx, ty)
          });
        }
      }
    }
    return tasks;
  }

  function enqueueOverviewTasks(ds, band, hi = true) {
    for (const task of collectOverviewTasks(ds, band)) {
      const pyr = ds?.pyramid;
      if (!pyr || pyr.tiles.has(task.key) || pyr.pending.has(task.key)) continue;
      enqueueBandTask(ds, task.band, task.level, task.tx, task.ty, hi);
    }
  }

  async function ensureOverviewLevelsCached(ds, band, maxTiles = APP_CONFIG.pyramid.immediateOverviewMaxTiles) {
    const pyr = ds?.pyramid;
    if (!pyr || pyr.cancelled) return false;
    const missing = collectOverviewTasks(ds, band).filter((task) => !pyr.tiles.has(task.key));
    if (!missing.length) return true;
    if (missing.length > Math.max(1, Number(maxTiles) || 1)) return false;
    await Promise.all(missing.map((task) => getBandTile(ds, band, task.level, task.tx, task.ty).catch(() => null)));
    return !!ds?.pyramid && !ds.pyramid.cancelled;
  }

  function updatePyramidFocus(ds, band, bands, minLevel, eff, viewportW, viewportH) {
    const pyr = ds.pyramid;
    if (!pyr) return;
    const bounds = viewTileBounds(ds, pyr, minLevel, eff, viewportW, viewportH);
    if (!bounds) return;
    const directionKey = resolveDirectionalBucket(ds);
    const key = [
      bands.join(","),
      Math.floor(Number(minLevel) || 0),
      Math.floor(Number(bounds?.tx0) || 0),
      Math.floor(Number(bounds?.ty0) || 0),
      Math.floor(Number(bounds?.tx1) || 0),
      Math.floor(Number(bounds?.ty1) || 0),
      Math.round(Number(viewportW) || 0),
      Math.round(Number(viewportH) || 0),
      directionKey
    ].join("|");
    if (pyr.focus?.key !== key) {
      pyr.focusEpoch += 1;
      clearQueuedFocusTasks(pyr);
      const visibleViews = getVisibleViews?.(ds) || [];
      for (const request of pyr.requests.values()) {
        const useful = tileStillUseful(ds, request, bands, minLevel, eff, viewportW, viewportH)
          || visibleViews.some((visible) => tileStillUseful(ds, request, visible.bands,
            pyramidLevelForEff(ds, visible.eff), visible.eff, visible.width, visible.height, visible.view));
        if (!useful) cancelTileRequest(pyr, request);
      }
    }
    pyr.focus = {
      key,
      band: Math.floor(Number(band) || 0),
      bands,
      minLevel: Math.floor(Number(minLevel) || 0),
      eff,
      viewportW,
      viewportH,
      directionKey
    };
  }

  function prioritizeForeground(ds) {
    const pyr = ds.pyramid;
    if (!pyr.foregroundDirty || !pyr.focus) return;
    pyr.foregroundDirty = false;
    const { minLevel, eff, viewportW, viewportH } = pyr.focus;
    const centerX = ds.view.x + viewportW / (2 * eff);
    const centerY = ds.view.y + viewportH / (2 * eff);
    // Keep the pinned coarse fallback first, then sharpen the requested zoom
    // from its center outward. Matching spatial tiles across visible bands are
    // adjacent in the queue; a whole band's intermediate levels cannot delay
    // the other channels. Per-band reads/cache keys remain independent.
    const ranked = pyr.qHi.map((task) => {
      const span = pyr.tileSize * (1 << task.level);
      const dx = task.tx + 0.5 - centerX / span;
      const dy = task.ty + 0.5 - centerY / span;
      return { task, rank: isPinnedOverviewLevel(pyr, task.level) ? 0 : task.level === minLevel ? 1 : 2,
        distance: dx * dx + dy * dy };
    });
    ranked.sort((a, b) => a.rank - b.rank || b.task.level - a.task.level
      || a.distance - b.distance || a.task.ty - b.task.ty || a.task.tx - b.task.tx
      || a.task.band - b.task.band);
    pyr.qHi = ranked.map(({ task }) => task);
  }

  async function ensureViewportLevelCached(ds, band, level, eff, viewportW, viewportH, maxTiles = 16) {
    const pyr = ds.pyramid;
    if (!pyr || pyr.cancelled) return false;
    const info = collectViewportLevel(ds, pyr, band, level, eff, viewportW, viewportH);
    if (!info || !info.total) return false;
    const missing = info.tasks.filter((task) => !pyr.tiles.has(task.key));
    if (!missing.length) return true;
    if (missing.length > maxTiles) return false;
    await Promise.all(missing.map((task) => (
      getBandTile(ds, band, task.level, task.tx, task.ty).catch(() => null)
    )));
    return !!ds?.pyramid && !ds.pyramid.cancelled;
  }

  function composePyramidRaster(ds, band, idealLevel, eff, viewportW, viewportH) {
    const pyr = ds.pyramid;
    if (!pyr || pyr.cancelled) return null;
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
    // Blank viewport margins outside the image are intentional NaNs, not
    // outstanding tile reads. Completion only counts in-image output pixels.
    const validX0 = sampling ? sampling.colStart : Math.max(0, -winX0);
    const validY0 = sampling ? sampling.rowStart : Math.max(0, -winY0);
    const validX1 = sampling ? validX0 + sampling.validW : Math.min(winW, ideal.bounds.info.downW - winX0);
    const validY1 = sampling ? validY0 + sampling.validH : Math.min(winH, ideal.bounds.info.downH - winY0);
    const requiredW = Math.max(0, validX1 - validX0);
    const requiredH = Math.max(0, validY1 - validY0);
    const requiredPixels = requiredW * requiredH;
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
          const dstY0 = Math.max(validY0, dstOriginY + (sy * factor));
          const dstY1 = Math.min(validY1, dstOriginY + ((sy + 1) * factor));
          const srcRow = (sy - tileDy0) * tile.w;
          for (let sx = ovX0; sx < ovX1; sx += 1) {
            const value = tile.data[srcRow + (sx - tileDx0)];
            const dstX0 = Math.max(validX0, dstOriginX + (sx * factor));
            const dstX1 = Math.min(validX1, dstOriginX + ((sx + 1) * factor));
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
      partial: filledCount < requiredPixels,
      coverage: filledCount / Math.max(1, requiredPixels),
      approximate: ideal.cached < ideal.total
    };
  }

  function refillBackgroundTasks(ds) {
    const pyr = ds.pyramid;
    if (!pyr || pyr.cancelled) return;
    const focus = pyr.focus;
    if (!focus) return;
    const queueSoftMax = Math.max(1, Number(APP_CONFIG.pyramid.backgroundQueueSoftMax) || 1);
    if (pyr.qLo.length >= queueSoftMax) return;
    const remaining = Math.max(1, queueSoftMax - pyr.qLo.length);
    const planLimit = Math.min(
      remaining,
      Math.max(1, Number(APP_CONFIG.pyramid.backgroundPrefetchPlanLimit) || remaining)
    );
    const plan = buildPyramidPrefetchPlan(ds, focus.band, focus.minLevel, focus.eff, focus.viewportW, focus.viewportH, planLimit, 6);
    for (const task of plan) enqueueBandTask(ds, task.band, task.level, task.tx, task.ty, false);
  }

  async function getBandTile(ds, band, level, tx, ty, priority = "foreground") {
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
    const request = { key, band, level, tx, ty, controller: new AbortController() };
    pyr.requests.set(key, request);
    const requireCurrent = () => {
      if (ds.pyramid !== pyr || pyr.cancelled || request.controller.signal.aborted
        || pyr.requests.get(key) !== request) throw pyramidAbortError();
    };
    const p = (async () => {
      const releaseRead = await pyr.readAdmission.acquire(priority, { signal: request.controller.signal });
      try {
        requireCurrent();
        const readStart = perfNow();
        const step = 1 << level;
        const x0 = tx * pyr.tileSize * step;
        const y0 = ty * pyr.tileSize * step;

        const outW = Math.min(pyr.tileSize, Math.ceil((ds.meta.samples - x0) / step));
        const outH = Math.min(pyr.tileSize, Math.ceil((ds.meta.lines - y0) / step));
        if (outW <= 0 || outH <= 0) return null;

        let data;
        const readOptions = {
          signal: request.controller.signal,
          cancelled: () => ds.pyramid !== pyr || pyr.cancelled || request.controller.signal.aborted,
          priority: priority === "background" ? "background" : "foreground"
        };
        if (ds.meta.interleave === "bip") {
          data = await readBandWindowBIP(ds.meta, ds.ds, band, x0, y0, outW, outH, step, null, readOptions);
        } else {
          data = await readBandWindow(ds.meta, ds.ds, band, x0, y0, outW, outH, step, null, readOptions);
        }

        requireCurrent();

        const tile = { band, level, tx, ty, data, w: outW, h: outH, bytes: data.byteLength, t: ++ds.pyramid.tick };
        ds.pyramid.tiles.set(key, tile);
        if (isPinnedOverviewLevel(ds.pyramid, level)) ds.pyramid.pinnedKeys.add(key);
        else ds.pyramid.pinnedKeys.delete(key);
        ds.pyramid.totalBytes += tile.bytes;
        ds.pyramid.stats.tileReads += 1;
        ds.pyramid.stats.tilePixelsRead += outW * outH;
        ds.pyramid.stats.tileReadMs += perfNow() - readStart;
        evictPyramidIfNeeded(ds.pyramid);
        return tile;
      } finally {
        releaseRead();
      }
    })().finally(() => {
      if (pyr.requests.get(key) === request) {
        pyr.requests.delete(key);
        pyr.pending.delete(key);
        pyr.queued.delete(key);
      }
    });

    pyr.pending.set(key, p);
    return p;
  }

  function schedulePyramidWork(ds) {
    const pyr = ds.pyramid;
    if (!pyr || pyr.cancelled) return;
    if (!isDatasetForeground(ds.id)) return;
    if (pyr._idleHandle) return;
    // Tile completions wake capacity waiters. Polling a full/empty queue via
    // idle callbacks otherwise creates another render -> idle -> render loop.
    if ((!pyr.qHi.length && !pyr.qLo.length) || pyr.inflight.size >= pyr.maxInflight) return;

    pyr._idleHandle = requestIdle(() => {
      pyr._idleHandle = null;
      if (!ds.pyramid || ds.pyramid.cancelled) return;
      if (!isDatasetForeground(ds.id)) return;

      const maxInflight = pyr.maxInflight || 2;
      while (pyr.inflight && pyr.inflight.size < maxInflight) {
        const highPriority = pyr.qHi.length > 0;
        const task = (highPriority ? pyr.qHi.shift() : pyr.qLo.shift()) || null;
        if (!task) break;

        const p = getBandTile(ds, task.band, task.level, task.tx, task.ty, highPriority ? "foreground" : "background")
          .catch(() => {})
          .finally(() => {
            try { if (pyr.inflight) pyr.inflight.delete(p); } catch (_err) {}
            onPerfUpdate();

            const tKick = now();
            const finished = !pyr.qHi.length && !pyr.qLo.length && !pyr.inflight.size;
            if (finished || !pyr._lastKick || (tKick - pyr._lastKick) > 90) {
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

  async function tryRasterFromPyramid(ds, band, eff, viewportW = null, viewportH = null, options = {}) {
    ensurePyramid(ds);
    const pyr = ds.pyramid;
    if (!pyr || pyr.cancelled) return null;

    const lvl = pyramidLevelForEff(ds, eff);
    const fallbackViewport = ((viewportW == null || viewportH == null) && typeof getViewportSize === "function")
      ? getViewportSize()
      : null;
    const width = Math.max(1, Number(viewportW ?? fallbackViewport?.width) || 1);
    const height = Math.max(1, Number(viewportH ?? fallbackViewport?.height) || 1);
    const bands = [...new Set([band, ...(options.bands || [])])]
      .filter((value) => Number.isInteger(value) && value >= 0 && value < (ds.meta.bands || 1))
      .sort((a, b) => a - b);
    updatePyramidFocus(ds, band, bands, lvl, eff, width, height);
    const focusEpoch = pyr.focusEpoch;
    const currentFocus = () => ds.pyramid === pyr && !pyr.cancelled && pyr.focusEpoch === focusEpoch;
    let levels = [];
    for (const visibleBand of bands) {
      enqueueOverviewTasks(ds, visibleBand, true);
      const bandLevels = enqueueViewportTasks(ds, visibleBand, lvl, eff, width, height);
      if (visibleBand === band) levels = bandLevels;
    }
    prioritizeForeground(ds);
    const visible = levels.find((info) => info.level === lvl) || null;
    const visibleCached = levels.reduce((sum, info) => sum + info.cached, 0);
    const prefer = ds.__pyrPreferImmediate || visibleCached > 0;

    refillBackgroundTasks(ds);
    schedulePyramidWork(ds);

    let raster = prefer ? composePyramidRaster(ds, band, lvl, eff, width, height) : null;
    if ((!raster || raster.partial) && eff < 1) {
      const loaded = await ensureOverviewLevelsCached(ds, band, APP_CONFIG.pyramid.immediateOverviewMaxTiles);
      if (!currentFocus()) return null;
      if (loaded) {
        raster = composePyramidRaster(ds, band, lvl, eff, width, height) || raster;
      }
    }
    const needImmediateCoarse = !raster || raster.partial;
    if (needImmediateCoarse && pyr.maxLevel > lvl) {
      const loaded = await ensureViewportLevelCached(
        ds,
        band,
        pyr.maxLevel,
        eff,
        width,
        height,
        APP_CONFIG.pyramid.immediateCoarseMaxTiles
      );
      if (!currentFocus()) return null;
      if (loaded) {
        raster = composePyramidRaster(ds, band, lvl, eff, width, height);
      }
    }

    if (!raster && visible && visible.total <= APP_CONFIG.pyramid.immediateVisibleMaxTiles) {
      const loaded = await ensureViewportLevelCached(
        ds,
        band,
        lvl,
        eff,
        width,
        height,
        APP_CONFIG.pyramid.immediateVisibleMaxTiles
      );
      if (!currentFocus()) return null;
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
