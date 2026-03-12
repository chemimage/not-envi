import { distanceToDrawing } from "./draw-geometry.js";

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
      const hadRulerHover = !!state.draw.rulerHover;
      const hadAreaMove = !!state.draw.areaMove;
      if (state.draw.tool !== "none" || hadDraft || hadRulerDrag || hadRulerHover || hadAreaMove) {
        state.draw.tool = "none";
        state.draw.activePointerId = null;
        state.draw.draft = null;
        state.draw.rulerDrag = null;
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
      state.draw.rulerHover = null;
      state.draw.areaMove = null;
      if (hadDraft || hadRulerDrag || hadRulerHover || hadAreaMove) render({ reuseRaster: true });
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

  function findAreaHitAtPointer(ds, ev) {
    if (!ds) return null;
    const items = listHistogramSelectionItems(ds);
    if (!items.length) return null;
    const point = pointerToImagePoint(ev, ds);
    const pxTolerance = (ev.pointerType === "touch") ? 24 : 14;
    const imgTolerance = pxTolerance / Math.max(1e-6, ds.view.scale);
    let best = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      const dist = distanceToDrawing(point, item);
      if (!Number.isFinite(dist) || dist > imgTolerance || dist > bestDist) continue;
      best = item;
      bestDist = dist;
      if (dist <= 0) break;
    }
    if (!best || !Number.isFinite(best.id)) return null;
    return { item: best, point };
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
    if (getAreaSelectionMode() !== "single") return false;
    const ds = getActive();
    if (!ds) return false;
    const hit = findAreaHitAtPointer(ds, ev);
    if (!hit) return false;
    const changed = setSelectedAreaId(ds, hit.item.id);
    if (changed) {
      updateSelectionHistogramForDataset(ds);
      ensureMarqueeTicker();
    }
    state.draw.areaMove = {
      activePointerId: ev.pointerId,
      dsId: ds.id,
      itemId: hit.item.id,
      lastPoint: hit.point,
      moved: false,
      lastRefreshMs: 0
    };
    if (changed) render({ reuseRaster: true });
    return true;
  }

  function updateAreaMoveAtPointer(ev) {
    const move = state.draw.areaMove;
    if (!move || move.activePointerId !== ev.pointerId) return false;
    const ds = getActive();
    if (!ds || ds.id !== move.dsId || !Array.isArray(ds.drawings)) return false;
    const item = ds.drawings.find((it) => it && it.id === move.itemId && isHistogramSelectionTool(it));
    if (!item || !Array.isArray(item.points) || !item.points.length) return false;

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
    const wantsSpatial = !!(isAnalysisHistogramOpen && isAnalysisHistogramOpen() && isDatasetActive && isDatasetActive(ds));
    const wantsSpectral = !!(state.spectrumPickEnabled && getSpectrumOpenForDatasetId && getSpectrumOpenForDatasetId(ds.id));
    if (wantsSpatial && positionAnalysisHistogramPanel) positionAnalysisHistogramPanel();
    const nowMs = performance.now();
    if ((wantsSpatial || wantsSpectral) && (!Number.isFinite(move.lastRefreshMs) || (nowMs - move.lastRefreshMs) >= 120)) {
      move.lastRefreshMs = nowMs;
      if (wantsSpatial) updateSelectionHistogramForDataset(ds);
      if (wantsSpectral) refreshAreaSpectrumIfOpen(ds, ev, false);
    }
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
      const hit = findRulerEndpointHit(ds, pointerToImagePoint(ev, ds), ev.pointerType);
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
    const rulerDrag = state.draw.rulerDrag;
    if (!ds || !((state.draw.draft && state.draw.draft.dsId === ds.id) || (rulerDrag && rulerDrag.dsId === ds.id))) {
      state.draw.activePointerId = null;
      state.draw.draft = null;
      state.draw.rulerDrag = null;
      return;
    }
    if (rulerDrag && rulerDrag.dsId === ds.id) {
      updateDrawingAtPointer(ev);
      state.draw.activePointerId = null;
      state.draw.rulerDrag = null;
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
    state.draw.areaMove = null;
    ensureMarqueeTicker();
    render({ reuseRaster: true });
  }

  function cancelDrawing() {
    state.draw.activePointerId = null;
    state.draw.draft = null;
    state.draw.rulerDrag = null;
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
