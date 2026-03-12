import { distanceToDrawing, pointInPolygon } from "./draw-geometry.js";

export function createAnnotationController(deps) {
  const {
    state,
    els,
    clamp,
    getActive,
    screenToImage,
    render,
    getSpectrumOpenForDatasetId,
    openSpectrumAt,
    positionAnalysisHistogramPanel,
    updateSelectionHistogramForDataset,
    ensureMarqueeTicker,
    refreshAnalysisHistogram,
    isAnalysisHistogramOpen,
    isDatasetActive
  } = deps;

  function pointerToImagePoint(ev, ds) {
    const rect = els.main.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const sx = (ev.clientX - rect.left) * dpr;
    const sy = (ev.clientY - rect.top) * dpr;
    const img = screenToImage(sx, sy);
    return {
      x: clamp(img.x, 0, Math.max(0, ds.meta.samples - 1)),
      y: clamp(img.y, 0, Math.max(0, ds.meta.lines - 1))
    };
  }

  function getDrawTool() {
    return state.draw.tool;
  }

  function getSpectrumPickEnabled() {
    return !!state.spectrumPickEnabled;
  }

  function setSpectrumPickEnabled(next = null) {
    const enabled = (typeof next === "boolean") ? next : !state.spectrumPickEnabled;
    if (enabled === state.spectrumPickEnabled) return enabled;
    state.spectrumPickEnabled = enabled;
    if (enabled) {
      const hadDraft = !!state.draw.draft;
      const hadRulerDrag = !!state.draw.rulerDrag;
      const hadRulerMove = !!state.draw.rulerMove;
      const hadRulerHover = !!state.draw.rulerHover;
      const hadAreaMove = !!state.draw.areaMove;
      if (state.draw.tool !== "none" || hadDraft || hadRulerDrag || hadRulerMove || hadRulerHover || hadAreaMove) {
        state.draw.tool = "none";
        state.draw.activePointerId = null;
        state.draw.draft = null;
        state.draw.rulerDrag = null;
        state.draw.rulerMove = null;
        state.draw.rulerHover = null;
        state.draw.areaMove = null;
        render({ reuseRaster: true });
      }
    }
    return enabled;
  }

  function getDrawColor() {
    return state.draw.color;
  }

  function setDrawTool(tool) {
    const hadDraft = !!state.draw.draft;
    const hadRulerDrag = !!state.draw.rulerDrag;
    const hadRulerMove = !!state.draw.rulerMove;
    const hadRulerHover = !!state.draw.rulerHover;
    const hadAreaMove = !!state.draw.areaMove;
    const prevTool = state.draw.tool;
    const next = (tool === "ruler" || tool === "rect" || tool === "shape" || tool === "eraser") ? tool : "none";
    if (next !== "none") state.spectrumPickEnabled = false;
    state.draw.tool = (prevTool === next) ? "none" : next;
    const isCreateTool = state.draw.tool === "ruler" || state.draw.tool === "rect" || state.draw.tool === "shape";
    if (state.draw.tool !== prevTool || !isCreateTool) {
      state.draw.activePointerId = null;
      state.draw.draft = null;
      state.draw.rulerDrag = null;
      state.draw.rulerMove = null;
      state.draw.rulerHover = null;
      state.draw.areaMove = null;
      if (hadDraft || hadRulerDrag || hadRulerMove || hadRulerHover || hadAreaMove) render({ reuseRaster: true });
    }
  }

  function setDrawColor(color) {
    if (!color || typeof color !== "string") return;
    state.draw.color = color;
  }

  function getAreaSelectionMode() {
    return state.areaSelectionMode === "single" ? "single" : "group";
  }

  function isAreaSelectionGrouped() {
    return getAreaSelectionMode() === "group";
  }

  function isHistogramSelectionTool(item) {
    return !!(item && (item.tool === "rect" || item.tool === "shape"));
  }

  function listHistogramSelectionItems(ds) {
    if (!ds || !Array.isArray(ds.drawings)) return [];
    return ds.drawings.filter((item) => isHistogramSelectionTool(item));
  }

  function latestHistogramSelectionItem(ds) {
    if (!ds || !Array.isArray(ds.drawings)) return null;
    for (let i = ds.drawings.length - 1; i >= 0; i -= 1) {
      const item = ds.drawings[i];
      if (isHistogramSelectionTool(item) && Number.isFinite(item.id)) return item;
    }
    return null;
  }

  function ensureSelectedAreaId(ds, { preferLatest = true } = {}) {
    if (!ds) return null;
    const items = listHistogramSelectionItems(ds);
    if (!items.length) {
      ds.selectedAreaId = null;
      return null;
    }
    const current = ds.selectedAreaId;
    const hasCurrent = Number.isFinite(current) && items.some((item) => item.id === current);
    if (hasCurrent) return current;
    if (!preferLatest) return null;
    const latest = latestHistogramSelectionItem(ds);
    ds.selectedAreaId = latest ? latest.id : null;
    return ds.selectedAreaId;
  }

  function getHistogramSelectionItems(ds) {
    const items = listHistogramSelectionItems(ds);
    if (!items.length) return [];
    if (isAreaSelectionGrouped()) return items;
    const selectedId = ensureSelectedAreaId(ds, { preferLatest: true });
    if (!Number.isFinite(selectedId)) return [];
    return items.filter((item) => item.id === selectedId);
  }

  function histogramSelectionKeyFromItems(items) {
    if (!Array.isArray(items) || !items.length) return "";
    return items
      .filter((item) => Number.isFinite(item.id))
      .sort((a, b) => a.id - b.id)
      .map((item) => String(item.id))
      .join(",");
  }

  function getEffectiveAreaSelectionKey(ds = null) {
    const target = ds || getActive();
    if (!target) return "";
    return histogramSelectionKeyFromItems(getHistogramSelectionItems(target));
  }

  function getEffectiveAreaSelectionCount(ds = null) {
    const target = ds || getActive();
    if (!target) return 0;
    return getHistogramSelectionItems(target).length;
  }

  function setSelectedAreaId(ds, nextId) {
    if (!ds) return false;
    const items = listHistogramSelectionItems(ds);
    if (!items.length) {
      if (ds.selectedAreaId == null) return false;
      ds.selectedAreaId = null;
      return true;
    }
    const resolved = Number.isFinite(nextId) && items.some((item) => item.id === nextId)
      ? nextId
      : null;
    const fallback = (resolved == null) ? ensureSelectedAreaId(ds, { preferLatest: true }) : resolved;
    if (ds.selectedAreaId === fallback) return false;
    ds.selectedAreaId = fallback;
    return true;
  }

  function rectBoundsFromItem(item) {
    if (!item || !Array.isArray(item.points) || item.points.length < 2) return null;
    const a = item.points[0];
    const b = item.points[item.points.length - 1];
    return {
      x0: Math.min(a.x, b.x),
      y0: Math.min(a.y, b.y),
      x1: Math.max(a.x, b.x),
      y1: Math.max(a.y, b.y)
    };
  }

  function pointInsideArea(item, point) {
    if (!item || !point) return false;
    if (item.tool === "rect") {
      const box = rectBoundsFromItem(item);
      if (!box) return false;
      return point.x >= box.x0 && point.x <= box.x1 && point.y >= box.y0 && point.y <= box.y1;
    }
    if (item.tool === "shape" && Array.isArray(item.points) && item.points.length >= 3) {
      return pointInPolygon(point, item.points);
    }
    return false;
  }

  function activeAreaToolFilter() {
    if (state.draw.tool === "rect") return "rect";
    if (state.draw.tool === "shape") return "shape";
    return null;
  }

  function findRectHandleAtPoint(item, point, tolImg) {
    const box = rectBoundsFromItem(item);
    if (!box) return null;
    const { x0, y0, x1, y1 } = box;
    const minDim = Math.max(1e-6, Math.min(x1 - x0, y1 - y0));
    const cornerTol = Math.max(1, Math.min(tolImg, minDim * 0.2));
    const edgeTol = Math.max(1, Math.min(tolImg, minDim * 0.18));

    const corners = [
      { key: "nw", x: x0, y: y0 },
      { key: "ne", x: x1, y: y0 },
      { key: "sw", x: x0, y: y1 },
      { key: "se", x: x1, y: y1 }
    ];
    let bestCorner = null;
    let bestCornerDist = Number.POSITIVE_INFINITY;
    for (const c of corners) {
      const d = Math.hypot(point.x - c.x, point.y - c.y);
      if (d <= cornerTol && d < bestCornerDist) {
        bestCornerDist = d;
        bestCorner = c.key;
      }
    }
    if (bestCorner) return bestCorner;

    const withinX = point.x >= (x0 - edgeTol) && point.x <= (x1 + edgeTol);
    const withinY = point.y >= (y0 - edgeTol) && point.y <= (y1 + edgeTol);
    if (withinX && Math.abs(point.y - y0) <= edgeTol) return "n";
    if (withinX && Math.abs(point.y - y1) <= edgeTol) return "s";
    if (withinY && Math.abs(point.x - x0) <= edgeTol) return "w";
    if (withinY && Math.abs(point.x - x1) <= edgeTol) return "e";
    return null;
  }

  function findAreaHitAtPointer(ds, ev, options = null) {
    if (!ds) return null;
    const opt = options || {};
    const toolFilter = (opt.toolFilter === "rect" || opt.toolFilter === "shape") ? opt.toolFilter : null;
    const items = listHistogramSelectionItems(ds);
    if (!items.length) return null;
    const point = pointerToImagePoint(ev, ds);
    const pxTolerance = (ev.pointerType === "touch") ? 24 : 14;
    const imgTolerance = pxTolerance / Math.max(1e-6, ds.view.scale);
    let best = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (toolFilter && item.tool !== toolFilter) continue;
      const inside = pointInsideArea(item, point);
      if (inside) {
        best = item;
        bestDist = -1;
        break;
      }
      const dist = distanceToDrawing(point, item);
      if (!Number.isFinite(dist) || dist > imgTolerance || dist > bestDist) continue;
      best = item;
      bestDist = dist;
      if (dist <= 0) break;
    }
    if (!best || !Number.isFinite(best.id)) return null;
    return { item: best, point, imgTolerance };
  }

  function refreshAreaSpectrumIfOpen(ds, anchor = null, noReposition = false) {
    if (!ds || !state.spectrumPickEnabled) return;
    if (!getSpectrumOpenForDatasetId || !getSpectrumOpenForDatasetId(ds.id)) return;
    const selections = getHistogramSelectionItems(ds);
    if (!selections.length) return;
    openSpectrumAt(ds, 0, 0, {
      clientX: Number(anchor?.clientX),
      clientY: Number(anchor?.clientY),
      pointerType: anchor?.pointerType === "touch" ? "touch" : "mouse",
      noReposition: !!noReposition,
      forceArea: true
    }).catch(() => {});
  }

  function setAreaSelectionMode(next = null) {
    const current = getAreaSelectionMode();
    const target = (next === "single" || next === "group") ? next : (current === "group" ? "single" : "group");
    if (target === current) return current;
    state.areaSelectionMode = target;
    const ds = getActive();
    if (ds && target === "single") ensureSelectedAreaId(ds, { preferLatest: true });
    if (ds) {
      updateSelectionHistogramForDataset(ds);
      refreshAreaSpectrumIfOpen(ds, null, false);
    }
    ensureMarqueeTicker();
    render({ reuseRaster: true });
    return target;
  }

  function selectAreaAtPointer(ev) {
    const ds = getActive();
    if (!ds) return false;
    const hit = findAreaHitAtPointer(ds, ev);
    if (!hit) return false;
    const changed = setSelectedAreaId(ds, hit.item.id);
    if (changed) {
      updateSelectionHistogramForDataset(ds);
      ensureMarqueeTicker();
      refreshAreaSpectrumIfOpen(ds, ev, false);
      render({ reuseRaster: true });
    }
    return true;
  }

  function isAreaMovePointer(pointerId) {
    return !!(Number.isFinite(pointerId) && state.draw.areaMove && state.draw.areaMove.activePointerId === pointerId);
  }

  function beginAreaMoveAtPointer(ev) {
    const ds = getActive();
    if (!ds) return false;
    const toolFilter = activeAreaToolFilter();
    if (!toolFilter) return false;
    const hit = findAreaHitAtPointer(ds, ev, { toolFilter });
    if (!hit) return false;
    const changed = setSelectedAreaId(ds, hit.item.id);
    if (changed) {
      updateSelectionHistogramForDataset(ds);
      ensureMarqueeTicker();
    }
    let mode = "move";
    let resizeHandle = null;
    if (toolFilter === "rect" && hit.item.tool === "rect") {
      resizeHandle = findRectHandleAtPoint(hit.item, hit.point, hit.imgTolerance);
      if (resizeHandle) mode = "resize-rect";
    }
    const bounds = rectBoundsFromItem(hit.item);
    state.draw.areaMove = {
      activePointerId: ev.pointerId,
      dsId: ds.id,
      itemId: hit.item.id,
      mode,
      resizeHandle,
      lastPoint: hit.point,
      startPoint: hit.point,
      startBounds: bounds ? { ...bounds } : null,
      moved: false,
      lastRefreshMs: 0
    };
    if (changed) render({ reuseRaster: true });
    return true;
  }

  function refreshSelectionProductsForManipulation(ds, ev, moveState) {
    const wantsSpatial = !!(isAnalysisHistogramOpen && isAnalysisHistogramOpen() && isDatasetActive && isDatasetActive(ds));
    const wantsSpectral = !!(state.spectrumPickEnabled && getSpectrumOpenForDatasetId && getSpectrumOpenForDatasetId(ds.id));
    if (wantsSpatial && positionAnalysisHistogramPanel) positionAnalysisHistogramPanel();
    const nowMs = performance.now();
    if ((wantsSpatial || wantsSpectral) && (!Number.isFinite(moveState.lastRefreshMs) || (nowMs - moveState.lastRefreshMs) >= 120)) {
      moveState.lastRefreshMs = nowMs;
      if (wantsSpatial) updateSelectionHistogramForDataset(ds);
      if (wantsSpectral) refreshAreaSpectrumIfOpen(ds, ev, false);
    }
  }

  function updateRectResizeAtPointer(ev, ds, move, item) {
    if (!move || move.mode !== "resize-rect" || item.tool !== "rect") return false;
    const handle = move.resizeHandle;
    const start = move.startBounds;
    if (!handle || !start) return false;
    const p = pointerToImagePoint(ev, ds);
    const maxX = Math.max(0, ds.meta.samples - 1);
    const maxY = Math.max(0, ds.meta.lines - 1);
    const minSpan = Math.max(1e-6, 1 / Math.max(1e-6, ds.view.scale));

    let x0 = start.x0;
    let y0 = start.y0;
    let x1 = start.x1;
    let y1 = start.y1;
    if (handle.includes("w")) x0 = clamp(p.x, 0, maxX);
    if (handle.includes("e")) x1 = clamp(p.x, 0, maxX);
    if (handle.includes("n")) y0 = clamp(p.y, 0, maxY);
    if (handle.includes("s")) y1 = clamp(p.y, 0, maxY);

    if ((x1 - x0) < minSpan) {
      if (handle.includes("w")) x0 = x1 - minSpan;
      else if (handle.includes("e")) x1 = x0 + minSpan;
    }
    if ((y1 - y0) < minSpan) {
      if (handle.includes("n")) y0 = y1 - minSpan;
      else if (handle.includes("s")) y1 = y0 + minSpan;
    }

    x0 = clamp(x0, 0, maxX);
    x1 = clamp(x1, 0, maxX);
    y0 = clamp(y0, 0, maxY);
    y1 = clamp(y1, 0, maxY);
    if (x1 < x0) {
      const t = x0; x0 = x1; x1 = t;
    }
    if (y1 < y0) {
      const t = y0; y0 = y1; y1 = t;
    }

    const p0 = item.points[0];
    const p1 = item.points[item.points.length - 1];
    if (Math.abs(p0.x - x0) < 1e-9 && Math.abs(p0.y - y0) < 1e-9 && Math.abs(p1.x - x1) < 1e-9 && Math.abs(p1.y - y1) < 1e-9) {
      return true;
    }
    item.points[0] = { x: x0, y: y0 };
    item.points[item.points.length - 1] = { x: x1, y: y1 };
    move.lastPoint = p;
    move.moved = true;
    refreshSelectionProductsForManipulation(ds, ev, move);
    render({ reuseRaster: true });
    return true;
  }

  function updateAreaMoveAtPointer(ev) {
    const move = state.draw.areaMove;
    if (!move || move.activePointerId !== ev.pointerId) return false;
    const ds = getActive();
    if (!ds || ds.id !== move.dsId || !Array.isArray(ds.drawings)) return false;
    const item = ds.drawings.find((it) => it && it.id === move.itemId && isHistogramSelectionTool(it));
    if (!item || !Array.isArray(item.points) || !item.points.length) return false;
    if (move.mode === "resize-rect") return updateRectResizeAtPointer(ev, ds, move, item);

    const p = pointerToImagePoint(ev, ds);
    const dx = p.x - move.lastPoint.x;
    const dy = p.y - move.lastPoint.y;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) return true;

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const pt of item.points) {
      if (!pt) continue;
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return true;

    const maxShiftLeft = -minX;
    const maxShiftRight = (ds.meta.samples - 1) - maxX;
    const maxShiftUp = -minY;
    const maxShiftDown = (ds.meta.lines - 1) - maxY;
    const shiftX = clamp(dx, maxShiftLeft, maxShiftRight);
    const shiftY = clamp(dy, maxShiftUp, maxShiftDown);
    if (!shiftX && !shiftY) {
      move.lastPoint = p;
      return true;
    }
    for (const pt of item.points) {
      if (!pt) continue;
      pt.x += shiftX;
      pt.y += shiftY;
    }
    move.lastPoint = p;
    move.moved = true;
    refreshSelectionProductsForManipulation(ds, ev, move);
    render({ reuseRaster: true });
    return true;
  }

  function finishAreaMoveAtPointer(ev) {
    const move = state.draw.areaMove;
    if (!move || move.activePointerId !== ev.pointerId) return false;
    const ds = getActive();
    const moved = !!move.moved;
    state.draw.areaMove = null;
    if (moved && ds && ds.id === move.dsId) {
      updateSelectionHistogramForDataset(ds);
      ensureMarqueeTicker();
      refreshAreaSpectrumIfOpen(ds, ev, false);
    }
    render({ reuseRaster: true });
    return true;
  }

  function cancelAreaMove(pointerId = null) {
    if (!state.draw.areaMove) return false;
    if (Number.isFinite(pointerId) && state.draw.areaMove.activePointerId !== pointerId) return false;
    state.draw.areaMove = null;
    render({ reuseRaster: true });
    return true;
  }

  function resolvePointerCursor(ev) {
    const ds = getActive();
    if (!ds) return "";
    if (!ev) return "";
    const tool = state.draw.tool;
    if (tool === "ruler") {
      const point = pointerToImagePoint(ev, ds);
      if (findRulerEndpointHit(ds, point, ev.pointerType)) return "grab";
      if (findRulerBodyHit(ds, point, ev.pointerType)) return "move";
      return "";
    }
    if (tool === "rect") {
      const hit = findAreaHitAtPointer(ds, ev, { toolFilter: "rect" });
      if (!hit) return "";
      if (findRectHandleAtPoint(hit.item, hit.point, hit.imgTolerance)) return "grab";
      if (pointInsideArea(hit.item, hit.point)) return "move";
      return "";
    }
    if (tool === "shape") {
      const hit = findAreaHitAtPointer(ds, ev, { toolFilter: "shape" });
      if (!hit) return "";
      if (pointInsideArea(hit.item, hit.point)) return "move";
      return "";
    }
    return "";
  }

  function getDrawData(ds) {
    if (!ds) return null;
    const items = Array.isArray(ds.drawings) ? ds.drawings : [];
    const draft = (state.draw.draft && state.draw.draft.dsId === ds.id) ? state.draw.draft : null;
    const rulerHover = (state.draw.rulerHover && state.draw.rulerHover.dsId === ds.id) ? state.draw.rulerHover : null;
    const selectionItems = getHistogramSelectionItems(ds);
    const selectionIds = selectionItems
      .map((item) => item.id)
      .filter((id) => Number.isFinite(id));
    const marqueeOffset = selectionIds.length ? ((performance.now() / 110) % 14) : 0;
    return { items, draft, rulerHover, selectionIds, marqueeOffset };
  }

  function findRulerEndpointHit(ds, point, pointerType) {
    if (!ds || !Array.isArray(ds.drawings) || !ds.drawings.length) return null;
    const pxTolerance = (pointerType === "touch") ? 28 : 16;
    const imgTolerance = pxTolerance / Math.max(1e-6, ds.view.scale);
    let best = null;
    let bestDist = Number.POSITIVE_INFINITY;

    for (let i = ds.drawings.length - 1; i >= 0; i -= 1) {
      const item = ds.drawings[i];
      if (!item || (item.tool !== "ruler" && item.tool !== "line")) continue;
      if (!Array.isArray(item.points) || item.points.length < 2) continue;
      const lastIdx = item.points.length - 1;
      const d0 = Math.hypot(point.x - item.points[0].x, point.y - item.points[0].y);
      const d1 = Math.hypot(point.x - item.points[lastIdx].x, point.y - item.points[lastIdx].y);
      const minDist = Math.min(d0, d1);
      if (minDist > imgTolerance || minDist > bestDist) continue;
      bestDist = minDist;
      best = {
        drawingIndex: i,
        pointIndex: d0 <= d1 ? 0 : lastIdx
      };
    }
    return best;
  }

  function findRulerBodyHit(ds, point, pointerType) {
    if (!ds || !Array.isArray(ds.drawings) || !ds.drawings.length) return null;
    const bodyPxTolerance = (pointerType === "touch") ? 18 : 12;
    const endpointPxTolerance = (pointerType === "touch") ? 28 : 16;
    const bodyTol = bodyPxTolerance / Math.max(1e-6, ds.view.scale);
    const endpointTol = endpointPxTolerance / Math.max(1e-6, ds.view.scale);
    let best = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = ds.drawings.length - 1; i >= 0; i -= 1) {
      const item = ds.drawings[i];
      if (!item || (item.tool !== "ruler" && item.tool !== "line")) continue;
      if (!Array.isArray(item.points) || item.points.length < 2) continue;
      const d = distanceToDrawing(point, item);
      if (!Number.isFinite(d) || d > bodyTol || d > bestDist) continue;
      const lastIdx = item.points.length - 1;
      const d0 = Math.hypot(point.x - item.points[0].x, point.y - item.points[0].y);
      const d1 = Math.hypot(point.x - item.points[lastIdx].x, point.y - item.points[lastIdx].y);
      if (Math.min(d0, d1) <= endpointTol) continue;
      best = { drawingIndex: i };
      bestDist = d;
    }
    return best;
  }

  function sameRulerHandle(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.dsId === b.dsId && a.drawingIndex === b.drawingIndex && a.pointIndex === b.pointIndex;
  }

  function setRulerHover(nextHover) {
    if (sameRulerHandle(state.draw.rulerHover, nextHover)) return false;
    state.draw.rulerHover = nextHover;
    render({ reuseRaster: true });
    return true;
  }

  function clearRulerHover() {
    return setRulerHover(null);
  }

  function updateRulerHoverAtPointer(ev) {
    const ds = getActive();
    if (!ds || state.draw.tool !== "ruler") return clearRulerHover();
    const point = pointerToImagePoint(ev, ds);
    const hit = findRulerEndpointHit(ds, point, ev.pointerType);
    if (!hit) return clearRulerHover();
    return setRulerHover({
      dsId: ds.id,
      drawingIndex: hit.drawingIndex,
      pointIndex: hit.pointIndex
    });
  }

  function eraseDrawingAtPointer(ev) {
    const ds = getActive();
    if (!ds || !Array.isArray(ds.drawings) || !ds.drawings.length) return false;
    const point = pointerToImagePoint(ev, ds);
    const pxTolerance = (ev.pointerType === "touch") ? 24 : 14;
    const imgTolerance = pxTolerance / Math.max(1e-6, ds.view.scale);

    let bestIdx = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = ds.drawings.length - 1; i >= 0; i -= 1) {
      const dist = distanceToDrawing(point, ds.drawings[i]);
      if (!Number.isFinite(dist)) continue;
      if (dist <= imgTolerance && dist <= bestDist) {
        bestIdx = i;
        bestDist = dist;
      }
    }
    if (bestIdx < 0) return false;
    const [removed] = ds.drawings.splice(bestIdx, 1);
    const selectionChanged = !!(removed && isHistogramSelectionTool(removed));
    if (selectionChanged) {
      ensureSelectedAreaId(ds, { preferLatest: true });
      updateSelectionHistogramForDataset(ds);
    }
    ensureMarqueeTicker();
    if (!selectionChanged && isAnalysisHistogramOpen && isAnalysisHistogramOpen() && isDatasetActive && isDatasetActive(ds)) {
      refreshAnalysisHistogram().catch(() => {});
    }
    render({ reuseRaster: true });
    return true;
  }

  function clearAllAnnotations() {
    const ds = getActive();
    if (!ds) return false;
    if (!Array.isArray(ds.drawings)) ds.drawings = [];
    if (!ds.drawings.length) return false;
    ds.drawings.length = 0;
    ds.selectedAreaId = null;
    state.draw.activePointerId = null;
    state.draw.draft = null;
    state.draw.rulerDrag = null;
    state.draw.rulerMove = null;
    state.draw.rulerHover = null;
    state.draw.areaMove = null;
    updateSelectionHistogramForDataset(ds);
    ensureMarqueeTicker();
    render({ reuseRaster: true });
    return true;
  }

  function isDrawingPointer(pointerId) {
    return Number.isFinite(pointerId) && state.draw.activePointerId === pointerId;
  }

  function beginDrawingAtPointer(ev) {
    const ds = getActive();
    if (!ds) return false;
    if (!Array.isArray(ds.drawings)) ds.drawings = [];
    if (state.draw.tool === "ruler") {
      const pointer = pointerToImagePoint(ev, ds);
      const hit = findRulerEndpointHit(ds, pointer, ev.pointerType);
      if (hit) {
        state.draw.activePointerId = ev.pointerId;
        state.draw.rulerDrag = {
          dsId: ds.id,
          drawingIndex: hit.drawingIndex,
          pointIndex: hit.pointIndex
        };
        state.draw.rulerHover = {
          dsId: ds.id,
          drawingIndex: hit.drawingIndex,
          pointIndex: hit.pointIndex
        };
        state.draw.draft = null;
        render({ reuseRaster: true });
        return true;
      }
      const bodyHit = findRulerBodyHit(ds, pointer, ev.pointerType);
      if (bodyHit) {
        state.draw.activePointerId = ev.pointerId;
        state.draw.rulerMove = {
          dsId: ds.id,
          drawingIndex: bodyHit.drawingIndex,
          lastPoint: pointer
        };
        state.draw.rulerDrag = null;
        state.draw.rulerHover = null;
        state.draw.draft = null;
        render({ reuseRaster: true });
        return true;
      }
      state.draw.rulerHover = null;
    }
    const p = pointerToImagePoint(ev, ds);
    state.draw.activePointerId = ev.pointerId;
    state.draw.draft = {
      dsId: ds.id,
      tool: state.draw.tool,
      color: state.draw.color,
      points: [p]
    };
    render({ reuseRaster: true });
    return true;
  }

  function updateDrawingAtPointer(ev) {
    const ds = getActive();
    const rulerMove = state.draw.rulerMove;
    if (ds && rulerMove && rulerMove.dsId === ds.id) {
      const item = ds.drawings[rulerMove.drawingIndex];
      if (item && Array.isArray(item.points) && item.points.length >= 2) {
        const p = pointerToImagePoint(ev, ds);
        const a = item.points[0];
        const b = item.points[item.points.length - 1];
        const dx = p.x - rulerMove.lastPoint.x;
        const dy = p.y - rulerMove.lastPoint.y;
        if (Number.isFinite(dx) && Number.isFinite(dy) && (dx || dy)) {
          const minX = Math.min(a.x, b.x);
          const minY = Math.min(a.y, b.y);
          const maxX = Math.max(a.x, b.x);
          const maxY = Math.max(a.y, b.y);
          const shiftX = clamp(dx, -minX, (ds.meta.samples - 1) - maxX);
          const shiftY = clamp(dy, -minY, (ds.meta.lines - 1) - maxY);
          if (shiftX || shiftY) {
            item.points[0] = { x: a.x + shiftX, y: a.y + shiftY };
            item.points[item.points.length - 1] = { x: b.x + shiftX, y: b.y + shiftY };
          }
        }
        rulerMove.lastPoint = p;
        render({ reuseRaster: true });
        return;
      }
      state.draw.rulerMove = null;
      state.draw.activePointerId = null;
      return;
    }

    const rulerDrag = state.draw.rulerDrag;
    if (ds && rulerDrag && rulerDrag.dsId === ds.id) {
      const item = ds.drawings[rulerDrag.drawingIndex];
      if (item && Array.isArray(item.points) && item.points.length >= 2) {
        const p = pointerToImagePoint(ev, ds);
        const pointIndex = clamp(rulerDrag.pointIndex, 0, item.points.length - 1);
        item.points[pointIndex] = p;
        render({ reuseRaster: true });
        return;
      }
      state.draw.rulerDrag = null;
      state.draw.activePointerId = null;
      return;
    }

    const draft = state.draw.draft;
    if (!ds || !draft || draft.dsId !== ds.id) return;
    const p = pointerToImagePoint(ev, ds);
    if (draft.tool === "ruler" || draft.tool === "rect") {
      if (draft.points.length === 1) draft.points.push(p);
      else draft.points[draft.points.length - 1] = p;
    } else if (draft.tool === "shape") {
      const last = draft.points[draft.points.length - 1];
      const minStep = 0.7 / Math.max(1e-6, ds.view.scale);
      const dx = p.x - last.x;
      const dy = p.y - last.y;
      if ((dx * dx + dy * dy) >= (minStep * minStep)) draft.points.push(p);
    }
    render({ reuseRaster: true });
  }

  function finishDrawingAtPointer(ev) {
    const ds = getActive();
    const rulerMove = state.draw.rulerMove;
    const rulerDrag = state.draw.rulerDrag;
    if (!ds || !((state.draw.draft && state.draw.draft.dsId === ds.id) || (rulerDrag && rulerDrag.dsId === ds.id) || (rulerMove && rulerMove.dsId === ds.id))) {
      state.draw.activePointerId = null;
      state.draw.draft = null;
      state.draw.rulerDrag = null;
      state.draw.rulerMove = null;
      return;
    }
    if (rulerMove && rulerMove.dsId === ds.id) {
      updateDrawingAtPointer(ev);
      state.draw.activePointerId = null;
      state.draw.rulerMove = null;
      state.draw.areaMove = null;
      render({ reuseRaster: true });
      return;
    }
    if (rulerDrag && rulerDrag.dsId === ds.id) {
      updateDrawingAtPointer(ev);
      state.draw.activePointerId = null;
      state.draw.rulerDrag = null;
      state.draw.rulerMove = null;
      state.draw.areaMove = null;
      render({ reuseRaster: true });
      return;
    }

    const draft = state.draw.draft;

    updateDrawingAtPointer(ev);
    const points = draft.points || [];
    let keep = false;
    if (draft.tool === "ruler" || draft.tool === "rect") {
      if (points.length >= 2) {
        const a = points[0];
        const b = points[points.length - 1];
        const dx = Math.abs(b.x - a.x);
        const dy = Math.abs(b.y - a.y);
        keep = (dx + dy) > (1 / Math.max(1e-6, ds.view.scale));
      }
    } else if (draft.tool === "shape") {
      keep = points.length >= 3;
    }
    if (keep) {
      if (draft.tool === "ruler") {
        for (let i = ds.drawings.length - 1; i >= 0; i -= 1) {
          if (ds.drawings[i] && ds.drawings[i].tool === "ruler") ds.drawings.splice(i, 1);
        }
      }
      const newItem = {
        id: state.draw.nextItemId++,
        tool: draft.tool,
        color: draft.color,
        points: points.slice()
      };
      ds.drawings.push(newItem);
      if (draft.tool === "rect" || draft.tool === "shape") {
        ds.selectedAreaId = newItem.id;
        updateSelectionHistogramForDataset(ds);
      }
    }
    state.draw.activePointerId = null;
    state.draw.draft = null;
    state.draw.rulerDrag = null;
    state.draw.rulerMove = null;
    state.draw.areaMove = null;
    ensureMarqueeTicker();
    render({ reuseRaster: true });
  }

  function cancelDrawing() {
    state.draw.activePointerId = null;
    state.draw.draft = null;
    state.draw.rulerDrag = null;
    state.draw.rulerMove = null;
    state.draw.areaMove = null;
    render({ reuseRaster: true });
  }

  return {
    getDrawTool,
    getSpectrumPickEnabled,
    setSpectrumPickEnabled,
    getDrawColor,
    setDrawTool,
    setDrawColor,
    getAreaSelectionMode,
    isHistogramSelectionTool,
    listHistogramSelectionItems,
    getHistogramSelectionItems,
    getEffectiveAreaSelectionCount,
    histogramSelectionKeyFromItems,
    getEffectiveAreaSelectionKey,
    setAreaSelectionMode,
    selectAreaAtPointer,
    isAreaMovePointer,
    beginAreaMoveAtPointer,
    updateAreaMoveAtPointer,
    finishAreaMoveAtPointer,
    cancelAreaMove,
    resolvePointerCursor,
    refreshAreaSpectrumIfOpen,
    getDrawData,
    updateRulerHoverAtPointer,
    clearRulerHover,
    eraseDrawingAtPointer,
    clearAllAnnotations,
    isDrawingPointer,
    beginDrawingAtPointer,
    updateDrawingAtPointer,
    finishDrawingAtPointer,
    cancelDrawing
  };
}
