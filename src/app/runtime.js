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
import { clamp, fmt, fmtNoGroup, humanBytes } from "../core/utils.js";
import { createInteractionController } from "../ui/events.js";
import { APP_CONFIG } from "./config.js";
import { createAnalysisHistogramController } from "./analysis-histogram-controller.js";
import { createAnnotationController } from "./annotation-controller.js";
import { createSpectrumAreaController } from "./spectrum-area-controller.js";
import { createSelectionSyncController } from "./selection-sync-controller.js";
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

  const annotation = createAnnotationController({
    state,
    els,
    clamp,
    getActive,
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
  function getSpectrumPickEnabled() { return annotation.getSpectrumPickEnabled(); }
  function setSpectrumPickEnabled(next = null) { return annotation.setSpectrumPickEnabled(next); }
  function getDrawColor() { return annotation.getDrawColor(); }
  function setDrawTool(tool) { annotation.setDrawTool(tool); }
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

  function getDrawData(ds) { return annotation.getDrawData(ds); }
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

  analysisHistogram.setOpen(!!state.analysisHist.open);

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











