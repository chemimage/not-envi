import { createExportDialogController, createExportService } from "../export/export-controller.js";
import { createDatasetRuntime } from "./dataset-runtime.js";
import { createCacheRuntime } from "./cache-runtime.js";
import { collectElements } from "./elements.js";
import { createUIPanels } from "./ui-panels.js";
import { createViewControls } from "./view-controls.js";
import { wireApp } from "./wiring.js";
import { addDatasetFromFiles as addDatasetFromFilesMod, addDatasetsFromFileList as addDatasetsFromFileListMod } from "../io/envi-loader.js";
import {
  readBandWindow as readBandWindowCore,
  readBandWindowBIP as readBandWindowBIPCore,
  toFloat32 as toFloat32Core
} from "../core/raster-io.js";
import {
  computeHistogram as computeHistogramCore,
  quickStatsFromArray as quickStatsFromArrayCore,
  resolveDisplayRange as resolveDisplayRangeCore,
  tone01 as tone01Core
} from "../render/display-math.js";
import {
  createHistogramController
} from "../render/histogram.js";
import { createGpuRuntime } from "../render/gpu-runtime.js";
import { createHudController } from "../render/hud.js";
import { createOverlayRenderer } from "../render/overlay.js";
import { createPyramidController } from "../render/pyramid-cache.js";
import { createRenderer } from "../render/render-main.js";
import { createSpectrumController } from "../render/spectrum.js";
import { readSpectrumAtPixel as readSpectrumAtPixelCore, wavelengthArrayOrNull as wavelengthArrayOrNullCore } from "../render/spectrum-data.js";
import { createThumbnailController } from "../render/thumbnail.js";
import { histogramPlotRect } from "../render/histogram-math.js";
import { clamp, fmt, fmtNoGroup, humanBytes } from "../core/utils.js";
import { createInteractionController } from "../ui/events.js";
import { APP_CONFIG } from "./config.js";

(() => {
  'use strict';

  // ========= Utilities =========

  const now = () => performance.now();

  function formatNumber(value, digits = 4) {
    if (!Number.isFinite(value)) return "—";
    const abs = Math.abs(value);
    if (abs > 0 && (abs >= 1e5 || abs < 1e-3)) return value.toExponential(3);
    return Number(value).toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
  }

  function downloadBlob(blob, filename){
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  const requestIdle = window.requestIdleCallback
    ? (cb, opts) => window.requestIdleCallback(cb, opts)
    : (cb) => setTimeout(() => cb({ timeRemaining: () => 0, didTimeout: true }), 60);
  const cancelIdle = window.cancelIdleCallback
    ? (id) => window.cancelIdleCallback(id)
    : (id) => clearTimeout(id);

  // ========= IO helpers =========

  // A small, bounded amount of parallelism helps on SSDs (and reduces latency for scattered reads),
  // but too much can overwhelm the browser. We keep it conservative.
  const IO_CONCURRENCY_MAX = clamp(Math.floor(((navigator && navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : 4) / 2) + 1, 2, 8);
  let IO_CONCURRENCY = APP_CONFIG.io.parallelEnabledByDefault ? IO_CONCURRENCY_MAX : 1;
  // ========= Elements =========

  const els = collectElements();

  const thumbCtx = els.thumb.getContext('2d', {alpha:false});
  const overlayCtx = els.overlayCanvas.getContext('2d', {alpha:true});
  const cpuCtx = els.cpuCanvas.getContext('2d', {alpha:false});
  const specCtx = els.specCanvas.getContext('2d', {alpha:false});

  function setStatus(text, cls){
    els.statusBadge.textContent = text || '';
    els.statusBadge.classList.remove('warn','ok','err');
    if (cls) els.statusBadge.classList.add(cls);
  }

  async function readBandWindow(meta, ds, band, x0, y0, outW, outH, step){ return readBandWindowCore(meta, ds, band, x0, y0, outW, outH, step, IO_CONCURRENCY); }
  async function readBandWindowBIP(meta, ds, band, x0, y0, outW, outH, step){ return readBandWindowBIPCore(meta, ds, band, x0, y0, outW, outH, step, IO_CONCURRENCY); }
  function toFloat32(arr){ return toFloat32Core(arr); }

  // ========= Pyramid cache (per-band tiles) =========

  const pyramid = createPyramidController({
    now,
    requestIdle,
    cancelIdle,
    readBandWindow,
    readBandWindowBIP,
    onPerfUpdate: () => updatePerf(),
    onProgressiveRender: () => scheduleRender(),
    getActiveDatasetId: () => state.activeId,
    getDevicePixelRatio: () => window.devicePixelRatio || 1,
    getViewportSize: () => ({ width: els.cpuCanvas.width, height: els.cpuCanvas.height }),
    getIOConcurrency: () => IO_CONCURRENCY
  });

  function ensurePyramid(ds){ pyramid.ensurePyramid(ds); }
  function disposePyramid(pyr){ pyramid.disposePyramid(pyr); }
  // ========= WebGPU renderer =========

  const gpuRuntime = createGpuRuntime({ els });
  const gpuSupported = gpuRuntime.supported;

  async function initWebGPU(){
    return gpuRuntime.ensureReady();
  }

  function gpuRender(rasterF32, w, h, params){
    return gpuRuntime.renderGray(rasterF32, w, h, params);
  }
  // ========= App state =========

  const state = {
    datasets: [],
    activeId: null,
    ioParallel: APP_CONFIG.io.parallelEnabledByDefault,

    // Zoom slider maps 0..100 to 2^[zoomExpMin..zoomExpMax].
    // zoomExpMin is adjusted per dataset so "fit" is always reachable.
    zoomExpMin: -6,
    zoomExpMax: 4,

    renderSeq: 0,
    lastRenderMs: 0,
    _rafPending: false,

    mouse: {in:false, x:0, y:0, dragging:false, lastX:0, lastY:0},

    selection: {enabled:false, drawing:false, x0:0,y0:0,x1:0,y1:0, imgRect:null},

    histDrag: {active:false, handle:null},
    histMode: 'whole',
    histViewDebounce: null,
    spectrumPickEnabled: false,
    areaSelectionMode: "single",
    analysisHist: { open: false, hoverBin: -1, stats: null },
    draw: { tool: "none", color: "#22c55e", activePointerId: null, draft: null, rulerDrag: null, rulerHover: null, areaMove: null, nextItemId: 1 },

    exportKind: null,
  };

  
  // ========= I/O mode =========

  const cacheRuntime = createCacheRuntime({
    state,
    clamp,
    appConfig: APP_CONFIG,
    updatePerf: () => updatePerf(),
    updatePyramidInflight: (ds) => pyramid.updateInflightForIO(ds),
    getIOConcurrencyMax: () => IO_CONCURRENCY_MAX,
  });

  function setIOParallel(enabled){
    IO_CONCURRENCY = cacheRuntime.setIOParallel(enabled);
  }

  // ========= Cache budgeting =========

  function recomputeCacheBudgets(){
    cacheRuntime.recomputeCacheBudgets();
  }
  // ========= Zoom mapping =========

  const viewControls = createViewControls({
    state,
    els,
    clamp,
    getActive,
    onRender: () => render(),
  });
  function computeFitScale(ds){ return viewControls.computeFitScale(ds); }
  function minScaleFor(ds){ return viewControls.minScaleFor(ds); }
  function updateZoomRange(ds){ viewControls.updateZoomRange(ds); }
  function sliderToScale(v){ return viewControls.sliderToScale(v); }
  function scaleToSlider(s){ return viewControls.scaleToSlider(s); }
  function updateZoomLabel(){ viewControls.updateZoomLabel(); }

  // ========= Dataset helpers =========

  let datasetRuntime = null;
  function getActive(){ return datasetRuntime ? datasetRuntime.getActive() : null; }
  function setActiveDataset(id, opts){ if (datasetRuntime) datasetRuntime.setActiveDataset(id, opts); }
  function bandLabel(ds, b){ return datasetRuntime ? datasetRuntime.bandLabel(ds, b) : `Band ${b}`; }
  async function addDatasetsFromFileList(files){ if (datasetRuntime) await datasetRuntime.addDatasetsFromFileList(files); }
  async function addDatasetFromFiles(hdrFile, dataFile){ if (datasetRuntime) await datasetRuntime.addDatasetFromFiles(hdrFile, dataFile); }
  function closeDataset(id){
    if (spectrum && spectrum.isOpenForDatasetId(id)) closeSpectrum();
    if (datasetRuntime) datasetRuntime.closeDataset(id);
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

  function getHistogramSelectionItems(ds) {
    const items = listHistogramSelectionItems(ds);
    if (!items.length) return [];
    if (isAreaSelectionGrouped()) return items;
    const selectedId = ensureSelectedAreaId(ds, { preferLatest: true });
    if (!Number.isFinite(selectedId)) return [];
    return items.filter((item) => item.id === selectedId);
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
    if (!spectrum || !spectrum.isOpenForDatasetId(ds.id)) return;
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
    const wantsSpatial = !!(state.analysisHist.open && ds.id === state.activeId);
    const wantsSpectral = !!(state.spectrumPickEnabled && spectrum && spectrum.isOpenForDatasetId(ds.id));
    if (wantsSpatial) positionAnalysisHistogramPanel();
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

  function resolveEffectiveSelectionBounds(ds, selections = null) {
    if (!ds) return null;
    const list = Array.isArray(selections) ? selections : getHistogramSelectionItems(ds);
    if (!Array.isArray(list) || !list.length) return null;
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (const selection of list) {
      const bounds = resolveSelectionBoundsForSpectrum(ds, selection);
      if (!bounds) continue;
      if (bounds.x0 < x0) x0 = bounds.x0;
      if (bounds.y0 < y0) y0 = bounds.y0;
      if (bounds.x1 > x1) x1 = bounds.x1;
      if (bounds.y1 > y1) y1 = bounds.y1;
    }
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) return null;
    return { x0, y0, x1, y1 };
  }

  function resolveSelectionBoundsList(ds, selections = null) {
    if (!ds) return [];
    const list = Array.isArray(selections) ? selections : getHistogramSelectionItems(ds);
    if (!Array.isArray(list) || !list.length) return [];
    const out = [];
    for (const selection of list) {
      const bounds = resolveSelectionBoundsForSpectrum(ds, selection);
      if (!bounds) continue;
      out.push({
        id: Number.isFinite(selection?.id) ? selection.id : null,
        x0: bounds.x0,
        y0: bounds.y0,
        x1: bounds.x1,
        y1: bounds.y1
      });
    }
    return out;
  }

  function rectOverlapArea(a, b) {
    const x0 = Math.max(a.x, b.x);
    const y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.w, b.x + b.w);
    const y1 = Math.min(a.y + a.h, b.y + b.h);
    if (x1 <= x0 || y1 <= y0) return 0;
    return (x1 - x0) * (y1 - y0);
  }

  function imageBoundsToScreenRect(ds, bounds) {
    if (!ds || !bounds) return null;
    const scale = Math.max(1e-9, Number(ds?.view?.scale) || 1);
    const sx0 = (bounds.x0 - ds.view.x) * scale;
    const sy0 = (bounds.y0 - ds.view.y) * scale;
    const sx1 = (bounds.x1 + 1 - ds.view.x) * scale;
    const sy1 = (bounds.y1 + 1 - ds.view.y) * scale;
    return {
      x: Math.min(sx0, sx1),
      y: Math.min(sy0, sy1),
      w: Math.max(1, Math.abs(sx1 - sx0)),
      h: Math.max(1, Math.abs(sy1 - sy0))
    };
  }

  function choosePanelPlacementNearSelection({
    ds,
    panelWidth,
    panelHeight,
    targetBounds,
    avoidBounds = [],
    pointerType = "mouse"
  }) {
    if (!ds || !targetBounds || !els.main) return null;
    const mainRect = els.main.getBoundingClientRect();
    const panelW = Math.max(220, panelWidth || 380);
    const panelH = Math.max(120, panelHeight || 230);
    const gap = pointerType === "touch" ? 56 : 28;
    const margin = 8;
    const targetRect = imageBoundsToScreenRect(ds, targetBounds);
    if (!targetRect) return null;
    const avoidRects = Array.isArray(avoidBounds)
      ? avoidBounds.map((b) => imageBoundsToScreenRect(ds, b)).filter(Boolean)
      : [];

    const cx = targetRect.x + (targetRect.w / 2);
    const cy = targetRect.y + (targetRect.h / 2);
    const candidates = [
      { x: targetRect.x + targetRect.w + gap, y: cy - (panelH / 2) },
      { x: targetRect.x - panelW - gap, y: cy - (panelH / 2) },
      { x: cx - (panelW / 2), y: targetRect.y + targetRect.h + gap },
      { x: cx - (panelW / 2), y: targetRect.y - panelH - gap },
      { x: targetRect.x + targetRect.w + gap, y: targetRect.y + targetRect.h + gap },
      { x: targetRect.x - panelW - gap, y: targetRect.y - panelH - gap },
      { x: targetRect.x + targetRect.w + gap, y: targetRect.y - panelH - gap },
      { x: targetRect.x - panelW - gap, y: targetRect.y + targetRect.h + gap }
    ];

    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;
    let bestAvoidOverlap = Number.POSITIVE_INFINITY;
    for (const cand of candidates) {
      const x = Math.max(margin, Math.min(cand.x, mainRect.width - panelW - margin));
      const y = Math.max(margin, Math.min(cand.y, mainRect.height - panelH - margin));
      const panel = { x, y, w: panelW, h: panelH };
      const targetOverlap = rectOverlapArea(panel, targetRect);
      let avoidOverlap = 0;
      for (const avoidRect of avoidRects) avoidOverlap += rectOverlapArea(panel, avoidRect);
      const dx = x - cand.x;
      const dy = y - cand.y;
      const dist = Math.hypot(dx, dy);
      const score = (avoidOverlap * 40) + (targetOverlap * 6) + dist;
      if (avoidOverlap < bestAvoidOverlap || (avoidOverlap === bestAvoidOverlap && score < bestScore)) {
        bestAvoidOverlap = avoidOverlap;
        bestScore = score;
        best = { x, y };
      }
    }
    return best;
  }

  function resolveSelectionBoundsForSpectrum(ds, selection) {
    if (!ds || !selection || !Array.isArray(selection.points) || !selection.points.length) return null;
    const maxX = Math.max(0, ds.meta.samples - 1);
    const maxY = Math.max(0, ds.meta.lines - 1);

    if (selection.tool === "rect" && selection.points.length >= 2) {
      const a = selection.points[0];
      const b = selection.points[selection.points.length - 1];
      const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x)));
      const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y)));
      const x1 = Math.min(maxX, Math.ceil(Math.max(a.x, b.x)));
      const y1 = Math.min(maxY, Math.ceil(Math.max(a.y, b.y)));
      if (x1 < x0 || y1 < y0) return null;
      return { x0, y0, x1, y1, width: x1 - x0 + 1, height: y1 - y0 + 1 };
    }

    if (selection.tool === "shape" && selection.points.length >= 3) {
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxXv = Number.NEGATIVE_INFINITY;
      let maxYv = Number.NEGATIVE_INFINITY;
      for (const p of selection.points) {
        if (!p) continue;
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxXv) maxXv = p.x;
        if (p.y > maxYv) maxYv = p.y;
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxXv) || !Number.isFinite(maxYv)) return null;
      const x0 = Math.max(0, Math.floor(minX));
      const y0 = Math.max(0, Math.floor(minY));
      const x1 = Math.min(maxX, Math.ceil(maxXv));
      const y1 = Math.min(maxY, Math.ceil(maxYv));
      if (x1 < x0 || y1 < y0) return null;
      return { x0, y0, x1, y1, width: x1 - x0 + 1, height: y1 - y0 + 1 };
    }

    return null;
  }

  async function buildAreaAverageSpectrum(ds, selections) {
    if (!ds || !Array.isArray(selections) || !selections.length) return null;
    const valid = [];
    let totalArea = 0;
    for (const selection of selections) {
      if (!isHistogramSelectionTool(selection)) continue;
      const bounds = resolveSelectionBoundsForSpectrum(ds, selection);
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) continue;
      valid.push({ selection, bounds });
      totalArea += bounds.width * bounds.height;
    }
    if (!valid.length) return null;

    const targetSamples = 220_000;
    const sampleStep = Math.max(1, Math.ceil(Math.sqrt(totalArea / Math.max(1, targetSamples))));
    const bands = ds.meta.bands;
    const spectrumMean = new Float32Array(bands);
    const spectrumStd = new Float32Array(bands);
    let sampleCount = 0;

    for (let band = 0; band < bands; band += 1) {
      const seen = new Set();
      let sum = 0;
      let sumSq = 0;
      let count = 0;

      for (const item of valid) {
        const { selection, bounds } = item;
        const outW = Math.max(1, Math.ceil(bounds.width / sampleStep));
        const outH = Math.max(1, Math.ceil(bounds.height / sampleStep));
        let raw;
        if (ds.meta.interleave === "bip") {
          raw = await readBandWindowBIP(ds.meta, ds.ds, band, bounds.x0, bounds.y0, outW, outH, sampleStep);
        } else {
          raw = await readBandWindow(ds.meta, ds.ds, band, bounds.x0, bounds.y0, outW, outH, sampleStep);
        }
        const f32 = toFloat32(raw);
        const isShape = selection.tool === "shape" && Array.isArray(selection.points) && selection.points.length >= 3;
        for (let row = 0; row < outH; row += 1) {
          const iy = bounds.y0 + row * sampleStep;
          if (iy > bounds.y1) continue;
          for (let col = 0; col < outW; col += 1) {
            const ix = bounds.x0 + col * sampleStep;
            if (ix > bounds.x1) continue;
            if (isShape) {
              const cx = ix + (0.5 * sampleStep);
              const cy = iy + (0.5 * sampleStep);
              if (!pointInPolygon({ x: cx, y: cy }, selection.points)) continue;
            }
            const key = iy * ds.meta.samples + ix;
            if (seen.has(key)) continue;
            seen.add(key);
            const v = f32[row * outW + col];
            sum += v;
            sumSq += (v * v);
            count += 1;
          }
        }
      }

      if (count > 0) {
        const mean = sum / count;
        const variance = Math.max(0, (sumSq / count) - (mean * mean));
        spectrumMean[band] = mean;
        spectrumStd[band] = Math.sqrt(variance);
        if (!sampleCount) sampleCount = count;
      } else {
        spectrumMean[band] = NaN;
        spectrumStd[band] = NaN;
      }
    }

    if (!sampleCount) return null;
    return {
      yVals: spectrumMean,
      stdVals: spectrumStd,
      sampleCount,
      sampleStep,
      selectionCount: valid.length
    };
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

  function sq(v) {
    return v * v;
  }

  function pointDistanceToSegment(point, a, b) {
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const lenSq = sq(vx) + sq(vy);
    if (lenSq <= 1e-12) return Math.hypot(point.x - a.x, point.y - a.y);
    const t = clamp(((point.x - a.x) * vx + (point.y - a.y) * vy) / lenSq, 0, 1);
    const px = a.x + vx * t;
    const py = a.y + vy * t;
    return Math.hypot(point.x - px, point.y - py);
  }

  function pointInPolygon(point, points) {
    let inside = false;
    const n = points.length;
    for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
      const pi = points[i];
      const pj = points[j];
      const intersects = ((pi.y > point.y) !== (pj.y > point.y))
        && (point.x < (((pj.x - pi.x) * (point.y - pi.y)) / Math.max(1e-12, (pj.y - pi.y)) + pi.x));
      if (intersects) inside = !inside;
    }
    return inside;
  }

  function distanceToLineDrawing(point, item) {
    if (!item.points || item.points.length < 2) return Number.POSITIVE_INFINITY;
    return pointDistanceToSegment(point, item.points[0], item.points[item.points.length - 1]);
  }

  function distanceToRectDrawing(point, item) {
    if (!item.points || item.points.length < 2) return Number.POSITIVE_INFINITY;
    const a = item.points[0];
    const b = item.points[item.points.length - 1];
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    if (point.x >= x0 && point.x <= x1 && point.y >= y0 && point.y <= y1) return 0;
    const p00 = { x: x0, y: y0 };
    const p10 = { x: x1, y: y0 };
    const p11 = { x: x1, y: y1 };
    const p01 = { x: x0, y: y1 };
    return Math.min(
      pointDistanceToSegment(point, p00, p10),
      pointDistanceToSegment(point, p10, p11),
      pointDistanceToSegment(point, p11, p01),
      pointDistanceToSegment(point, p01, p00),
    );
  }

  function distanceToShapeDrawing(point, item) {
    if (!item.points || item.points.length < 2) return Number.POSITIVE_INFINITY;
    if (item.points.length >= 3 && pointInPolygon(point, item.points)) return 0;
    let minDist = Number.POSITIVE_INFINITY;
    for (let i = 1; i < item.points.length; i += 1) {
      minDist = Math.min(minDist, pointDistanceToSegment(point, item.points[i - 1], item.points[i]));
    }
    if (item.points.length >= 3) {
      minDist = Math.min(minDist, pointDistanceToSegment(point, item.points[item.points.length - 1], item.points[0]));
    }
    return minDist;
  }

  function distanceToDrawing(point, item) {
    if (!item || !item.tool) return Number.POSITIVE_INFINITY;
    if (item.tool === "ruler" || item.tool === "line") return distanceToLineDrawing(point, item);
    if (item.tool === "rect") return distanceToRectDrawing(point, item);
    if (item.tool === "shape") return distanceToShapeDrawing(point, item);
    return Number.POSITIVE_INFINITY;
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
    if (!selectionChanged && state.analysisHist.open && ds.id === state.activeId) refreshAnalysisHistogram().catch(() => {});
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

  // ========= UI rebuild =========

  const uiPanels = createUIPanels({
    state,
    els,
    getActive,
    clamp,
    fmt,
    fmtNoGroup,
    humanBytes,
    bandLabel,
    setActiveDataset,
    closeDataset,
    drawHistogram,
    render,
    quickStatsFromArray,
    onNeedWholeStats: (ds, band) => buildBandStatsWhole(ds, band).catch(() => {}),
    onBandChanged: (ds) => updateSelectionHistogramForDataset(ds),
  });

  function rebuildDatasetList(){ uiPanels.rebuildDatasetList(); }
  function updateMetaUI(){ uiPanels.updateMetaUI(); }
  function updatePerf(){ uiPanels.updatePerf(); }
  function rebuildBandTree(opts){ uiPanels.rebuildBandTree(opts); }
  function getBandSettings(ds, band){ return uiPanels.getBandSettings(ds, band); }
  function resolveStats(ds){ return uiPanels.resolveStats(ds); }
  function setActiveBand(ds, band){ uiPanels.setActiveBand(ds, band); }
  function updateDisplayUI(force=false){ uiPanels.updateDisplayUI(force); }
  function syncRangeInputsFromSettings(ds, opts){ uiPanels.syncRangeInputsFromSettings(ds, opts); }
  function applyRangeFromNumbers(ds){ uiPanels.applyRangeFromNumbers(ds); }
  function resetDisplay(ds){ uiPanels.resetDisplay(ds); }
  function autoDisplay(ds){ uiPanels.autoDisplay(ds); }

  datasetRuntime = createDatasetRuntime({
    state,
    clamp,
    fmtNoGroup,
    addDatasetsFromFileListMod,
    addDatasetFromFilesMod,
    setStatus,
    alertFn: (msg) => alert(msg),
    getIOConcurrency: () => IO_CONCURRENCY,
    recomputeCacheBudgets,
    closeSpectrum,
    onAfterDatasetUIUpdate: (opts = {}) => {
      rebuildDatasetList();
      rebuildBandTree({ preserveScroll: !!opts.preserveBandTreeScroll });
      updateMetaUI();
      updatePerf();
      updateDisplayUI(true);
      const ds = getActive();
      if (ds) updateSelectionHistogramForDataset(ds);
      else if (state.analysisHist.open) refreshAnalysisHistogram().catch(() => {});
      ensureMarqueeTicker();
    },
    updateZoomRange,
    fitToScreen,
    render,
    disposePyramid,
    clearSelection,
    onNeedWholeStats: (ds, band) => buildBandStatsWhole(ds, band).catch(() => {}),
  });
  // ========= Histogram computation & drawing =========

  function quickStatsFromArray(arr){ return quickStatsFromArrayCore(arr); }

  function computeHistogram(arr, bins=256){ return computeHistogramCore(arr, bins); }

  function tone01(v, minVal, maxVal, brightness, gain, contrast){ return tone01Core(v, minVal, maxVal, brightness, gain, contrast); }

  const histogram = createHistogramController({
    state,
    els,
    setStatus,
    readBandWindow,
    readBandWindowBIP,
    toFloat32,
    computeHistogram,
    tone01,
    getBandSettings,
    resolveStats,
    syncRangeInputsFromSettings,
    render,
  });

  async function buildBandStatsWhole(ds, band){ await histogram.buildBandStatsWhole(ds, band); }
  function ensureViewHistogram(ds){ histogram.ensureViewHistogram(ds); }
  async function updateSelectionHistogram(ds, selections){ await histogram.updateSelectionHistogram(ds, selections); }
  function clearSelectionHistogram(ds){ histogram.clearSelectionHistogram(ds); }
  function drawHistogram(ds){ histogram.drawHistogram(ds); }
  function histPickHandle(ds, px, py){ return histogram.histPickHandle(ds, px, py); }
  function applyHistogramDrag(ds, kind, clientX){ histogram.applyHistogramDrag(ds, kind, clientX); }

  function setAnalysisHistogramBusy(isBusy) {
    if (!els.btnToolHistogram) return;
    els.btnToolHistogram.classList.toggle("loading", !!isBusy);
    els.btnToolHistogram.disabled = !!isBusy;
    els.btnToolHistogram.setAttribute("aria-busy", isBusy ? "true" : "false");
  }

  function syncAnalysisHistogramButtonState() {
    if (!els.btnToolHistogram) return;
    els.btnToolHistogram.classList.toggle("active", !!state.analysisHist.open);
    els.btnToolHistogram.setAttribute("aria-pressed", state.analysisHist.open ? "true" : "false");
  }

  function updateAnalysisStatsPanel(stats) {
    if (!els.analysisStatN) return;
    if (!stats) {
      els.analysisStatN.textContent = "—";
      els.analysisStatRange.textContent = "—";
      els.analysisStatMeanStd.textContent = "—";
      els.analysisStatMode.textContent = "—";
      els.analysisStatBins.textContent = "—";
      els.analysisStatBinWidth.textContent = "—";
      return;
    }
    const bins = stats.bins?.length || 0;
    const binWidth = Number.isFinite(stats.binWidth) ? stats.binWidth : ((stats.max - stats.min) / Math.max(1, bins));
    els.analysisStatN.textContent = fmtNoGroup(stats.count || 0);
    els.analysisStatRange.textContent = `${formatNumber(stats.min)} / ${formatNumber(stats.max)}`;
    els.analysisStatMeanStd.textContent = `${formatNumber(stats.mean)} / ${formatNumber(stats.stdDev)}`;
    els.analysisStatMode.textContent = formatNumber(stats.mode);
    els.analysisStatBins.textContent = fmtNoGroup(bins);
    els.analysisStatBinWidth.textContent = formatNumber(binWidth);
  }

  function updateAnalysisHoverText(stats, binIndex) {
    if (!els.analysisHistHover) return;
    if (!stats || !stats.bins || binIndex < 0 || binIndex >= stats.bins.length) {
      els.analysisHistHover.textContent = "Hover a bin to inspect value/count.";
      return;
    }
    const bins = stats.bins.length;
    const bw = Number.isFinite(stats.binWidth) ? stats.binWidth : ((stats.max - stats.min) / Math.max(1, bins));
    const lo = stats.min + binIndex * bw;
    const hi = lo + bw;
    const count = stats.bins[binIndex] || 0;
    els.analysisHistHover.textContent = `Bin ${binIndex}: ${formatNumber(lo)} .. ${formatNumber(hi)}  |  Count ${fmtNoGroup(count)}`;
  }

  function drawAnalysisHistogramCanvas(stats) {
    if (!els.analysisHistCanvas) return;
    const canvas = els.analysisHistCanvas;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d", { alpha: true });
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(17,24,39,0.96)";
    ctx.fillRect(0, 0, w, h);

    if (!stats || !stats.bins || !stats.bins.length) {
      ctx.fillStyle = "rgba(209,213,219,0.9)";
      ctx.font = `${12 * dpr}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
      ctx.fillText("Histogram not ready", 10 * dpr, 20 * dpr);
      ctx.restore();
      return;
    }

    const bins = stats.bins;
    const maxBin = Math.max(1, ...bins);
    const plot = histogramPlotRect(w, h, dpr);
    const barW = plot.plotW / bins.length;
    const hoverBin = state.analysisHist.hoverBin;

    ctx.fillStyle = "rgba(148,163,184,0.45)";
    for (let i = 0; i < bins.length; i += 1) {
      const bh = (bins[i] / maxBin) * plot.plotH;
      const x = plot.plotX0 + i * barW;
      const y = plot.plotY0 + (plot.plotH - bh);
      ctx.fillRect(x, y, Math.max(1, barW), bh);
    }

    if (hoverBin >= 0 && hoverBin < bins.length) {
      const bh = (bins[hoverBin] / maxBin) * plot.plotH;
      const x = plot.plotX0 + hoverBin * barW;
      const y = plot.plotY0 + (plot.plotH - bh);
      ctx.fillStyle = "rgba(250,204,21,0.85)";
      ctx.fillRect(x, y, Math.max(1, barW), bh);
      ctx.strokeStyle = "rgba(250,204,21,0.95)";
      ctx.lineWidth = 1.25 * dpr;
      ctx.beginPath();
      ctx.moveTo(x + (0.5 * barW), plot.plotY0);
      ctx.lineTo(x + (0.5 * barW), plot.plotY0 + plot.plotH);
      ctx.stroke();
    }

    ctx.strokeStyle = "rgba(100,116,139,0.9)";
    ctx.lineWidth = 1 * dpr;
    ctx.strokeRect(plot.plotX0, plot.plotY0, plot.plotW, plot.plotH);
    ctx.restore();
  }

  function resolveHistogramStatsForPanel(ds) {
    if (!ds || ds.activeBand == null) return null;
    const selections = getHistogramSelectionItems(ds);
    if (selections.length) {
      const selectionKey = histogramSelectionKeyFromItems(selections);
      const selectionStats = ds.bandStatsSelection;
      if (selectionStats && selectionStats.band === ds.activeBand && selectionStats.selectionKey === selectionKey && selectionStats.stats?.bins) {
        return selectionStats.stats;
      }
    }
    const wholeStats = ds.bandStatsWhole.get(ds.activeBand) || null;
    if (wholeStats && wholeStats.bins && wholeStats.count > 0) return wholeStats;
    if (ds.lastRaster && ds.lastRaster.band === ds.activeBand && ds.lastRaster.dataF32?.length) {
      return computeHistogram(ds.lastRaster.dataF32, 256);
    }
    return null;
  }

  async function ensureHistogramStatsForPanel(ds) {
    if (!ds || ds.activeBand == null) return null;
    const selections = getHistogramSelectionItems(ds);
    if (selections.length) {
      const selectionKey = histogramSelectionKeyFromItems(selections);
      const selStats = ds.bandStatsSelection;
      const ready = !!(selStats && selStats.band === ds.activeBand && selStats.selectionKey === selectionKey && selStats.stats);
      if (!ready) await updateSelectionHistogram(ds, selections);
    } else if (!ds.bandStatsWhole.has(ds.activeBand)) {
      await buildBandStatsWhole(ds, ds.activeBand);
    }
    return resolveHistogramStatsForPanel(ds);
  }

  function positionAnalysisHistogramPanel() {
    if (!els.analysisHistPanel || !els.btnToolHistogram) return;
    const ds = getActive();
    const selections = ds ? getHistogramSelectionItems(ds) : [];
    if (ds && selections.length) {
      const targetBounds = resolveEffectiveSelectionBounds(ds, selections);
      const effectiveIds = new Set(selections.map((item) => item.id));
      const allBounds = resolveSelectionBoundsList(ds, listHistogramSelectionItems(ds));
      const avoidBounds = allBounds
        .filter((b) => !effectiveIds.has(b.id))
        .map((b) => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }));
      const panelRect = els.analysisHistPanel.getBoundingClientRect();
      const placement = choosePanelPlacementNearSelection({
        ds,
        panelWidth: panelRect.width || 380,
        panelHeight: panelRect.height || 360,
        targetBounds,
        avoidBounds,
        pointerType: "mouse"
      });
      if (placement) {
        els.analysisHistPanel.style.left = `${Math.round(placement.x)}px`;
        els.analysisHistPanel.style.top = `${Math.round(placement.y)}px`;
        return;
      }
    }

    const trigger = els.btnToolHistogram.getBoundingClientRect();
    const panelWidth = 380;
    const left = clamp(trigger.right + 8, 8, Math.max(8, window.innerWidth - panelWidth - 8));
    const top = clamp(trigger.top, 8, Math.max(8, window.innerHeight - 360));
    els.analysisHistPanel.style.left = `${left}px`;
    els.analysisHistPanel.style.top = `${top}px`;
  }

  async function refreshAnalysisHistogram() {
    if (!state.analysisHist.open || !els.analysisHistPanel) return;
    positionAnalysisHistogramPanel();
    const ds = getActive();
    state.analysisHist.hoverBin = -1;
    if (!ds) {
      state.analysisHist.stats = null;
      updateAnalysisStatsPanel(null);
      updateAnalysisHoverText(null, -1);
      drawAnalysisHistogramCanvas(null);
      return;
    }

    setAnalysisHistogramBusy(true);
    setStatus("histogram…", "warn");
    try {
      const stats = await ensureHistogramStatsForPanel(ds);
      state.analysisHist.stats = stats;
      updateAnalysisStatsPanel(stats);
      updateAnalysisHoverText(stats, -1);
      drawAnalysisHistogramCanvas(stats);
      setStatus("ready", "ok");
    } catch (err) {
      console.warn("Analysis histogram failed", err);
      state.analysisHist.stats = null;
      updateAnalysisStatsPanel(null);
      updateAnalysisHoverText(null, -1);
      drawAnalysisHistogramCanvas(null);
      setStatus("ready", "ok");
    } finally {
      setAnalysisHistogramBusy(false);
    }
  }

  function openAnalysisHistogramPanel() {
    if (!els.analysisHistPanel) return;
    state.analysisHist.open = true;
    syncAnalysisHistogramButtonState();
    els.analysisHistPanel.style.display = "block";
    els.analysisHistPanel.setAttribute("aria-hidden", "false");
    positionAnalysisHistogramPanel();
    refreshAnalysisHistogram().catch(() => {});
  }

  function closeAnalysisHistogramPanel() {
    state.analysisHist.open = false;
    state.analysisHist.hoverBin = -1;
    syncAnalysisHistogramButtonState();
    if (els.analysisHistPanel) {
      els.analysisHistPanel.style.display = "none";
      els.analysisHistPanel.setAttribute("aria-hidden", "true");
    }
    setAnalysisHistogramBusy(false);
  }

  function toggleAnalysisHistogramPanel() {
    if (state.analysisHist.open) closeAnalysisHistogramPanel();
    else openAnalysisHistogramPanel();
  }

  function getAnalysisHistogramOpen() {
    return !!state.analysisHist.open;
  }

  function setAnalysisHistogramOpen(nextOpen) {
    if (nextOpen) openAnalysisHistogramPanel();
    else closeAnalysisHistogramPanel();
  }

  function onAnalysisHistogramPointerMove(ev) {
    const stats = state.analysisHist.stats;
    const canvas = els.analysisHistCanvas;
    if (!stats || !canvas || !stats.bins?.length) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const x = (ev.clientX - rect.left) * dpr;
    const y = (ev.clientY - rect.top) * dpr;
    const plot = histogramPlotRect(canvas.width, canvas.height, dpr);
    if (x < plot.plotX0 || x > (plot.plotX0 + plot.plotW) || y < plot.plotY0 || y > (plot.plotY0 + plot.plotH)) {
      if (state.analysisHist.hoverBin !== -1) {
        state.analysisHist.hoverBin = -1;
        updateAnalysisHoverText(stats, -1);
        drawAnalysisHistogramCanvas(stats);
      }
      return;
    }
    const t = clamp((x - plot.plotX0) / Math.max(1, plot.plotW), 0, 0.999999);
    const idx = clamp(Math.floor(t * stats.bins.length), 0, stats.bins.length - 1);
    if (idx === state.analysisHist.hoverBin) return;
    state.analysisHist.hoverBin = idx;
    updateAnalysisHoverText(stats, idx);
    drawAnalysisHistogramCanvas(stats);
  }

  function onAnalysisHistogramPointerLeave() {
    const stats = state.analysisHist.stats;
    if (!stats) return;
    if (state.analysisHist.hoverBin === -1) return;
    state.analysisHist.hoverBin = -1;
    updateAnalysisHoverText(stats, -1);
    drawAnalysisHistogramCanvas(stats);
  }

  function updateSelectionHistogramForDataset(ds) {
    if (!ds) return;
    const selections = getHistogramSelectionItems(ds);
    if (!selections.length) {
      clearSelectionHistogram(ds);
      ensureMarqueeTicker();
      if (state.analysisHist.open && ds.id === state.activeId) refreshAnalysisHistogram().catch(() => {});
      return;
    }
    updateSelectionHistogram(ds, selections).then(() => {
      if (state.analysisHist.open && ds.id === state.activeId) refreshAnalysisHistogram().catch(() => {});
    }).catch(() => {});
    if (state.spectrumPickEnabled && ds.id === state.activeId && (!spectrum || !spectrum.isOpenForDatasetId(ds.id))) {
      openSpectrumForEffectiveArea(ds, null, false).catch(() => {});
    } else {
      refreshAreaSpectrumIfOpen(ds, null, false);
    }
    ensureMarqueeTicker();
  }
  // ========= Rendering (direct read or pyramid) =========

  function clampView(){ viewControls.clampView(); }
  function fitToScreen(){ viewControls.fitToScreen(); }
  function screenToImage(sx, sy){ return viewControls.screenToImage(sx, sy); }

  function resolveDisplayRange(ds, band, fallbackArray){ return resolveDisplayRangeCore(ds, band, fallbackArray, getBandSettings); }

  async function tryRasterFromPyramid(ds, band, eff){
    ds.__pyrPreferImmediate = !!state.mouse.dragging;
    return pyramid.tryRasterFromPyramid(ds, band, eff);
  }

  function cpuRenderGray(rasterF32, w, h, params){
    // draw into offscreen imageData then scale to canvas
    const img = cpuCtx.createImageData(w, h);
    const dst = img.data;
    const minVal = params.minVal, maxVal = params.maxVal;
    const brightness = params.brightness, gain = params.gain, contrast = params.contrast;

    for (let i=0, j=0; i<rasterF32.length; i++, j+=4){
      const t = tone01(rasterF32[i], minVal, maxVal, brightness, gain, contrast);
      const u = Math.round(t * 255);
      dst[j] = u; dst[j+1] = u; dst[j+2] = u; dst[j+3] = 255;
    }

    // Clear + draw scaled
    cpuCtx.save();
    cpuCtx.setTransform(1,0,0,1,0,0);
    cpuCtx.imageSmoothingEnabled = false;
    cpuCtx.clearRect(0,0,els.cpuCanvas.width, els.cpuCanvas.height);

    // draw to temp canvas for scaling if needed
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    off.getContext('2d', {alpha:false}).putImageData(img,0,0);
    cpuCtx.drawImage(off, 0,0,w,h, 0,0, els.cpuCanvas.width, els.cpuCanvas.height);

    cpuCtx.restore();
  }

  const overlayRenderer = createOverlayRenderer({
    els,
    overlayCtx,
    getDevicePixelRatio: () => window.devicePixelRatio || 1,
    getDrawData,
  });

  function drawOverlays(ds){
    overlayRenderer.drawOverlays(ds);
  }

  let marqueeTimer = null;
  function ensureMarqueeTicker() {
    const active = getActive();
    const shouldRun = getHistogramSelectionItems(active).length > 0;
    if (shouldRun && marqueeTimer == null) {
      marqueeTimer = window.setInterval(() => {
        const ds = getActive();
        if (getHistogramSelectionItems(ds).length === 0) {
          clearInterval(marqueeTimer);
          marqueeTimer = null;
          return;
        }
        drawOverlays(ds);
      }, 90);
      return;
    }
    if (!shouldRun && marqueeTimer != null) {
      clearInterval(marqueeTimer);
      marqueeTimer = null;
    }
  }

  let renderer = null;
  function resizeCanvases(){ if (renderer) renderer.resizeCanvases(); }
  function scheduleRender(){ if (renderer) renderer.scheduleRender(); }
  async function render(opts = {}){ if (renderer) await renderer.render(opts); }

  renderer = createRenderer({
    state,
    els,
    now,
    setStatus,
    getActive,
    getBandSettings,
    resolveDisplayRange,
    initWebGPU,
    gpuSupported,
    gpuRender,
    cpuRenderGray,
    tryRasterFromPyramid,
    readBandWindow,
    readBandWindowBIP,
    toFloat32,
    clampView,
    syncRangeInputsFromSettings,
    drawOverlays,
    updatePerf,
    renderThumbnail,
    updateHud,
    ensureViewHistogram,
  });

  // ========= Thumbnail / magnifier =========

  const thumbnails = createThumbnailController({
    els,
    thumbCtx,
    now,
    toFloat32,
    tone01,
    resolveDisplayRange,
    getBandSettings,
    readBandWindow,
    readBandWindowBIP,
    getActive,
    render,
    getDevicePixelRatio: () => window.devicePixelRatio || 1,
  });

  async function renderWindowToImageData(ds, band, x0, y0, outW, outH, step){
    return thumbnails.renderWindowToImageData(ds, band, x0, y0, outW, outH, step);
  }

  function renderThumbnail(){
    thumbnails.renderThumbnail();
  }

  function onThumbClick(ev){
    thumbnails.onThumbClick(ev);
  }
  // Magnifier removed (keeps first-load lighter).

  // ========= HUD probe =========

  const hud = createHudController({
    els,
    state,
    getActive,
    screenToImage,
  });

  function updateHud(){ hud.updateHud(); }

  // ========= Spectrum (z-profile) panel =========

  const spectrum = createSpectrumController({
    els,
    specCtx,
    getActive,
    bandLabel,
    updatePerf,
    sanitizeFilePart,
    downloadBlob,
    setActiveBand,
    readSpectrumAtPixel: (ds, ix, iy) => readSpectrumAtPixelCore(ds, ix, iy, IO_CONCURRENCY),
    wavelengthArrayOrNull: (ds) => wavelengthArrayOrNullCore(ds),
  });

  async function openSpectrumAt(ds, ix, iy, opts = {}) {
    if (!ds) return;
    const selections = getHistogramSelectionItems(ds);
    const useArea = !!(opts.forceArea || selections.length);
    if (!useArea) {
      await spectrum.openSpectrumAt(ds, ix, iy, opts);
      return;
    }

    const area = await buildAreaAverageSpectrum(ds, selections);
    if (!area || !area.yVals || !area.yVals.length) {
      await spectrum.openSpectrumAt(ds, ix, iy, opts);
      return;
    }
    const selectionBounds = resolveEffectiveSelectionBounds(ds, selections);
    const effectiveIds = new Set(selections.map((item) => item.id));
    const occluderBounds = resolveSelectionBoundsList(ds, listHistogramSelectionItems(ds))
      .filter((b) => !effectiveIds.has(b.id))
      .map((b) => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }));

    const sampled = area.sampleStep > 1;
    const sampleLabel = sampled
      ? `${fmtNoGroup(area.sampleCount)} sampled px (step ${area.sampleStep})`
      : `${fmtNoGroup(area.sampleCount)} px`;
    const subLabel = `Area average (${sampleLabel}, ${fmtNoGroup(area.selectionCount)} region${area.selectionCount > 1 ? "s" : ""})`;
    await spectrum.openSpectrumAt(ds, ix, iy, {
      ...opts,
      yVals: area.yVals,
      stdVals: area.stdVals,
      xVals: wavelengthArrayOrNullCore(ds),
      subLabel,
      sourceType: "area",
      sourceMeta: {
        sampleCount: area.sampleCount,
        selectionCount: area.selectionCount,
        sampleStep: area.sampleStep
      },
      selectionBounds,
      selectionOccluders: occluderBounds
    });
  }
  async function openSpectrumForEffectiveArea(ds = null, anchor = null, noReposition = false) {
    const target = ds || getActive();
    if (!target) return false;
    const selections = getHistogramSelectionItems(target);
    if (!selections.length) return false;
    await openSpectrumAt(target, 0, 0, {
      clientX: Number(anchor?.clientX),
      clientY: Number(anchor?.clientY),
      pointerType: anchor?.pointerType === "touch" ? "touch" : "mouse",
      noReposition: !!noReposition,
      forceArea: true
    });
    return true;
  }
  function redrawSpectrum(){ spectrum.redrawSpectrum(); }
  function closeSpectrum(){ spectrum.closeSpectrum(); }
  function exportSpectrumCSV(){ spectrum.exportSpectrumCSV(); }
// ========= Mouse interaction =========

  const interactions = createInteractionController({
    els,
    state,
    getActive,
    clamp,
    setStatus,
    updateHud,
    screenToImage,
    clampView,
    render,
    minScaleFor,
    scaleToSlider,
    updateZoomLabel,
  });

  function clearSelection(){ interactions.clearSelection(); }
  function onPointerDown(ev){ interactions.onPointerDown(ev); }
  function onPointerMove(ev){ interactions.onPointerMove(ev); }
  function onPointerUp(ev){ interactions.onPointerUp(ev); }
  function onPointerCancel(ev){ interactions.onPointerCancel(ev); }
  function onPointerLeave(){ interactions.onPointerLeave(); }
  function zoomAt(factor, sx, sy){ interactions.zoomAt(factor, sx, sy); }
  function onWheel(ev){ interactions.onWheel(ev); }
  // ========= Export =========

  const exportService = createExportService({
    state,
    els,
    getActive,
    setStatus,
    humanBytes,
    fmt,
    clamp,
    bandLabel,
    renderWindowToImageData,
    readBandWindow,
    readBandWindowBIP,
    downloadBlob,
    alertFn: (msg) => alert(msg),
    confirmFn: (msg) => confirm(msg),
  });
  const exportDialog = createExportDialogController({
    state,
    els,
    getActive,
    bandLabel,
    humanBytes,
    collectAreaSelections: (ds) => exportService.collectAreaSelections(ds),
    hasNonRectSelections: (selections) => exportService.hasNonRectSelections(selections),
    resolveSelectionExportPlan: (ds, selections, separate) => exportService.resolveSelectionExportPlan(ds, selections, separate),
    resolveExportRect: (ds, scope) => exportService.resolveExportRect(ds, scope),
    alertFn: (msg) => alert(msg),
  });

  function sanitizeFilePart(s){ return exportService.sanitizeFilePart(s); }

  function openExportDialog(){ exportDialog.openExportDialog(); }
  function updateExportDialogUI(){ exportDialog.updateExportDialogUI(); }
  function updateExportEstimate(){ exportDialog.updateExportEstimate(); }

  async function runExportFromDialog(){ await exportService.runExportFromDialog(); }

  // ========= Wiring events =========

  syncAnalysisHistogramButtonState();

  wireApp({
    state,
    els,
    clamp,
    getActive,
    closeSpectrum,
    exportSpectrumCSV,
    screenToImage,
    openSpectrumAt,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onPointerLeave,
    onWheel,
    onThumbClick,
    fitToScreen,
    clampView,
    scaleToSlider,
    updateZoomLabel,
    render,
    zoomAt,
    sliderToScale,
    minScaleFor,
    setIOParallel,
    clearSelection,
    setStatus,
    openExportDialog,
    updateExportDialogUI,
    updateExportEstimate,
    runExportFromDialog,
    rebuildBandTree,
    resetDisplay,
    autoDisplay,
    getBandSettings,
    drawHistogram,
    applyRangeFromNumbers,
    histPickHandle,
    applyHistogramDrag,
    addDatasetsFromFileList,
    resizeCanvases,
    redrawSpectrum,
    disposePyramid,
    updateMetaUI,
    updatePerf,
    getDrawTool,
    getSpectrumPickEnabled,
    getEffectiveAreaSelectionCount,
    getEffectiveAreaSelectionKey,
    getAreaSelectionMode,
    getDrawColor,
    setDrawTool,
    setSpectrumPickEnabled,
    setAreaSelectionMode,
    setDrawColor,
    selectAreaAtPointer,
    isAreaMovePointer,
    beginAreaMoveAtPointer,
    updateAreaMoveAtPointer,
    finishAreaMoveAtPointer,
    cancelAreaMove,
    isDrawingPointer,
    beginDrawingAtPointer,
    updateDrawingAtPointer,
    finishDrawingAtPointer,
    cancelDrawing,
    eraseDrawingAtPointer,
    clearAllAnnotations,
    updateRulerHoverAtPointer,
    clearRulerHover,
    toggleAnalysisHistogramPanel,
    getAnalysisHistogramOpen,
    setAnalysisHistogramOpen,
    closeAnalysisHistogramPanel,
    refreshAnalysisHistogram,
    positionAnalysisHistogramPanel,
    onAnalysisHistogramPointerMove,
    onAnalysisHistogramPointerLeave,
    openSpectrumForEffectiveArea,
    updateZoomLabelBoot: updateZoomLabel,
    setGpuBadgeAvailable: () => {}
  });
})();











