import { createExportDialogController, createExportService } from "../export/export-controller.js";
import { createDatasetRuntime } from "./dataset-runtime.js";
import { createCacheRuntime } from "./cache-runtime.js";
import { collectElements } from "./elements.js";
import { createUIPanels } from "./ui-panels.js";
import { createViewControls } from "./view-controls.js";
import { wireApp } from "./wiring.js";
import {
  computeDisplayPanelLayout,
  createDisplayPanels,
  ensureDisplayPanels,
  DISPLAY_COMPOSITION_OVERLAY,
  DISPLAY_COMPOSITION_SPLIT,
  getActiveDisplayPanel,
  getLinkedDisplayPanels,
  resolveDisplayPanelBand,
  getDisplayPanel,
  getDisplayPanelRect,
  getVisibleDisplayPanels,
  resolveDisplayLinkColorName,
  resolveDisplayPanelAtPoint
} from "./display-panels.js";
import { addDatasetFromFiles as addDatasetFromFilesMod, addDatasetsFromFileList as addDatasetsFromFileListMod } from "../io/dataset-loader.js";
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
import { clamp, fmt, fmtNoGroup, humanBytes } from "../core/utils.js";
import { createInteractionController } from "../ui/events.js";
import { APP_CONFIG } from "./config.js";
import { createAnalysisHistogramController } from "./analysis-histogram-controller.js";
import { createAnnotationController } from "./annotation-controller.js";
import { createSpectrumAreaController } from "./spectrum-area-controller.js";
import { createAreaReductionWorkerClient } from "./area-reduction-worker-client.js";
import { createSelectionSyncController } from "./selection-sync-controller.js";
import { getThreeBandAdjustColor, isThreeBandColorMode } from "./three-band-display.js";
import { annotationsShareImageSpace, remapAnnotationState } from "./linked-annotations.js";
import { applyNormalizedViewBox, captureNormalizedViewBox, withNormalizedCenter } from "./linked-view.js";
import {
  resolveSelectionBoundsForSpectrum,
  resolveSelectionBoundsList as resolveSelectionBoundsListCore,
  resolveSelectionBoundsUnion
} from "./selection-bounds.js";
import { pointInPolygon } from "./draw-geometry.js";

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
  const IO_CONCURRENCY_MAX = clamp(
    Math.floor(
      (((navigator && navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : 4) / APP_CONFIG.io.hardwareParallelDivisor)
      + APP_CONFIG.io.hardwareParallelBias
    ),
    APP_CONFIG.io.hardwareParallelMin,
    APP_CONFIG.io.maxConcurrency
  );
  let IO_CONCURRENCY = APP_CONFIG.io.parallelEnabledByDefault ? IO_CONCURRENCY_MAX : APP_CONFIG.io.minConcurrency;
  // ========= Elements =========

  const els = collectElements();
  function resetFilePicker() {
    if (!els.filePicker) return;
    try { els.filePicker.value = ""; } catch (_err) {}
  }
  resetFilePicker();

  const thumbCtx = els.thumb.getContext('2d', {alpha:false});
  const overlayCtx = els.overlayCanvas.getContext('2d', {alpha:true});
  const cpuCtx = els.cpuCanvas.getContext('2d', {alpha:false});
  const specCtx = els.specCanvas.getContext('2d', {alpha:false});

  let lastStatusKey = "";
  function setStatus(text, cls){
    const statusText = text || "";
    const statusClass = cls || "";
    const key = `${statusClass}::${statusText}`;
    if (key === lastStatusKey) return;
    lastStatusKey = key;
    const suffix = statusClass ? `/${statusClass}` : "";
    console.info(`[state${suffix}] ${statusText || "idle"}`);
  }

  async function readBandWindow(meta, ds, band, x0, y0, outW, outH, step, out = null){ return readBandWindowCore(meta, ds, band, x0, y0, outW, outH, step, IO_CONCURRENCY, out); }
  async function readBandWindowBIP(meta, ds, band, x0, y0, outW, outH, step, out = null){ return readBandWindowBIPCore(meta, ds, band, x0, y0, outW, outH, step, IO_CONCURRENCY, out); }
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
    displayPanels: createDisplayPanels(),
    activePanelSlot: 1,
    displayCompositionMode: DISPLAY_COMPOSITION_SPLIT,
    displaySplitSnapshot: null,
    nextLinkGroupId: 1,
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
    draw: { tool: "none", color: "#ff2d2d", shapeMode: "rect", activePointerId: null, draft: null, rulerDrag: null, rulerMove: null, rulerProfileDrag: null, rulerProfileHover: null, rulerHover: null, areaMove: null, nextItemId: 1 },

    exportKind: null,
  };

  ensureDisplayPanels(state);

  function getDatasetById(id) {
    const key = String(id || "");
    if (!key) return null;
    return state.datasets.find((dataset) => String(dataset?.id || "") === key) || null;
  }

  function getPanelDataset(panel) {
    return getDatasetById(panel?.datasetId || null);
  }

  function getActivePanel() {
    return getActiveDisplayPanel(state);
  }

  function getVisibleDatasetPanels() {
    return getVisibleDisplayPanels(state)
      .map((panel) => ({ panel, dataset: getPanelDataset(panel) }))
      .filter((entry) => !!entry.dataset);
  }

  function syncActiveDatasetView() {
    const panel = getActiveDisplayPanel(state);
    if (!panel?.datasetId) {
      state.activeId = null;
      return;
    }
    state.activePanelSlot = Number(panel.slot) || 1;
    state.activeId = panel.datasetId;
    const ds = getPanelDataset(panel);
    if (ds) {
      panel.activeBand = resolveDisplayPanelBand(panel, ds);
      ds.view = panel.view;
      ds.activeBand = panel.activeBand;
      ds.drawings = Array.isArray(panel.annotations?.drawings) ? panel.annotations.drawings : [];
      ds.selectedAreaId = Number.isFinite(Number(panel.annotations?.selectedAreaId)) ? Number(panel.annotations.selectedAreaId) : null;
      if (ds.lastRastersByPanel && typeof ds.lastRastersByPanel.get === "function") {
        ds.lastRaster = ds.lastRastersByPanel.get(Number(panel.slot)) || null;
      }
      if (ds.lastCompositeRastersByPanel && typeof ds.lastCompositeRastersByPanel.get === "function") {
        ds.lastCompositeRaster = ds.lastCompositeRastersByPanel.get(Number(panel.slot)) || null;
      }
    }
  }

  function getMainRect() {
    if (!els.main || typeof els.main.getBoundingClientRect !== "function") {
      return { width: 1, height: 1, left: 0, top: 0 };
    }
    const rect = els.main.getBoundingClientRect();
    return {
      width: Math.max(1, Number(rect.width) || 1),
      height: Math.max(1, Number(rect.height) || 1),
      left: Number(rect.left) || 0,
      top: Number(rect.top) || 0
    };
  }

  function getDisplayPanelLayoutCss() {
    const rect = getMainRect();
    return computeDisplayPanelLayout(getVisibleDisplayPanels(state), rect.width, rect.height, {
      composition: state.displayCompositionMode
    });
  }

  function getDisplayPanelLayoutDevice() {
    return computeDisplayPanelLayout(getVisibleDisplayPanels(state), els.cpuCanvas.width || 1, els.cpuCanvas.height || 1, {
      composition: state.displayCompositionMode
    });
  }

  function getPanelRectCss(slot = null) {
    const panel = slot == null ? getActiveDisplayPanel(state) : getDisplayPanel(state, slot);
    if (!panel?.datasetId) return null;
    return getDisplayPanelRect(getDisplayPanelLayoutCss(), panel.slot);
  }

  function getPanelRectDevice(slot = null) {
    const panel = slot == null ? getActiveDisplayPanel(state) : getDisplayPanel(state, slot);
    if (!panel?.datasetId) return null;
    return getDisplayPanelRect(getDisplayPanelLayoutDevice(), panel.slot);
  }

  function withPanelDatasetView(panel, ds, fn) {
    if (!panel || !ds || typeof fn !== "function") return undefined;
    const prevView = ds.view;
    ds.view = panel.view || prevView;
    try {
      return fn();
    } finally {
      ds.view = prevView;
    }
  }

  function captureDisplayViewState() {
    const layout = getDisplayPanelLayoutCss();
    const snapshot = new Map();
    for (const entry of getVisibleDatasetPanels()) {
      const { panel, dataset: ds } = entry;
      if (!panel?.view || !ds?.meta) continue;
      const viewport = getDisplayPanelRect(layout, panel.slot);
      if (!viewport) continue;
      snapshot.set(Number(panel.slot) || 1, {
        datasetId: ds.id,
        x: Number(panel.view.x) || 0,
        y: Number(panel.view.y) || 0,
        scale: Number(panel.view.scale) || 1,
        viewportW: Math.max(1, Number(viewport.w) || 1),
        viewportH: Math.max(1, Number(viewport.h) || 1)
      });
    }
    return snapshot;
  }

  function reflowDisplayViews(snapshot) {
    if (!(snapshot instanceof Map) || !snapshot.size) return;
    const layout = getDisplayPanelLayoutCss();
    for (const entry of getVisibleDatasetPanels()) {
      const { panel, dataset: ds } = entry;
      if (!panel?.view || !ds?.meta) continue;
      const prev = snapshot.get(Number(panel.slot) || 1);
      if (!prev) continue;
      const viewport = getDisplayPanelRect(layout, panel.slot);
      if (!viewport) continue;
      const oldFit = Math.min(prev.viewportW / ds.meta.samples, prev.viewportH / ds.meta.lines);
      const newFit = Math.min(Math.max(1, Number(viewport.w) || 1) / ds.meta.samples, Math.max(1, Number(viewport.h) || 1) / ds.meta.lines);
      if (!Number.isFinite(oldFit) || !Number.isFinite(newFit) || oldFit <= 0 || newFit <= 0) continue;

      const prevScale = Number.isFinite(prev.scale) && prev.scale > 0 ? prev.scale : oldFit;
      const nextScale = Math.max(1e-9, prevScale * (newFit / oldFit));
      const oldViewW = prev.viewportW / prevScale;
      const oldViewH = prev.viewportH / prevScale;
      const centerX = prev.x + (oldViewW * 0.5);
      const centerY = prev.y + (oldViewH * 0.5);
      const newViewW = Math.max(1, Number(viewport.w) || 1) / nextScale;
      const newViewH = Math.max(1, Number(viewport.h) || 1) / nextScale;

      panel.view.scale = nextScale;
      panel.view.x = centerX - (newViewW * 0.5);
      panel.view.y = centerY - (newViewH * 0.5);
      withPanelDatasetView(panel, ds, () => {
        clampView(panel.slot, ds);
      });
    }
  }

  function getActiveViewportCss() {
    const rect = getPanelRectCss();
    if (rect) return { width: rect.w, height: rect.h };
    const mainRect = getMainRect();
    return { width: mainRect.width, height: mainRect.height };
  }

  function getActiveViewportDevice() {
    const rect = getPanelRectDevice();
    if (rect) return { width: rect.w, height: rect.h };
    return { width: Math.max(1, els.cpuCanvas.width || 1), height: Math.max(1, els.cpuCanvas.height || 1) };
  }

  function resolvePanelAtClientPoint(clientX, clientY) {
    if (state.displayCompositionMode === DISPLAY_COMPOSITION_OVERLAY && getVisibleDatasetPanels().length > 1) {
      const activePanel = getActiveDisplayPanel(state);
      if (activePanel?.datasetId) {
        return getDisplayPanelRect(getDisplayPanelLayoutCss(), activePanel.slot);
      }
    }
    const rect = getMainRect();
    const localX = Number(clientX) - rect.left;
    const localY = Number(clientY) - rect.top;
    return resolveDisplayPanelAtPoint(getDisplayPanelLayoutCss(), localX, localY);
  }

  function activatePanelAtClientPoint(clientX, clientY, opts = {}) {
    const panelRect = resolvePanelAtClientPoint(clientX, clientY);
    if (!panelRect) return false;
    return setActivePanel(panelRect.slot, opts);
  }

  
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
    getActivePanel,
    getPanelRectCss,
    getPanelRectDevice,
    onRender: () => render(),
  });
  function computeFitScale(ds, slot = null){ return viewControls.computeFitScale(ds, slot); }
  function minScaleFor(ds, slot = null){ return viewControls.minScaleFor(ds, slot); }
  function updateZoomRange(ds){ viewControls.updateZoomRange(ds); }
  function sliderToScale(v){ return viewControls.sliderToScale(v); }
  function scaleToSlider(s){ return viewControls.scaleToSlider(s); }
  function updateZoomLabel(){ viewControls.updateZoomLabel(); }

  // ========= Dataset helpers =========

  let datasetRuntime = null;
  function getActive(){ return datasetRuntime ? datasetRuntime.getActive() : null; }
  function setActivePanel(slot, opts){ return datasetRuntime ? datasetRuntime.setActivePanel(slot, opts) : false; }
  function cycleDatasetPanel(id, slot, opts){ return datasetRuntime ? datasetRuntime.cycleDatasetPanel(id, slot, opts) : false; }
  function setActiveDataset(id, opts){ if (datasetRuntime) datasetRuntime.setActiveDataset(id, opts); }
  function bandLabel(ds, b){ return datasetRuntime ? datasetRuntime.bandLabel(ds, b) : `Band ${b}`; }
  async function addDatasetsFromFileList(files){ if (datasetRuntime) await datasetRuntime.addDatasetsFromFileList(files); }
  async function addDatasetFromFiles(hdrFile, dataFile){ if (datasetRuntime) await datasetRuntime.addDatasetFromFiles(hdrFile, dataFile); }
  function closeAllDatasets(){ if (datasetRuntime) datasetRuntime.closeAllDatasets(); }
  function closeDataset(id){
    if (spectrum && spectrum.isOpenForDatasetId(id)) closeSpectrum();
    if (datasetRuntime) datasetRuntime.closeDataset(id);
  }

  const annotation = createAnnotationController({
    state,
    els,
    clamp,
    getActive,
    getActivePanel,
    screenToImage,
    render,
    getSpectrumOpenForDatasetId: (dsId) => !!(spectrum && spectrum.isOpenForDatasetId(dsId)),
    openSpectrumAt: (ds, ix, iy, opts) => openSpectrumAt(ds, ix, iy, opts),
    positionAnalysisHistogramPanel,
    updateSelectionHistogramForDataset,
    ensureMarqueeTicker,
    refreshAnalysisHistogram,
    isAnalysisHistogramOpen: () => !!state.analysisHist.open,
    isDatasetActive: (ds) => !!(ds && ds.id === state.activeId)
  });

  function getDrawTool() { return annotation.getDrawTool(); }
  function getDrawShapeMode() { return annotation.getDrawShapeMode(); }
  function getSpectrumPickEnabled() { return annotation.getSpectrumPickEnabled(); }
  function setSpectrumPickEnabled(next = null) { return annotation.setSpectrumPickEnabled(next); }
  function getDrawColor() { return annotation.getDrawColor(); }
  function setDrawTool(tool) { annotation.setDrawTool(tool); }
  function setDrawShapeMode(mode) { return annotation.setDrawShapeMode(mode); }
  function setDrawColor(color) { annotation.setDrawColor(color); }
  function getAreaSelectionMode() { return annotation.getAreaSelectionMode(); }
  function isHistogramSelectionTool(item) { return annotation.isHistogramSelectionTool(item); }
  function listHistogramSelectionItems(ds) { return annotation.listHistogramSelectionItems(ds); }
  function setAreaSelectionMode(next = null) { return annotation.setAreaSelectionMode(next); }
  function getHistogramSelectionItems(ds) { return annotation.getHistogramSelectionItems(ds); }
  function getEffectiveAreaSelectionCount(ds = null) { return annotation.getEffectiveAreaSelectionCount(ds); }
  function histogramSelectionKeyFromItems(items) { return annotation.histogramSelectionKeyFromItems(items); }
  function getEffectiveAreaSelectionKey(ds = null) { return annotation.getEffectiveAreaSelectionKey(ds); }
  function refreshAreaSpectrumIfOpen(ds, anchor = null, noReposition = false) { annotation.refreshAreaSpectrumIfOpen(ds, anchor, noReposition); }
  function selectAreaAtPointer(ev) { return annotation.selectAreaAtPointer(ev); }
  function isAreaMovePointer(pointerId) { return annotation.isAreaMovePointer(pointerId); }
  function beginAreaMoveAtPointer(ev) { return annotation.beginAreaMoveAtPointer(ev); }
  function updateAreaMoveAtPointer(ev) { return annotation.updateAreaMoveAtPointer(ev); }
  function finishAreaMoveAtPointer(ev) { return annotation.finishAreaMoveAtPointer(ev); }
  function cancelAreaMove(pointerId = null) { return annotation.cancelAreaMove(pointerId); }
  function resolvePointerCursor(ev) { return annotation.resolvePointerCursor(ev); }

  function resolveEffectiveSelectionBounds(ds, selections = null) {
    if (!ds) return null;
    const list = Array.isArray(selections) ? selections : getHistogramSelectionItems(ds);
    return resolveSelectionBoundsUnion(ds, list);
  }

  function resolveSelectionBoundsList(ds, selections = null) {
    if (!ds) return [];
    const list = Array.isArray(selections) ? selections : getHistogramSelectionItems(ds);
    return resolveSelectionBoundsListCore(ds, list);
  }

  function getDrawData(ds, annotations = null) { return annotation.getDrawData(ds, annotations); }
  function updateRulerHoverAtPointer(ev) { return annotation.updateRulerHoverAtPointer(ev); }
  function clearRulerHover() { return annotation.clearRulerHover(); }
  function eraseDrawingAtPointer(ev) { return annotation.eraseDrawingAtPointer(ev); }
  function clearAllAnnotations() { return annotation.clearAllAnnotations(); }
  function isDrawingPointer(pointerId) { return annotation.isDrawingPointer(pointerId); }
  function beginDrawingAtPointer(ev) { return annotation.beginDrawingAtPointer(ev); }
  function updateDrawingAtPointer(ev) { return annotation.updateDrawingAtPointer(ev); }
  function finishDrawingAtPointer(ev) { return annotation.finishDrawingAtPointer(ev); }
  function cancelDrawing() { return annotation.cancelDrawing(); }

  // ========= UI rebuild =========

  const uiPanels = createUIPanels({
    state,
    els,
    getActive,
    getActivePanel,
    clamp,
    fmt,
    fmtNoGroup,
    humanBytes,
    bandLabel,
    setActiveDataset,
    cycleDatasetPanel,
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
  function resolveDisplayControlBand(ds){ return uiPanels.resolveDisplayControlBand(ds); }
  function resolveStats(ds){ return uiPanels.resolveStats(ds); }
  function setActiveBand(ds, band){ uiPanels.setActiveBand(ds, band); }
  function updateDisplayUI(force=false){ uiPanels.updateDisplayUI(force); }
  function syncRangeInputsFromSettings(ds, opts){ uiPanels.syncRangeInputsFromSettings(ds, opts); }
  function applyRangeFromNumbers(ds){ uiPanels.applyRangeFromNumbers(ds); }
  function resetDisplay(ds){ uiPanels.resetDisplay(ds); }
  function autoDisplay(ds){ uiPanels.autoDisplay(ds); }
  function cycleDisplayAdjustColor(ds){ uiPanels.cycleDisplayAdjustColor(ds); }

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
    syncActiveDatasetView,
    captureDisplayViewState,
    reflowDisplayViews,
    syncLinkedPanelView,
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
    getDisplayBand: resolveDisplayControlBand,
    getDisplayColor: (ds) => (isThreeBandColorMode(ds) ? getThreeBandAdjustColor(ds) : null),
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

  const analysisHistogram = createAnalysisHistogramController({
    state,
    els,
    clamp,
    fmtNoGroup,
    formatNumber,
    getActive,
    getHistogramSelectionItems,
    histogramSelectionKeyFromItems,
    updateSelectionHistogram,
    buildBandStatsWhole,
    computeHistogram,
    resolveEffectiveSelectionBounds,
    resolveSelectionBoundsList,
    listHistogramSelectionItems,
    setStatus
  });

  function positionAnalysisHistogramPanel() {
    analysisHistogram.positionPanel();
  }
  async function refreshAnalysisHistogram() {
    await analysisHistogram.refresh();
  }
  function openAnalysisHistogramPanel() {
    analysisHistogram.openPanel();
  }
  function closeAnalysisHistogramPanel() {
    analysisHistogram.closePanel();
  }
  function toggleAnalysisHistogramPanel() { analysisHistogram.togglePanel(); }
  function getAnalysisHistogramOpen() { return analysisHistogram.getOpen(); }
  function setAnalysisHistogramOpen(nextOpen) { analysisHistogram.setOpen(nextOpen); }
  function onAnalysisHistogramPointerMove(ev) { analysisHistogram.onPointerMove(ev); }
  function onAnalysisHistogramPointerLeave() { analysisHistogram.onPointerLeave(); }

  let selectionSync = null;
  function updateSelectionHistogramForDataset(ds) {
    if (!selectionSync) return;
    selectionSync.updateSelectionHistogramForDataset(ds);
  }
  // ========= Rendering (direct read or pyramid) =========

  function clampView(slot = null, ds = null){ viewControls.clampView(slot, ds); }
  function screenToImage(sx, sy, slot = null, ds = null){ return viewControls.screenToImage(sx, sy, slot, ds); }

  function listLinkedViewEntries(slot = null) {
    const basePanel = slot == null ? getActiveDisplayPanel(state) : getDisplayPanel(state, slot);
    if (!basePanel?.datasetId) return [];
    return getLinkedDisplayPanels(state, basePanel.slot)
      .map((panel) => ({ panel, dataset: getPanelDataset(panel) }))
      .filter((entry) => !!entry.dataset);
  }

  function fallbackPanelViewport(slot) {
    return getPanelRectDevice(slot) || {
      w: Math.max(1, Number(els.cpuCanvas.width) || 1),
      h: Math.max(1, Number(els.cpuCanvas.height) || 1)
    };
  }

  function syncLinkedPanelView(sourcePanel, targetPanel) {
    if (!sourcePanel?.datasetId || !targetPanel?.datasetId) return false;
    if (Number(sourcePanel.slot) === Number(targetPanel.slot)) return false;
    const sourceDs = getPanelDataset(sourcePanel);
    const targetDs = getPanelDataset(targetPanel);
    if (!sourceDs?.meta || !targetDs?.meta) return false;
    const dpr = window.devicePixelRatio || 1;
    const sourceViewport = fallbackPanelViewport(sourcePanel.slot);
    const targetViewport = fallbackPanelViewport(targetPanel.slot);
    const normalized = captureNormalizedViewBox(sourcePanel.view, sourceDs.meta, sourceViewport, dpr);
    const next = applyNormalizedViewBox(normalized, targetDs.meta, targetViewport, dpr, {
      minScale: minScaleFor(targetDs, targetPanel.slot),
      maxScale: 128
    });
    targetPanel.view.scale = next.scale;
    targetPanel.view.x = next.x;
    targetPanel.view.y = next.y;
    withPanelDatasetView(targetPanel, targetDs, () => {
      clampView(targetPanel.slot, targetDs);
    });
    return true;
  }

  function syncLinkedPanelAnnotations(sourcePanel, targetPanel) {
    if (!sourcePanel?.datasetId || !targetPanel?.datasetId) return false;
    if (Number(sourcePanel.slot) === Number(targetPanel.slot)) return false;
    const sourceDs = getPanelDataset(sourcePanel);
    const targetDs = getPanelDataset(targetPanel);
    if (!sourceDs?.meta || !targetDs?.meta) return false;
    if (annotationsShareImageSpace(sourceDs.meta, targetDs.meta)) {
      targetPanel.annotations = sourcePanel.annotations;
      return true;
    }
    targetPanel.annotations = remapAnnotationState(sourcePanel.annotations, sourceDs.meta, targetDs.meta);
    return true;
  }

  function syncLinkedAnnotationsFromActivePanel() {
    const sourcePanel = getActiveDisplayPanel(state);
    if (!sourcePanel?.datasetId) return;
    const entries = listLinkedViewEntries(sourcePanel.slot);
    if (entries.length < 2) return;
    for (const entry of entries) {
      if (Number(entry.panel?.slot) === Number(sourcePanel.slot)) continue;
      syncLinkedPanelAnnotations(sourcePanel, entry.panel);
    }
  }

  function syncLinkedPanelsFromSource(entries, sourceEntry) {
    if (!sourceEntry?.panel || !sourceEntry?.dataset) return;
    for (const entry of entries) {
      if (Number(entry.panel?.slot) === Number(sourceEntry.panel.slot)) continue;
      syncLinkedPanelView(sourceEntry.panel, entry.panel);
    }
  }

  function panLinkedPanelsByPixels(dx, dy, slot = null) {
    const entries = listLinkedViewEntries(slot);
    if (!entries.length) return false;
    const sourceSlot = slot == null ? Number(getActiveDisplayPanel(state)?.slot) || 1 : Number(slot);
    const sourceEntry = entries.find((entry) => Number(entry.panel?.slot) === sourceSlot) || entries[0];
    if (!sourceEntry) return false;
    withPanelDatasetView(sourceEntry.panel, sourceEntry.dataset, () => {
      const scale = Math.max(1e-9, Number(sourceEntry.panel.view?.scale) || 1);
      sourceEntry.panel.view.x -= (Number(dx) || 0) / scale;
      sourceEntry.panel.view.y -= (Number(dy) || 0) / scale;
      clampView(sourceEntry.panel.slot, sourceEntry.dataset);
    });
    syncLinkedPanelsFromSource(entries, sourceEntry);
    return true;
  }

  function scaleLinkedPanelsAt(targetScale, sx, sy, slot = null) {
    const sourcePanel = slot == null ? getActiveDisplayPanel(state) : getDisplayPanel(state, slot);
    const entries = sourcePanel?.datasetId ? listLinkedViewEntries(sourcePanel.slot) : [];
    if (!sourcePanel?.datasetId || !entries.length) return null;
    const sourceEntry = entries.find((entry) => Number(entry.panel?.slot) === Number(sourcePanel.slot)) || entries[0];
    if (!sourceEntry) return null;
    let activeScale = null;
    withPanelDatasetView(sourceEntry.panel, sourceEntry.dataset, () => {
      const before = screenToImage(sx, sy, sourceEntry.panel.slot, sourceEntry.dataset);
      const minS = minScaleFor(sourceEntry.dataset, sourceEntry.panel.slot);
      sourceEntry.panel.view.scale = clamp(targetScale, minS, 128);
      const after = screenToImage(sx, sy, sourceEntry.panel.slot, sourceEntry.dataset);
      sourceEntry.panel.view.x += before.x - after.x;
      sourceEntry.panel.view.y += before.y - after.y;
      clampView(sourceEntry.panel.slot, sourceEntry.dataset);
      activeScale = sourceEntry.panel.view.scale;
    });
    syncLinkedPanelsFromSource(entries, sourceEntry);
    return activeScale;
  }

  function recenterLinkedPanelsAtFraction(nx, ny, slot = null) {
    const entries = listLinkedViewEntries(slot);
    if (!entries.length) return false;
    const sourceSlot = slot == null ? Number(getActiveDisplayPanel(state)?.slot) || 1 : Number(slot);
    const sourceEntry = entries.find((entry) => Number(entry.panel?.slot) === sourceSlot) || entries[0];
    if (!sourceEntry) return false;
    const dpr = window.devicePixelRatio || 1;
    const sourceViewport = fallbackPanelViewport(sourceEntry.panel.slot);
    const current = captureNormalizedViewBox(sourceEntry.panel.view, sourceEntry.dataset.meta, sourceViewport, dpr);
    const desired = withNormalizedCenter(current, clamp(Number(nx) || 0, 0, 1), clamp(Number(ny) || 0, 0, 1));
    const next = applyNormalizedViewBox(desired, sourceEntry.dataset.meta, sourceViewport, dpr, {
      minScale: minScaleFor(sourceEntry.dataset, sourceEntry.panel.slot),
      maxScale: 128
    });
    sourceEntry.panel.view.scale = next.scale;
    sourceEntry.panel.view.x = next.x;
    sourceEntry.panel.view.y = next.y;
    withPanelDatasetView(sourceEntry.panel, sourceEntry.dataset, () => {
      clampView(sourceEntry.panel.slot, sourceEntry.dataset);
    });
    syncLinkedPanelsFromSource(entries, sourceEntry);
    return true;
  }

  function fitToScreen(ds = null, slot = null) {
    const targetPanel = slot == null ? getActiveDisplayPanel(state) : getDisplayPanel(state, slot);
    if (!targetPanel?.datasetId) {
      viewControls.fitToScreen(ds, slot);
      return;
    }
    const entries = listLinkedViewEntries(targetPanel.slot);
    if (!entries.length) {
      viewControls.fitToScreen(ds, slot);
      return;
    }
    const activeEntry = entries.find((entry) => Number(entry.panel.slot) === Number(targetPanel.slot)) || entries[0];
    updateZoomRange(activeEntry.dataset);
    for (const entry of entries) {
      const { panel, dataset: panelDs } = entry;
      panel.view.scale = computeFitScale(panelDs, panel.slot);
      panel.view.x = 0;
      panel.view.y = 0;
      withPanelDatasetView(panel, panelDs, () => {
        clampView(panel.slot, panelDs);
      });
    }
    els.zoom.value = String(scaleToSlider(activeEntry.panel.view.scale));
    updateZoomLabel();
    render();
  }

  function resolveDisplayRange(ds, band, fallbackArray){ return resolveDisplayRangeCore(ds, band, fallbackArray, getBandSettings); }

  async function tryRasterFromPyramid(ds, band, eff, viewportW = null, viewportH = null){
    ds.__pyrPreferImmediate = !!state.mouse.dragging;
    return pyramid.tryRasterFromPyramid(ds, band, eff, viewportW, viewportH);
  }

  function buildGrayCanvas(rasterF32, w, h, params){
    const img = cpuCtx.createImageData(w, h);
    const dst = img.data;
    const minVal = params.minVal, maxVal = params.maxVal;
    const brightness = params.brightness, gain = params.gain, contrast = params.contrast;

    for (let i=0, j=0; i<rasterF32.length; i++, j+=4){
      const t = tone01(rasterF32[i], minVal, maxVal, brightness, gain, contrast);
      const u = Math.round(t * 255);
      dst[j] = u; dst[j+1] = u; dst[j+2] = u; dst[j+3] = 255;
    }

    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    off.getContext('2d', {alpha:false}).putImageData(img,0,0);
    return off;
  }

  function drawCanvasToViewport(ctx, sourceCanvas, viewport, clear = false){
    if (!ctx || !sourceCanvas || !viewport) return;
    const x = Number(viewport.x) || 0;
    const y = Number(viewport.y) || 0;
    const w = Math.max(1, Number(viewport.w) || 1);
    const h = Math.max(1, Number(viewport.h) || 1);
    ctx.save();
    ctx.setTransform(1,0,0,1,0,0);
    ctx.imageSmoothingEnabled = false;
    if (clear) ctx.clearRect(x, y, w, h);
    ctx.drawImage(sourceCanvas, 0, 0, sourceCanvas.width, sourceCanvas.height, x, y, w, h);
    ctx.restore();
  }

  function cpuRenderGray(rasterF32, w, h, params){
    const off = buildGrayCanvas(rasterF32, w, h, params);
    cpuCtx.save();
    cpuCtx.setTransform(1,0,0,1,0,0);
    cpuCtx.imageSmoothingEnabled = false;
    cpuCtx.clearRect(0,0,els.cpuCanvas.width, els.cpuCanvas.height);
    cpuCtx.drawImage(off, 0,0,w,h, 0,0, els.cpuCanvas.width, els.cpuCanvas.height);
    cpuCtx.restore();
    return off;
  }

  function buildColorCanvas(rasters, paramsByChannel){
    if (!Array.isArray(rasters) || rasters.length < 3) return;
    const [rRaster, gRaster, bRaster] = rasters;
    if (!rRaster || !gRaster || !bRaster) return;
    const w = rRaster.w;
    const h = rRaster.h;
    const img = cpuCtx.createImageData(w, h);
    const dst = img.data;
    const rData = rRaster.dataF32;
    const gData = gRaster.dataF32;
    const bData = bRaster.dataF32;
    const rParams = paramsByChannel[0];
    const gParams = paramsByChannel[1];
    const bParams = paramsByChannel[2];

    for (let i = 0, j = 0; i < rData.length; i += 1, j += 4) {
      const r = Math.round(tone01(rData[i], rParams.minVal, rParams.maxVal, rParams.brightness, rParams.gain, rParams.contrast) * 255);
      const g = Math.round(tone01(gData[i], gParams.minVal, gParams.maxVal, gParams.brightness, gParams.gain, gParams.contrast) * 255);
      const b = Math.round(tone01(bData[i], bParams.minVal, bParams.maxVal, bParams.brightness, bParams.gain, bParams.contrast) * 255);
      dst[j] = r;
      dst[j + 1] = g;
      dst[j + 2] = b;
      dst[j + 3] = 255;
    }

    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    off.getContext("2d", { alpha: false }).putImageData(img, 0, 0);
    return off;
  }

  function cpuRenderColor(rasters, paramsByChannel){
    const off = buildColorCanvas(rasters, paramsByChannel);
    if (!off) return null;
    cpuCtx.save();
    cpuCtx.setTransform(1, 0, 0, 1, 0, 0);
    cpuCtx.imageSmoothingEnabled = false;
    cpuCtx.clearRect(0, 0, els.cpuCanvas.width, els.cpuCanvas.height);
    cpuCtx.drawImage(off, 0, 0, off.width, off.height, 0, 0, els.cpuCanvas.width, els.cpuCanvas.height);
    cpuCtx.restore();
    return off;
  }

  const overlayRenderer = createOverlayRenderer({
    els,
    overlayCtx,
    getDevicePixelRatio: () => window.devicePixelRatio || 1,
    getDrawData,
  });

  function drawOverlays(){
    overlayRenderer.clearOverlay();
    const layout = getDisplayPanelLayoutDevice();
    const activeSlot = Number(getActivePanel()?.slot) || 1;
    const visibleEntries = getVisibleDatasetPanels();
    const overlayMode = state.displayCompositionMode === DISPLAY_COMPOSITION_OVERLAY && visibleEntries.length > 1;
    for (let index = 0; index < visibleEntries.length; index += 1) {
      const entry = visibleEntries[index];
      const { panel, dataset: ds } = entry;
      const viewport = layout.find((rect) => Number(rect.slot) === Number(panel.slot));
      if (!viewport || !ds) continue;
      const prevView = ds.view;
      ds.view = panel.view || prevView;
      try {
        overlayRenderer.drawOverlaysForPanel(ds, viewport, {
          annotations: panel.annotations || null,
          activeBand: resolveDisplayPanelBand(panel, ds),
          raster: ds.lastRastersByPanel && typeof ds.lastRastersByPanel.get === "function"
            ? (ds.lastRastersByPanel.get(Number(panel.slot)) || null)
            : null,
          active: Number(panel.slot) === activeSlot,
          showScaleBar: Number(panel.slot) === activeSlot,
          borderColor: overlayMode
            ? (Number(panel.slot) === 1 ? "rgba(103,232,249,0.92)" : "rgba(251,146,60,0.92)")
            : (({
              amber: "rgba(253,224,71,0.9)",
              cyan: "rgba(103,232,249,0.9)",
              emerald: "rgba(134,239,172,0.9)",
              violet: "rgba(221,214,254,0.9)"
            })[resolveDisplayLinkColorName(state, panel.slot)] || "rgba(226,232,240,0.55)"),
          label: Number(panel.slot) === 2 ? "R" : "L",
          labelIndex: overlayMode ? index : 0,
          composition: overlayMode ? DISPLAY_COMPOSITION_OVERLAY : DISPLAY_COMPOSITION_SPLIT
        });
      } finally {
        ds.view = prevView;
      }
    }
  }

  selectionSync = createSelectionSyncController({
    state,
    getActive,
    getHistogramSelectionItems,
    clearSelectionHistogram,
    refreshAnalysisHistogram,
    updateSelectionHistogram,
    getSpectrumOpenForDatasetId: (dsId) => !!(spectrum && spectrum.isOpenForDatasetId(dsId)),
    openSpectrumForEffectiveArea,
    refreshAreaSpectrumIfOpen,
    drawOverlays
  });

  function ensureMarqueeTicker() {
    if (!selectionSync) return;
    selectionSync.ensureMarqueeTicker();
  }

  let renderer = null;
  function resizeCanvases(){ if (renderer) renderer.resizeCanvases(); }
  function schedulePreviewRender(){ if (renderer) renderer.schedulePreview(); }
  function scheduleRender(){ if (renderer) renderer.scheduleRender(); }
  async function render(opts = {}){
    syncLinkedAnnotationsFromActivePanel();
    if (renderer) await renderer.render(opts);
  }

  renderer = createRenderer({
    state,
    els,
    now,
    setStatus,
    getActive,
    getActivePanel,
    getVisibleDatasetPanels,
    getPanelLayoutDevice: () => getDisplayPanelLayoutDevice(),
    getBandSettings,
    resolveDisplayRange,
    initWebGPU,
    gpuSupported,
    gpuRender,
    cpuRenderGray,
    cpuRenderColor,
    buildGrayCanvas,
    buildColorCanvas,
    drawCanvasToViewport,
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
    getDisplayCompositionMode: () => state.displayCompositionMode
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
    getActiveViewportCss: () => getActiveViewportCss(),
    getActiveViewportDevice: () => getActiveViewportDevice(),
    getDevicePixelRatio: () => window.devicePixelRatio || 1,
    isThreeBandColorMode,
    recenterViewAtFraction: (nx, ny) => recenterLinkedPanelsAtFraction(nx, ny)
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

  const areaReducer = createAreaReductionWorkerClient();
  function resetDatasetSession() {
    closeAllDatasets();
    resetFilePicker();
  }
  window.addEventListener("beforeunload", () => {
    resetDatasetSession();
    if (areaReducer && typeof areaReducer.dispose === "function") areaReducer.dispose();
  }, { once: true });
  window.addEventListener("pagehide", (ev) => {
    if (!ev.persisted) return;
    resetDatasetSession();
    if (areaReducer && typeof areaReducer.dispose === "function") areaReducer.dispose();
  });
  window.addEventListener("pageshow", (ev) => {
    resetFilePicker();
    const nav = (typeof performance !== "undefined" && typeof performance.getEntriesByType === "function")
      ? performance.getEntriesByType("navigation")[0]
      : null;
    const isReload = !!nav && nav.type === "reload";
    if ((ev.persisted || isReload) && state.datasets.length) {
      closeAllDatasets();
      setStatus("idle", "");
    }
  });

  const spectrumArea = createSpectrumAreaController({
    getActive,
    spectrum,
    isHistogramSelectionTool,
    getHistogramSelectionItems,
    resolveSelectionBoundsForSpectrum,
    resolveEffectiveSelectionBounds,
    resolveSelectionBoundsList,
    listHistogramSelectionItems,
    readBandWindow,
    readBandWindowBIP,
    toFloat32,
    areaReducer,
    pointInPolygon,
    wavelengthArrayOrNull: (ds) => wavelengthArrayOrNullCore(ds),
    fmtNoGroup
  });

  async function openSpectrumAt(ds, ix, iy, opts = {}) { await spectrumArea.openSpectrumAt(ds, ix, iy, opts); }
  async function openSpectrumForEffectiveArea(ds = null, anchor = null, noReposition = false) {
    return spectrumArea.openSpectrumForEffectiveArea(ds, anchor, noReposition);
  }
  function redrawSpectrum(){ spectrum.redrawSpectrum(); }
  function closeSpectrum(){ spectrum.closeSpectrum(); }
  function exportSpectrumCSV(){ spectrum.exportSpectrumCSV(); }
// ========= Mouse interaction =========

  const interactions = createInteractionController({
    els,
    state,
    getActive,
    activatePanelAtClientPoint,
    clamp,
    setStatus,
    updateHud,
    screenToImage,
    clampView,
    schedulePreviewRender,
    scheduleRender,
    render,
    minScaleFor,
    scaleToSlider,
    updateZoomLabel,
    panByPixels: (dx, dy) => panLinkedPanelsByPixels(dx, dy),
    setScaleAt: (targetScale, sx, sy) => scaleLinkedPanelsAt(targetScale, sx, sy),
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
    getEffectiveAreaSelections: (ds) => getHistogramSelectionItems(ds),
    setStatus,
    humanBytes,
    fmt,
    clamp,
    bandLabel,
    renderWindowToImageData,
    readBandWindow,
    readBandWindowBIP,
    getActiveViewportDevice: () => getActiveViewportDevice(),
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

  analysisHistogram.setOpen(!!state.analysisHist.open);

  wireApp({
    state,
    els,
    clamp,
    getActive,
    activatePanelAtClientPoint,
    getActiveViewportDevice: () => getActiveViewportDevice(),
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
    setScaleAt: (targetScale, sx, sy) => scaleLinkedPanelsAt(targetScale, sx, sy),
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
    resolveDisplayControlBand,
    cycleDisplayAdjustColor,
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
    getDrawShapeMode,
    getSpectrumPickEnabled,
    getEffectiveAreaSelectionCount,
    getEffectiveAreaSelectionKey,
    getAreaSelectionMode,
    getDrawColor,
    setDrawTool,
    setDrawShapeMode,
    setSpectrumPickEnabled,
    setAreaSelectionMode,
    setDrawColor,
    selectAreaAtPointer,
    isAreaMovePointer,
    beginAreaMoveAtPointer,
    updateAreaMoveAtPointer,
    finishAreaMoveAtPointer,
    cancelAreaMove,
    resolvePointerCursor,
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









