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
    analysisHist: { open: false, hoverBin: -1, stats: null },
    draw: { tool: "none", color: "#22c55e", activePointerId: null, draft: null, rulerDrag: null, rulerHover: null, nextItemId: 1 },

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

  function getDrawColor() {
    return state.draw.color;
  }

  function setDrawTool(tool) {
    const hadDraft = !!state.draw.draft;
    const hadRulerDrag = !!state.draw.rulerDrag;
    const hadRulerHover = !!state.draw.rulerHover;
    const prevTool = state.draw.tool;
    const next = (tool === "ruler" || tool === "rect" || tool === "shape" || tool === "eraser") ? tool : "none";
    state.draw.tool = (prevTool === next) ? "none" : next;
    const isCreateTool = state.draw.tool === "ruler" || state.draw.tool === "rect" || state.draw.tool === "shape";
    if (state.draw.tool !== prevTool || !isCreateTool) {
      state.draw.activePointerId = null;
      state.draw.draft = null;
      state.draw.rulerDrag = null;
      state.draw.rulerHover = null;
      if (hadDraft || hadRulerDrag || hadRulerHover) render({ reuseRaster: true });
    }
  }

  function setDrawColor(color) {
    if (!color || typeof color !== "string") return;
    state.draw.color = color;
  }

  function getDrawData(ds) {
    if (!ds) return null;
    const items = Array.isArray(ds.drawings) ? ds.drawings : [];
    const draft = (state.draw.draft && state.draw.draft.dsId === ds.id) ? state.draw.draft : null;
    const rulerHover = (state.draw.rulerHover && state.draw.rulerHover.dsId === ds.id) ? state.draw.rulerHover : null;
    const selectionId = Number.isFinite(ds.histSelectionId) ? ds.histSelectionId : null;
    const marqueeOffset = (selectionId == null) ? 0 : ((performance.now() / 110) % 14);
    return { items, draft, rulerHover, selectionId, marqueeOffset };
  }

  function findHistogramSelectionItem(ds) {
    if (!ds || !Array.isArray(ds.drawings)) return null;
    if (!Number.isFinite(ds.histSelectionId)) return null;
    const item = ds.drawings.find((it) => it && it.id === ds.histSelectionId) || null;
    if (!item || (item.tool !== "rect" && item.tool !== "shape")) return null;
    return item;
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
    if (removed && Number.isFinite(ds.histSelectionId) && removed.id === ds.histSelectionId) {
      ds.histSelectionId = null;
      clearSelectionHistogram(ds);
    }
    ensureMarqueeTicker();
    if (state.analysisHist.open && ds.id === state.activeId) refreshAnalysisHistogram().catch(() => {});
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
        ds.histSelectionId = newItem.id;
        updateSelectionHistogramForDataset(ds);
      }
    }
    state.draw.activePointerId = null;
    state.draw.draft = null;
    state.draw.rulerDrag = null;
    ensureMarqueeTicker();
    render({ reuseRaster: true });
  }

  function cancelDrawing() {
    state.draw.activePointerId = null;
    state.draw.draft = null;
    state.draw.rulerDrag = null;
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
  async function updateSelectionHistogram(ds, selection){ await histogram.updateSelectionHistogram(ds, selection); }
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

  function updateAnalysisStatsPanel(stats) {
    if (!els.analysisStatN) return;
    if (!stats) {
      els.analysisStatN.textContent = "—";
      els.analysisStatRange.textContent = "—";
      els.analysisStatMean.textContent = "—";
      els.analysisStatStd.textContent = "—";
      els.analysisStatMode.textContent = "—";
      els.analysisStatBins.textContent = "—";
      els.analysisStatBinWidth.textContent = "—";
      return;
    }
    const bins = stats.bins?.length || 0;
    const binWidth = Number.isFinite(stats.binWidth) ? stats.binWidth : ((stats.max - stats.min) / Math.max(1, bins));
    els.analysisStatN.textContent = fmtNoGroup(stats.count || 0);
    els.analysisStatRange.textContent = `${formatNumber(stats.min)} / ${formatNumber(stats.max)}`;
    els.analysisStatMean.textContent = formatNumber(stats.mean);
    els.analysisStatStd.textContent = formatNumber(stats.stdDev);
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
    }

    ctx.strokeStyle = "rgba(100,116,139,0.9)";
    ctx.lineWidth = 1 * dpr;
    ctx.strokeRect(plot.plotX0, plot.plotY0, plot.plotW, plot.plotH);
    ctx.restore();
  }

  function resolveHistogramStatsForPanel(ds) {
    if (!ds || ds.activeBand == null) return null;
    const resolved = resolveStats(ds);
    if (resolved && resolved.bins && resolved.count > 0) return resolved;
    if (ds.lastRaster && ds.lastRaster.band === ds.activeBand && ds.lastRaster.dataF32?.length) {
      return computeHistogram(ds.lastRaster.dataF32, 256);
    }
    return null;
  }

  async function ensureHistogramStatsForPanel(ds) {
    if (!ds || ds.activeBand == null) return null;
    const selection = findHistogramSelectionItem(ds);
    if (selection) {
      const selStats = ds.bandStatsSelection;
      const ready = !!(selStats && selStats.band === ds.activeBand && selStats.selectionId === ds.histSelectionId && selStats.stats);
      if (!ready) await updateSelectionHistogram(ds, selection);
    } else if (!ds.bandStatsWhole.has(ds.activeBand)) {
      await buildBandStatsWhole(ds, ds.activeBand);
    }
    return resolveHistogramStatsForPanel(ds);
  }

  function positionAnalysisHistogramPanel() {
    if (!els.analysisHistPanel || !els.btnToolHistogram) return;
    const trigger = els.btnToolHistogram.getBoundingClientRect();
    const panelWidth = 380;
    const left = clamp(trigger.right + 8, 8, Math.max(8, window.innerWidth - panelWidth - 8));
    const top = clamp(trigger.top, 8, Math.max(8, window.innerHeight - 360));
    els.analysisHistPanel.style.left = `${left}px`;
    els.analysisHistPanel.style.top = `${top}px`;
  }

  async function refreshAnalysisHistogram() {
    if (!state.analysisHist.open || !els.analysisHistPanel) return;
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
    els.analysisHistPanel.style.display = "block";
    els.analysisHistPanel.setAttribute("aria-hidden", "false");
    positionAnalysisHistogramPanel();
    refreshAnalysisHistogram().catch(() => {});
  }

  function closeAnalysisHistogramPanel() {
    state.analysisHist.open = false;
    state.analysisHist.hoverBin = -1;
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
    const selection = findHistogramSelectionItem(ds);
    if (!selection) {
      ds.histSelectionId = null;
      clearSelectionHistogram(ds);
      ensureMarqueeTicker();
      if (state.analysisHist.open && ds.id === state.activeId) refreshAnalysisHistogram().catch(() => {});
      return;
    }
    updateSelectionHistogram(ds, selection).then(() => {
      if (state.analysisHist.open && ds.id === state.activeId) refreshAnalysisHistogram().catch(() => {});
    }).catch(() => {});
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
    const shouldRun = !!findHistogramSelectionItem(active);
    if (shouldRun && marqueeTimer == null) {
      marqueeTimer = window.setInterval(() => {
        const ds = getActive();
        if (!findHistogramSelectionItem(ds)) {
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
    readSpectrumAtPixel: (ds, ix, iy) => readSpectrumAtPixelCore(ds, ix, iy, IO_CONCURRENCY),
    wavelengthArrayOrNull: (ds) => wavelengthArrayOrNullCore(ds),
  });

  async function openSpectrumAt(ds, ix, iy, opts){ await spectrum.openSpectrumAt(ds, ix, iy, opts); }
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
    openSpectrumAt,
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
    resolveExportRect: (ds, scope) => exportService.resolveExportRect(ds, scope),
    alertFn: (msg) => alert(msg),
  });

  function sanitizeFilePart(s){ return exportService.sanitizeFilePart(s); }

  function openExportDialog(){ exportDialog.openExportDialog(); }
  function updateExportDialogUI(){ exportDialog.updateExportDialogUI(); }
  function updateExportEstimate(){ exportDialog.updateExportEstimate(); }

  async function runExportFromDialog(){ await exportService.runExportFromDialog(); }

  // ========= Wiring events =========

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
    getDrawColor,
    setDrawTool,
    setDrawColor,
    isDrawingPointer,
    beginDrawingAtPointer,
    updateDrawingAtPointer,
    finishDrawingAtPointer,
    cancelDrawing,
    eraseDrawingAtPointer,
    updateRulerHoverAtPointer,
    clearRulerHover,
    toggleAnalysisHistogramPanel,
    closeAnalysisHistogramPanel,
    refreshAnalysisHistogram,
    positionAnalysisHistogramPanel,
    onAnalysisHistogramPointerMove,
    onAnalysisHistogramPointerLeave,
    updateZoomLabelBoot: updateZoomLabel,
    setGpuBadgeAvailable: () => {}
  });
})();











