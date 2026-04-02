import { distanceToDrawing, pointDistanceToSegment, pointInPolygon } from "./draw-geometry.js";

export function createAnnotationController(deps) {
  const {
    state,
    els,
    clamp,
    getActive,
    getActivePanel,
    screenToImage,
    render,
    getSpectrumOpenForDatasetId,
    openSpectrumAt,
    positionAnalysisHistogramPanel,
    updateSelectionHistogramForDataset,
    ensureMarqueeTicker,
    shouldAnimateMarquee,
    refreshAnalysisHistogram,
    isAnalysisHistogramOpen,
    isDatasetActive
  } = deps;

  function normalizeShapeMode(mode) {
    return (mode === "1:1" || mode === "3:4" || mode === "9:16" || mode === "polygon")
      ? mode
      : "rect";
  }

  function resolveShapeModeTool(mode) {
    return normalizeShapeMode(mode) === "polygon" ? "shape" : "rect";
  }

  function currentShapeMode() {
    return normalizeShapeMode(state.draw?.shapeMode);
  }

  function resolveAnnotationState(ds, explicitState = null) {
    if (explicitState && typeof explicitState === "object") {
      if (!Array.isArray(explicitState.drawings)) explicitState.drawings = [];
      explicitState.selectedAreaId = Number.isFinite(Number(explicitState.selectedAreaId)) ? Number(explicitState.selectedAreaId) : null;
      return explicitState;
    }
    if (!ds) return { drawings: [], selectedAreaId: null };
    const activePanel = (typeof getActivePanel === "function") ? getActivePanel() : null;
    if (activePanel && String(activePanel.datasetId || "") === String(ds.id || "")) {
      if (!activePanel.annotations || typeof activePanel.annotations !== "object") {
        activePanel.annotations = { drawings: [], selectedAreaId: null };
      }
      if (!Array.isArray(activePanel.annotations.drawings)) activePanel.annotations.drawings = [];
      activePanel.annotations.selectedAreaId = Number.isFinite(Number(activePanel.annotations.selectedAreaId))
        ? Number(activePanel.annotations.selectedAreaId)
        : null;
      ds.drawings = activePanel.annotations.drawings;
      ds.selectedAreaId = activePanel.annotations.selectedAreaId;
      return activePanel.annotations;
    }
    if (!Array.isArray(ds.drawings)) ds.drawings = [];
    ds.selectedAreaId = Number.isFinite(Number(ds.selectedAreaId)) ? Number(ds.selectedAreaId) : null;
    return ds;
  }

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

  function getDrawShapeMode() {
    return currentShapeMode();
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
      const hadRulerProfileDrag = !!state.draw.rulerProfileDrag;
      const hadRulerProfileHover = !!state.draw.rulerProfileHover;
      const hadRulerHover = !!state.draw.rulerHover;
      const hadAreaMove = !!state.draw.areaMove;
      if (state.draw.tool !== "none" || hadDraft || hadRulerDrag || hadRulerMove || hadRulerProfileDrag || hadRulerProfileHover || hadRulerHover || hadAreaMove) {
        state.draw.tool = "none";
        state.draw.activePointerId = null;
        state.draw.draft = null;
        state.draw.rulerDrag = null;
        state.draw.rulerMove = null;
        state.draw.rulerProfileDrag = null;
        state.draw.rulerProfileHover = null;
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

  function applyDrawTool(tool, { toggleIfSame = true } = {}) {
    const hadDraft = !!state.draw.draft;
    const hadRulerDrag = !!state.draw.rulerDrag;
    const hadRulerMove = !!state.draw.rulerMove;
    const hadRulerProfileDrag = !!state.draw.rulerProfileDrag;
    const hadRulerProfileHover = !!state.draw.rulerProfileHover;
    const hadRulerHover = !!state.draw.rulerHover;
    const hadAreaMove = !!state.draw.areaMove;
    const prevTool = state.draw.tool;
    const next = (tool === "ruler" || tool === "rect" || tool === "shape" || tool === "eraser") ? tool : "none";
    if (next !== "none") state.spectrumPickEnabled = false;
    state.draw.tool = (toggleIfSame && prevTool === next) ? "none" : next;
    const isCreateTool = state.draw.tool === "ruler" || state.draw.tool === "rect" || state.draw.tool === "shape";
    if (state.draw.tool !== prevTool || !isCreateTool) {
      state.draw.activePointerId = null;
      state.draw.draft = null;
      state.draw.rulerDrag = null;
      state.draw.rulerMove = null;
      state.draw.rulerProfileDrag = null;
      state.draw.rulerProfileHover = null;
      state.draw.rulerHover = null;
      state.draw.areaMove = null;
      if (hadDraft || hadRulerDrag || hadRulerMove || hadRulerProfileDrag || hadRulerProfileHover || hadRulerHover || hadAreaMove) render({ reuseRaster: true });
    }
    return state.draw.tool;
  }

  function setDrawTool(tool) {
    return applyDrawTool(tool, { toggleIfSame: true });
  }

  function setDrawShapeMode(mode) {
    const nextMode = normalizeShapeMode(mode);
    const prevMode = currentShapeMode();
    if (nextMode === prevMode) return nextMode;
    state.draw.shapeMode = nextMode;
    const activeTool = state.draw.tool;
    if (activeTool === "rect" || activeTool === "shape") {
      const nextTool = resolveShapeModeTool(nextMode);
      if (nextTool !== activeTool) {
        applyDrawTool(nextTool, { toggleIfSame: false });
      }
    }
    return nextMode;
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

  function listHistogramSelectionItems(ds, explicitState = null) {
    const annotationState = resolveAnnotationState(ds, explicitState);
    return annotationState.drawings.filter((item) => isHistogramSelectionTool(item));
  }

  function latestHistogramSelectionItem(ds, explicitState = null) {
    const annotationState = resolveAnnotationState(ds, explicitState);
    for (let i = annotationState.drawings.length - 1; i >= 0; i -= 1) {
      const item = annotationState.drawings[i];
      if (isHistogramSelectionTool(item) && Number.isFinite(item.id)) return item;
    }
    return null;
  }

  function ensureSelectedAreaId(ds, { preferLatest = true, annotationState: explicitState = null } = {}) {
    if (!ds) return null;
    const annotationState = resolveAnnotationState(ds, explicitState);
    const items = listHistogramSelectionItems(ds, annotationState);
    if (!items.length) {
      annotationState.selectedAreaId = null;
      ds.selectedAreaId = null;
      return null;
    }
    const current = annotationState.selectedAreaId;
    const hasCurrent = Number.isFinite(current) && items.some((item) => item.id === current);
    if (hasCurrent) return current;
    if (!preferLatest) return null;
    const latest = latestHistogramSelectionItem(ds, annotationState);
    annotationState.selectedAreaId = latest ? latest.id : null;
    ds.selectedAreaId = annotationState.selectedAreaId;
    return annotationState.selectedAreaId;
  }

  function getHistogramSelectionItems(ds, explicitState = null) {
    const annotationState = resolveAnnotationState(ds, explicitState);
    const items = listHistogramSelectionItems(ds, annotationState);
    if (!items.length) return [];
    if (isAreaSelectionGrouped()) return items;
    const selectedId = ensureSelectedAreaId(ds, { preferLatest: true, annotationState });
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
    const annotationState = resolveAnnotationState(ds);
    const items = listHistogramSelectionItems(ds, annotationState);
    if (!items.length) {
      if (annotationState.selectedAreaId == null) return false;
      annotationState.selectedAreaId = null;
      ds.selectedAreaId = null;
      return true;
    }
    const resolved = Number.isFinite(nextId) && items.some((item) => item.id === nextId)
      ? nextId
      : null;
    const fallback = (resolved == null) ? ensureSelectedAreaId(ds, { preferLatest: true, annotationState }) : resolved;
    if (annotationState.selectedAreaId === fallback) return false;
    annotationState.selectedAreaId = fallback;
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

  function canMoveSelectedAreaWithoutTool() {
    if (state.draw.tool !== "none") return false;
    if (getAreaSelectionMode() !== "single") return false;
    const spatialOn = !!(isAnalysisHistogramOpen && isAnalysisHistogramOpen());
    const spectralOn = !!state.spectrumPickEnabled;
    return spatialOn || spectralOn;
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
    const allowAnyAreaMove = canMoveSelectedAreaWithoutTool();
    if (!toolFilter && !allowAnyAreaMove) return false;
    const hit = toolFilter
      ? findAreaHitAtPointer(ds, ev, { toolFilter })
      : findAreaHitAtPointer(ds, ev);
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
    const lockedRatio = resolveLockedRectRatio(item, start, p, handle);

    if (lockedRatio) {
      const box = resizeAspectLockedRect(start, handle, p, ds, lockedRatio, minSpan);
      if (!box) return false;
      const x0 = clamp(Math.min(box.x0, box.x1), 0, maxX);
      const y0 = clamp(Math.min(box.y0, box.y1), 0, maxY);
      const x1 = clamp(Math.max(box.x0, box.x1), 0, maxX);
      const y1 = clamp(Math.max(box.y0, box.y1), 0, maxY);
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
      if (state.draw.rulerProfileDrag) return "ns-resize";
      if (findRulerProfileHit(ds, ev)) return "ns-resize";
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
    if (canMoveSelectedAreaWithoutTool()) {
      const hit = findAreaHitAtPointer(ds, ev);
      if (!hit) return "";
      if (pointInsideArea(hit.item, hit.point)) return "move";
      return "";
    }
    return "";
  }

  function getDrawData(ds, explicitState = null) {
    if (!ds) return null;
    const annotationState = resolveAnnotationState(ds, explicitState);
    const items = Array.isArray(annotationState.drawings) ? annotationState.drawings : [];
    const draft = (state.draw.draft && state.draw.draft.dsId === ds.id) ? state.draw.draft : null;
    const rulerHover = (state.draw.rulerHover && state.draw.rulerHover.dsId === ds.id) ? state.draw.rulerHover : null;
    const rulerProfileHover = (state.draw.rulerProfileHover && state.draw.rulerProfileHover.dsId === ds.id) ? state.draw.rulerProfileHover : null;
    const selectionItems = getHistogramSelectionItems(ds, annotationState);
    const selectionIds = selectionItems
      .map((item) => item.id)
      .filter((id) => Number.isFinite(id));
    const animateMarquee = typeof shouldAnimateMarquee === "function"
      ? shouldAnimateMarquee(ds, annotationState)
      : true;
    const marqueeOffset = selectionIds.length && animateMarquee ? ((performance.now() / 110) % 14) : 0;
    return { items, draft, rulerHover, rulerProfileHover, selectionIds, marqueeOffset };
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

  function pointerToScreenPoint(ev) {
    const rect = els.main.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return {
      x: (ev.clientX - rect.left) * dpr,
      y: (ev.clientY - rect.top) * dpr,
      dpr
    };
  }

  function imageToScreenPoint(ds, pt, dpr) {
    const eff = Math.max(1e-9, ds.view.scale * dpr);
    return {
      x: (pt.x - ds.view.x) * eff,
      y: (pt.y - ds.view.y) * eff
    };
  }

  function resolveAspectRatio(mode, dx, dy) {
    const normalized = normalizeShapeMode(mode);
    if (normalized === "1:1") return { w: 1, h: 1 };
    if (normalized !== "3:4" && normalized !== "9:16") return null;
    const [a, b] = normalized.split(":").map((value) => Number(value) || 1);
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    return absX >= absY
      ? { w: Math.max(a, b), h: Math.min(a, b) }
      : { w: Math.min(a, b), h: Math.max(a, b) };
  }

  function constrainRectPointToRatio(anchor, point, ds, ratio, minScale = 0) {
    if (!ratio) return point;

    const dx = point.x - anchor.x;
    const dy = point.y - anchor.y;
    if (!dx && !dy) return point;

    const signX = dx >= 0 ? 1 : -1;
    const signY = dy >= 0 ? 1 : -1;
    const maxX = Math.max(0, ds.meta.samples - 1);
    const maxY = Math.max(0, ds.meta.lines - 1);
    const maxW = signX >= 0 ? Math.max(0, maxX - anchor.x) : Math.max(0, anchor.x);
    const maxH = signY >= 0 ? Math.max(0, maxY - anchor.y) : Math.max(0, anchor.y);
    const idealScale = Math.max(Math.abs(dx) / ratio.w, Math.abs(dy) / ratio.h);
    const maxScale = Math.max(0, Math.min(maxW / ratio.w, maxH / ratio.h));
    const boundedScale = Math.min(maxScale, Math.max(minScale, idealScale));

    return {
      x: anchor.x + (signX * ratio.w * boundedScale),
      y: anchor.y + (signY * ratio.h * boundedScale)
    };
  }

  function constrainRectPoint(anchor, point, ds, mode) {
    const ratio = resolveAspectRatio(mode, point.x - anchor.x, point.y - anchor.y);
    return constrainRectPointToRatio(anchor, point, ds, ratio, 0);
  }

  function resolveLockedRectRatio(item, start, point = null, handle = "") {
    if (!item) return null;
    const mode = normalizeShapeMode(item.shapeMode);
    if (mode === "rect") return null;
    if (mode === "1:1") return { w: 1, h: 1 };
    const [a, b] = mode.split(":").map((value) => Number(value) || 1);
    const wide = { w: Math.max(a, b), h: Math.min(a, b) };
    const tall = { w: Math.min(a, b), h: Math.max(a, b) };

    if (handle === "e" || handle === "w") return wide;
    if (handle === "n" || handle === "s") return tall;

    if (point && start && (handle === "nw" || handle === "ne" || handle === "sw" || handle === "se")) {
      const anchor = {
        x: handle.includes("w") ? start.x1 : start.x0,
        y: handle.includes("n") ? start.y1 : start.y0
      };
      const dx = point.x - anchor.x;
      const dy = point.y - anchor.y;
      return resolveAspectRatio(mode, dx, dy) || wide;
    }

    if (!start) return wide;
    const width = Math.abs(start.x1 - start.x0);
    const height = Math.abs(start.y1 - start.y0);
    return width >= height ? wide : tall;
  }

  function resizeAspectLockedRect(start, handle, point, ds, ratio, minSpan) {
    if (!start || !handle || !ratio) return null;
    const maxX = Math.max(0, ds.meta.samples - 1);
    const maxY = Math.max(0, ds.meta.lines - 1);
    const centerX = (start.x0 + start.x1) * 0.5;
    const centerY = (start.y0 + start.y1) * 0.5;
    const minScale = Math.max(0, minSpan / Math.min(ratio.w, ratio.h));

    if (handle === "nw" || handle === "ne" || handle === "sw" || handle === "se") {
      const anchor = {
        x: handle.includes("w") ? start.x1 : start.x0,
        y: handle.includes("n") ? start.y1 : start.y0
      };
      const constrained = constrainRectPointToRatio(anchor, point, ds, ratio, minScale);
      return {
        x0: Math.min(anchor.x, constrained.x),
        y0: Math.min(anchor.y, constrained.y),
        x1: Math.max(anchor.x, constrained.x),
        y1: Math.max(anchor.y, constrained.y)
      };
    }

    if (handle === "e" || handle === "w") {
      const fixedX = handle === "e" ? start.x0 : start.x1;
      const maxScaleFromCenter = Math.max(0, 2 * Math.min(centerY, maxY - centerY) / ratio.h);
      const maxWidthFromSide = handle === "e"
        ? Math.max(0, maxX - fixedX)
        : Math.max(0, fixedX);
      const maxScaleFromSide = Math.max(0, maxWidthFromSide / ratio.w);
      const scale = Math.min(
        Math.max(minScale, Math.abs(point.x - fixedX) / ratio.w),
        maxScaleFromCenter,
        maxScaleFromSide
      );
      const width = ratio.w * scale;
      const height = ratio.h * scale;
      const y0 = clamp(centerY - (height * 0.5), 0, maxY);
      const y1 = clamp(centerY + (height * 0.5), 0, maxY);
      return handle === "e"
        ? { x0: fixedX, y0, x1: fixedX + width, y1 }
        : { x0: fixedX - width, y0, x1: fixedX, y1 };
    }

    if (handle === "n" || handle === "s") {
      const fixedY = handle === "n" ? start.y1 : start.y0;
      const maxScaleFromCenter = Math.max(0, 2 * Math.min(centerX, maxX - centerX) / ratio.w);
      const maxHeightFromSide = handle === "n"
        ? Math.max(0, fixedY)
        : Math.max(0, maxY - fixedY);
      const maxScaleFromSide = Math.max(0, maxHeightFromSide / ratio.h);
      const scale = Math.min(
        Math.max(minScale, Math.abs(point.y - fixedY) / ratio.h),
        maxScaleFromCenter,
        maxScaleFromSide
      );
      const height = ratio.h * scale;
      const width = ratio.w * scale;
      const x0 = clamp(centerX - (width * 0.5), 0, maxX);
      const x1 = clamp(centerX + (width * 0.5), 0, maxX);
      return handle === "n"
        ? { x0, y0: fixedY - height, x1, y1: fixedY }
        : { x0, y0: fixedY, x1, y1: fixedY + height };
    }

    return null;
  }

  function rulerScreenNormal(ds, item, dpr) {
    if (!ds || !item || !Array.isArray(item.points) || item.points.length < 2) return null;
    const aImg = item.points[0];
    const bImg = item.points[item.points.length - 1];
    const a = imageToScreenPoint(ds, aImg, dpr);
    const b = imageToScreenPoint(ds, bImg, dpr);
    return rulerUpNormal(a, b);
  }

  function rulerProfileScale(item) {
    const raw = Number(item?.profileScale);
    if (!Number.isFinite(raw) || raw <= 0) return 1;
    return clamp(raw, 0.15, 12);
  }

  function sampleRasterValue(ds, ix, iy) {
    const raster = ds ? ds.lastRaster : null;
    if (!raster || !raster.dataF32) return Number.NaN;
    if (raster.band !== ds.activeBand) return Number.NaN;
    const step = Math.max(1, Number(raster.step) || 1);
    const x0 = Number(raster.x0) || 0;
    const y0 = Number(raster.y0) || 0;
    const rx = Math.round((ix - x0) / step);
    const ry = Math.round((iy - y0) / step);
    if (!Number.isFinite(rx) || !Number.isFinite(ry)) return Number.NaN;
    if (rx < 0 || ry < 0 || rx >= raster.w || ry >= raster.h) return Number.NaN;
    return raster.dataF32[ry * raster.w + rx];
  }

  function rulerUpNormal(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (!Number.isFinite(len) || len <= 1e-6) return null;
    let nx = -dy / len;
    let ny = dx / len;
    if (ny > 0) {
      nx = -nx;
      ny = -ny;
    }
    return { nx, ny, len };
  }

  function buildRulerProfileScreenRuns(ds, item, dpr) {
    if (!ds || !item || !Array.isArray(item.points) || item.points.length < 2) return null;
    const aImg = item.points[0];
    const bImg = item.points[item.points.length - 1];
    const lenImg = Math.hypot(bImg.x - aImg.x, bImg.y - aImg.y);
    if (!Number.isFinite(lenImg) || lenImg < 2) return null;
    const a = imageToScreenPoint(ds, aImg, dpr);
    const b = imageToScreenPoint(ds, bImg, dpr);
    const n = rulerUpNormal(a, b);
    if (!n) return null;

    const samples = Math.max(24, Math.min(256, Math.round(lenImg)));
    const values = new Float32Array(samples);
    let minV = Number.POSITIVE_INFINITY;
    let maxV = Number.NEGATIVE_INFINITY;
    let valid = 0;
    for (let i = 0; i < samples; i += 1) {
      const t = i / Math.max(1, samples - 1);
      const ix = aImg.x + (bImg.x - aImg.x) * t;
      const iy = aImg.y + (bImg.y - aImg.y) * t;
      const v = sampleRasterValue(ds, ix, iy);
      values[i] = v;
      if (Number.isFinite(v)) {
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
        valid += 1;
      }
    }
    if (valid < 2) return null;

    const range = Math.max(1e-12, maxV - minV);
    const offset = 10 * dpr;
    const amp = 22 * dpr * rulerProfileScale(item);
    const runs = [];
    let run = null;
    for (let i = 0; i < samples; i += 1) {
      const v = values[i];
      if (!Number.isFinite(v)) {
        if (run && run.length > 1) runs.push(run);
        run = null;
        continue;
      }
      const t = i / Math.max(1, samples - 1);
      const bx = a.x + (b.x - a.x) * t;
      const by = a.y + (b.y - a.y) * t;
      const u = (v - minV) / range;
      const d = offset + (u * amp);
      const p = { x: bx + n.nx * d, y: by + n.ny * d };
      if (!run) run = [];
      run.push(p);
    }
    if (run && run.length > 1) runs.push(run);
    if (!runs.length) return null;
    return runs;
  }

  function findRulerProfileHit(ds, ev) {
    if (!ds || !Array.isArray(ds.drawings) || !ds.drawings.length) return null;
    const sp = pointerToScreenPoint(ev);
    const tol = ((ev.pointerType === "touch") ? 18 : 10) * sp.dpr;
    let best = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = ds.drawings.length - 1; i >= 0; i -= 1) {
      const item = ds.drawings[i];
      if (!item || (item.tool !== "ruler" && item.tool !== "line")) continue;
      const runs = buildRulerProfileScreenRuns(ds, item, sp.dpr);
      if (!runs) continue;
      for (const run of runs) {
        for (let j = 0; j < run.length - 1; j += 1) {
          const d = pointDistanceToSegment(sp, run[j], run[j + 1]);
          if (!Number.isFinite(d) || d > tol || d > bestDist) continue;
          bestDist = d;
          best = { drawingIndex: i, x: sp.x, y: sp.y };
        }
      }
    }
    return best;
  }

  function sameRulerHandle(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.dsId === b.dsId && a.drawingIndex === b.drawingIndex && a.pointIndex === b.pointIndex;
  }

  function sameRulerProfileHover(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return (
      a.dsId === b.dsId
      && a.drawingIndex === b.drawingIndex
      && Math.abs((a.x || 0) - (b.x || 0)) < 0.75
      && Math.abs((a.y || 0) - (b.y || 0)) < 0.75
    );
  }

  function setRulerHover(nextHover) {
    if (sameRulerHandle(state.draw.rulerHover, nextHover)) return false;
    state.draw.rulerHover = nextHover;
    render({ reuseRaster: true });
    return true;
  }

  function setRulerProfileHover(nextHover) {
    if (sameRulerProfileHover(state.draw.rulerProfileHover, nextHover)) return false;
    state.draw.rulerProfileHover = nextHover;
    render({ reuseRaster: true });
    return true;
  }

  function clearRulerProfileHover() {
    return setRulerProfileHover(null);
  }

  function clearRulerHover() {
    const a = setRulerHover(null);
    const b = clearRulerProfileHover();
    return a || b;
  }

  function updateRulerHoverAtPointer(ev) {
    const ds = getActive();
    if (!ds || state.draw.tool !== "ruler") return clearRulerHover();
    if (state.draw.rulerProfileDrag) return false;
    const pHit = findRulerProfileHit(ds, ev);
    if (pHit) {
      setRulerHover(null);
      return setRulerProfileHover({
        dsId: ds.id,
        drawingIndex: pHit.drawingIndex,
        x: pHit.x,
        y: pHit.y
      });
    }
    clearRulerProfileHover();
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
      const item = ds.drawings[i];
      if (isHistogramSelectionTool(item) && pointInsideArea(item, point)) {
        bestIdx = i;
        bestDist = -1;
        break;
      }
      const dist = distanceToDrawing(point, item);
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
    const annotationState = resolveAnnotationState(ds);
    if (!ds.drawings.length) return false;
    ds.drawings.length = 0;
    annotationState.selectedAreaId = null;
    ds.selectedAreaId = null;
    state.draw.activePointerId = null;
    state.draw.draft = null;
    state.draw.rulerDrag = null;
    state.draw.rulerMove = null;
    state.draw.rulerProfileDrag = null;
    state.draw.rulerProfileHover = null;
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
    resolveAnnotationState(ds);
    if (state.draw.tool === "ruler") {
      const profileHit = findRulerProfileHit(ds, ev);
      if (profileHit) {
        const item = ds.drawings[profileHit.drawingIndex];
        if (item) {
          const startScreen = pointerToScreenPoint(ev);
          const normal = rulerScreenNormal(ds, item, startScreen.dpr);
          state.draw.activePointerId = ev.pointerId;
          state.draw.rulerProfileDrag = {
            dsId: ds.id,
            drawingIndex: profileHit.drawingIndex,
            startScale: rulerProfileScale(item),
            startScreenX: startScreen.x,
            startScreenY: startScreen.y,
            normalX: Number.isFinite(normal?.nx) ? normal.nx : 0,
            normalY: Number.isFinite(normal?.ny) ? normal.ny : -1
          };
          state.draw.rulerProfileHover = {
            dsId: ds.id,
            drawingIndex: profileHit.drawingIndex,
            x: profileHit.x,
            y: profileHit.y
          };
          state.draw.rulerDrag = null;
          state.draw.rulerMove = null;
          state.draw.rulerHover = null;
          state.draw.draft = null;
          render({ reuseRaster: true });
          return true;
        }
      }
      const pointer = pointerToImagePoint(ev, ds);
      const hit = findRulerEndpointHit(ds, pointer, ev.pointerType);
      if (hit) {
        state.draw.activePointerId = ev.pointerId;
        state.draw.rulerDrag = {
          dsId: ds.id,
          drawingIndex: hit.drawingIndex,
          pointIndex: hit.pointIndex
        };
        state.draw.rulerProfileDrag = null;
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
        state.draw.rulerProfileDrag = null;
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
      shapeMode: currentShapeMode(),
      color: state.draw.color,
      points: [p]
    };
    render({ reuseRaster: true });
    return true;
  }

  function updateDrawingAtPointer(ev) {
    const ds = getActive();
    const rulerProfileDrag = state.draw.rulerProfileDrag;
    if (ds && rulerProfileDrag && rulerProfileDrag.dsId === ds.id) {
      const item = ds.drawings[rulerProfileDrag.drawingIndex];
      if (item && (item.tool === "ruler" || item.tool === "line")) {
        const sp = pointerToScreenPoint(ev);
        const nx = Number.isFinite(rulerProfileDrag.normalX) ? rulerProfileDrag.normalX : 0;
        const ny = Number.isFinite(rulerProfileDrag.normalY) ? rulerProfileDrag.normalY : -1;
        const dx = sp.x - (Number.isFinite(rulerProfileDrag.startScreenX) ? rulerProfileDrag.startScreenX : sp.x);
        const dy = sp.y - (Number.isFinite(rulerProfileDrag.startScreenY) ? rulerProfileDrag.startScreenY : sp.y);
        const proj = (dx * nx) + (dy * ny);
        const next = clamp(rulerProfileDrag.startScale * Math.exp(proj / 90), 0.15, 12);
        const cur = rulerProfileScale(item);
        let hoverChanged = false;
        const hover = state.draw.rulerProfileHover;
        if (!hover || hover.drawingIndex !== rulerProfileDrag.drawingIndex || Math.abs((hover.x || 0) - sp.x) > 0.75 || Math.abs((hover.y || 0) - sp.y) > 0.75) {
          state.draw.rulerProfileHover = {
            dsId: ds.id,
            drawingIndex: rulerProfileDrag.drawingIndex,
            x: sp.x,
            y: sp.y
          };
          hoverChanged = true;
        }
        if (Math.abs(next - cur) > 1e-4) {
          item.profileScale = next;
          render({ reuseRaster: true });
        } else if (hoverChanged) {
          render({ reuseRaster: true });
        }
        return;
      }
      state.draw.rulerProfileDrag = null;
      state.draw.activePointerId = null;
      return;
    }

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
      state.draw.rulerProfileDrag = null;
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
      state.draw.rulerProfileDrag = null;
      state.draw.activePointerId = null;
      return;
    }

    const draft = state.draw.draft;
    if (!ds || !draft || draft.dsId !== ds.id) return;
    const p = pointerToImagePoint(ev, ds);
    if (draft.tool === "ruler" || draft.tool === "rect") {
      const nextPoint = (draft.tool === "rect")
        ? constrainRectPoint(draft.points[0], p, ds, draft.shapeMode)
        : p;
      if (draft.points.length === 1) draft.points.push(nextPoint);
      else draft.points[draft.points.length - 1] = nextPoint;
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
    const rulerProfileDrag = state.draw.rulerProfileDrag;
    const rulerMove = state.draw.rulerMove;
    const rulerDrag = state.draw.rulerDrag;
    if (!ds || !((state.draw.draft && state.draw.draft.dsId === ds.id) || (rulerDrag && rulerDrag.dsId === ds.id) || (rulerMove && rulerMove.dsId === ds.id) || (rulerProfileDrag && rulerProfileDrag.dsId === ds.id))) {
      state.draw.activePointerId = null;
      state.draw.draft = null;
      state.draw.rulerDrag = null;
      state.draw.rulerMove = null;
      state.draw.rulerProfileDrag = null;
      state.draw.rulerProfileHover = null;
      return;
    }
    if (rulerProfileDrag && rulerProfileDrag.dsId === ds.id) {
      updateDrawingAtPointer(ev);
      state.draw.activePointerId = null;
      state.draw.rulerProfileDrag = null;
      state.draw.rulerProfileHover = null;
      state.draw.areaMove = null;
      render({ reuseRaster: true });
      return;
    }
    if (rulerMove && rulerMove.dsId === ds.id) {
      updateDrawingAtPointer(ev);
      state.draw.activePointerId = null;
      state.draw.rulerMove = null;
      state.draw.rulerProfileDrag = null;
      state.draw.rulerProfileHover = null;
      state.draw.areaMove = null;
      render({ reuseRaster: true });
      return;
    }
    if (rulerDrag && rulerDrag.dsId === ds.id) {
      updateDrawingAtPointer(ev);
      state.draw.activePointerId = null;
      state.draw.rulerDrag = null;
      state.draw.rulerMove = null;
      state.draw.rulerProfileDrag = null;
      state.draw.rulerProfileHover = null;
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
        const targetColor = String(draft.color || "").toLowerCase();
        for (let i = ds.drawings.length - 1; i >= 0; i -= 1) {
          const cur = ds.drawings[i];
          if (!cur || cur.tool !== "ruler") continue;
          const curColor = String(cur.color || "").toLowerCase();
          if (curColor === targetColor) ds.drawings.splice(i, 1);
        }
      }
      const newItem = {
        id: state.draw.nextItemId++,
        tool: draft.tool,
        shapeMode: draft.tool === "rect" ? normalizeShapeMode(draft.shapeMode) : undefined,
        color: draft.color,
        points: points.slice()
      };
      ds.drawings.push(newItem);
      if (draft.tool === "rect" || draft.tool === "shape") {
        const annotationState = resolveAnnotationState(ds);
        annotationState.selectedAreaId = newItem.id;
        ds.selectedAreaId = newItem.id;
        updateSelectionHistogramForDataset(ds);
      }
    }
    state.draw.activePointerId = null;
    state.draw.draft = null;
    state.draw.rulerDrag = null;
    state.draw.rulerMove = null;
    state.draw.rulerProfileDrag = null;
    state.draw.rulerProfileHover = null;
    state.draw.areaMove = null;
    ensureMarqueeTicker();
    render({ reuseRaster: true });
  }

  function cancelDrawing() {
    state.draw.activePointerId = null;
    state.draw.draft = null;
    state.draw.rulerDrag = null;
    state.draw.rulerMove = null;
    state.draw.rulerProfileDrag = null;
    state.draw.rulerProfileHover = null;
    state.draw.areaMove = null;
    render({ reuseRaster: true });
  }

  return {
    getDrawTool,
    getDrawShapeMode,
    getSpectrumPickEnabled,
    setSpectrumPickEnabled,
    getDrawColor,
    setDrawTool,
    setDrawShapeMode,
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
