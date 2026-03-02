import { createExportDialogController, createExportService } from "../export/export-controller.js";
import { createDatasetRuntime } from "./dataset-runtime.js";
import { createCacheRuntime } from "./cache-runtime.js";
import { createUIPanels } from "./ui-panels.js";
import { createViewControls } from "./view-controls.js";
import { wireApp } from "./wiring.js";
import { addDatasetFromFiles as addDatasetFromFilesMod, addDatasetsFromFileList as addDatasetsFromFileListMod } from "../io/envi-loader.js";
import {
  makeSegmentReader as makeSegmentReaderCore,
  pixelOffset as pixelOffsetCore,
  readBandWindow as readBandWindowCore,
  readBandWindowBIP as readBandWindowBIPCore,
  segGet as segGetCore,
  toFloat32 as toFloat32Core
} from "../core/raster-io.js";
import {
  computeHistogram as computeHistogramCore,
  quickStatsFromArray as quickStatsFromArrayCore,
  resolveDisplayRange as resolveDisplayRangeCore,
  tone01 as tone01Core,
  typeDefaultRange as typeDefaultRangeCore
} from "../render/display-math.js";
import {
  createHistogramController
} from "../render/histogram.js";
import { createGpuRuntime } from "../render/gpu-runtime.js";
import { createHudController } from "../render/hud.js";
import { createOverlayRenderer } from "../render/overlay.js";
import { createPyramidController } from "../render/pyramid-cache.js";
import { createSpectrumController } from "../render/spectrum.js";
import { probeValueAtBand, readSpectrumAtPixel as readSpectrumAtPixelCore, wavelengthArrayOrNull as wavelengthArrayOrNullCore } from "../render/spectrum-data.js";
import { createThumbnailController } from "../render/thumbnail.js";
import { clamp, fmt, fmtNoGroup, humanBytes } from "../core/utils.js";
import { createInteractionController } from "../ui/events.js";

(() => {
  'use strict';

  // ========= Utilities =========

  const $ = (sel) => document.querySelector(sel);
  const now = () => performance.now();

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
  let IO_CONCURRENCY = IO_CONCURRENCY_MAX; // can be toggled to 1 (sequential)
  // ========= Elements =========

  const els = {
    btnFit: $('#btnFit'),
    btn100: $('#btn100'),
    btnZoomIn: $('#btnZoomIn'),
    btnZoomOut: $('#btnZoomOut'),
    zoom: $('#zoom'),
    zoomLabel: $('#zoomLabel'),

    chkGrid: $('#chkGrid'),
    chkThumb: $('#chkThumb'),
    chkScale: $('#chkScale'),

    btnSelect: $('#btnSelect'),
    btnExportPNG: $('#btnExportPNG'),
    btnExportTIFF: $('#btnExportTIFF'),

    gpuBadge: $('#gpuBadge'),
    statusBadge: $('#statusBadge'),

    // left
    filePicker: $('#filePicker'),
    dropzone: $('#dropzone'),
    datasetCount: $('#datasetCount'),
    datasetList: $('#datasetList'),

    metaSamples: $('#metaSamples'),
    metaLines: $('#metaLines'),
    metaBands: $('#metaBands'),
    metaInterleave: $('#metaInterleave'),
    metaType: $('#metaType'),
    metaEndian: $('#metaEndian'),
    metaWlUnits: $('#metaWlUnits'),
    metaScale: $('#metaScale'),
    metaExtra: $('#metaExtra'),

    perfBytes: $('#perfBytes'),
    perfCache: $('#perfCache'),
    perfPyramid: $('#perfPyramid'),
    perfBarCacheText: $('#perfBarCacheText'),
    perfBarCacheFill: $('#perfBarCacheFill'),
    perfBarReadText: $('#perfBarReadText'),
    perfBarReadFill: $('#perfBarReadFill'),
    chkIOParallel: $('#chkIOParallel'),

    // main
    main: $('#main'),
    gpuCanvas: $('#gpuCanvas'),
    cpuCanvas: $('#cpuCanvas'),
    overlayCanvas: $('#overlayCanvas'),
    selRect: $('#selRect'),
    hudPos: $('#hudPos'),
    hudVal: $('#hudVal'),
    thumbWrap: $('#thumbWrap'),
    thumb: $('#thumb'),

    // spectrum
    specPanel: $('#specPanel'),
    specCanvas: $('#specCanvas'),
    specTitle: $('#specTitle'),
    specSub: $('#specSub'),
    specFoot: $('#specFoot'),
    btnSpecClose: $('#btnSpecClose'),
    btnSpecCSV: $('#btnSpecCSV'),

    // right
    btnAuto: $('#btnAuto'),
    btnReset: $('#btnReset'),
    bandSearch: $('#bandSearch'),
    btnExpandAll: $('#btnExpandAll'),
    btnCollapseAll: $('#btnCollapseAll'),
    bandTree: $('#bandTree'),
    dispDataset: $('#dispDataset'),
    dispBand: $('#dispBand'),
    dispWl: $('#dispWl'),
    chkHistView: $('#chkHistView'),
    hist: $('#hist'),
    lblRange: $('#lblRange'),
    rangeMin: $('#rangeMin'),
    rangeMax: $('#rangeMax'),
    numMin: $('#numMin'),
    numMax: $('#numMax'),
    slContrast: $('#slContrast'),
    lblContrast: $('#lblContrast'),
    slGamma: $('#slGamma'),
    lblGamma: $('#lblGamma'),
    slGain: $('#slGain'),
    lblGain: $('#lblGain'),

    // export dialog
    exportDlg: $('#exportDlg'),
    expTitle: $('#expTitle'),
    expInfo: $('#expInfo'),
    expModeRaw: $('#expModeRaw'),
    expModeRendered: $('#expModeRendered'),
    expRawOptions: $('#expRawOptions'),
    expRenderedOptions: $('#expRenderedOptions'),
    expLblRawSel: $('#expLblRawSel'),
    expLblRenSel: $('#expLblRenSel'),
    expRawScopeSel: $('#expRawScopeSel'),
    expRawScopeWhole: $('#expRawScopeWhole'),
    expRenScopeSel: $('#expRenScopeSel'),
    expRenScopeView: $('#expRenScopeView'),
    expRenScopeWhole: $('#expRenScopeWhole'),
    expEstimate: $('#expEstimate'),
    expWarning: $('#expWarning'),
    expNote: $('#expNote'),
    btnExpCancel: $('#btnExpCancel'),
    btnExpGo: $('#btnExpGo'),
  };

  const thumbCtx = els.thumb.getContext('2d', {alpha:false});
  const overlayCtx = els.overlayCanvas.getContext('2d', {alpha:true});
  const cpuCtx = els.cpuCanvas.getContext('2d', {alpha:false});
  const specCtx = els.specCanvas.getContext('2d', {alpha:false});

  function setStatus(text, cls){
    els.statusBadge.textContent = text || '';
    els.statusBadge.classList.remove('warn','ok','err');
    if (cls) els.statusBadge.classList.add(cls);
  }

  function pixelOffset(meta, x, y, b){ return pixelOffsetCore(meta, x, y, b); }
  function makeSegmentReader(meta, u8){ return makeSegmentReaderCore(meta, u8); }
  function segGet(meta, seg, i){ return segGetCore(meta, seg, i); }
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
    ioParallel: true,

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
    histMode: 'whole', // 'whole' or 'view'
    histViewDebounce: null,

    exportKind: null,
  };

  
  // ========= I/O mode =========

  const cacheRuntime = createCacheRuntime({
    state,
    clamp,
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
  function applyRangeFromInputs(ds){ uiPanels.applyRangeFromInputs(ds); }
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
    onAfterDatasetUIUpdate: () => {
      rebuildDatasetList();
      rebuildBandTree();
      updateMetaUI();
      updatePerf();
      updateDisplayUI(true);
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

  function tone01(v, minVal, maxVal, gamma, gain, contrast){ return tone01Core(v, minVal, maxVal, gamma, gain, contrast); }

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
  function drawHistogram(ds){ histogram.drawHistogram(ds); }
  function histPickHandle(ds, px, py){ return histogram.histPickHandle(ds, px, py); }
  function applyHistogramDrag(ds, kind, clientX){ histogram.applyHistogramDrag(ds, kind, clientX); }
  // ========= Rendering (direct read or pyramid) =========

  function resizeCanvases(){
    const dpr = window.devicePixelRatio || 1;
    const rect = els.main.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));

    // GPU canvas sized in gpuConfigureCanvas (it will call configure)
    els.cpuCanvas.width = w;
    els.cpuCanvas.height = h;
    els.overlayCanvas.width = w;
    els.overlayCanvas.height = h;
  }

  function clampView(){ viewControls.clampView(); }
  function fitToScreen(){ viewControls.fitToScreen(); }
  function screenToImage(sx, sy){ return viewControls.screenToImage(sx, sy); }

  function scheduleRender(){
    if (state._rafPending) return;
    state._rafPending = true;
    requestAnimationFrame(() => {
      state._rafPending = false;
      render();
    });
  }

  function typeDefaultRange(meta){ return typeDefaultRangeCore(meta); }
  function resolveDisplayRange(ds, band, fallbackArray){ return resolveDisplayRangeCore(ds, band, fallbackArray, getBandSettings); }

  async function tryRasterFromPyramid(ds, band, eff){
    ds.__pyrPreferImmediate = !!state.mouse.dragging;
    return pyramid.tryRasterFromPyramid(ds, band, eff);
  }

  async function readRasterDirect(ds, band, eff){
    const canvasW = els.cpuCanvas.width;
    const canvasH = els.cpuCanvas.height;

    let rasterW, rasterH, step;

    if (eff >= 1){
      rasterW = Math.ceil(canvasW / eff);
      rasterH = Math.ceil(canvasH / eff);
      step = 1;
    } else {
      step = Math.ceil(1 / eff);
      rasterW = canvasW;
      rasterH = canvasH;
    }

    const x0 = ds.view.x;
    const y0 = ds.view.y;

    let raw;
    if (ds.meta.interleave === 'bip'){
      raw = await readBandWindowBIP(ds.meta, ds.ds, band, x0, y0, rasterW, rasterH, step);
    } else {
      raw = await readBandWindow(ds.meta, ds.ds, band, x0, y0, rasterW, rasterH, step);
    }

    return { band, dataF32: toFloat32(raw), w: rasterW, h: rasterH, source:'direct', level:0, step, x0, y0 };
  }

  function cpuRenderGray(rasterF32, w, h, params){
    // draw into offscreen imageData then scale to canvas
    const img = cpuCtx.createImageData(w, h);
    const dst = img.data;
    const minVal = params.minVal, maxVal = params.maxVal;
    const gamma = params.gamma, gain = params.gain, contrast = params.contrast;

    for (let i=0, j=0; i<rasterF32.length; i++, j+=4){
      const t = tone01(rasterF32[i], minVal, maxVal, gamma, gain, contrast);
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
  });

  function drawOverlays(ds){
    overlayRenderer.drawOverlays(ds);
  }

  async function render(opts = {}){
    const ds = getActive();
    if (!ds || ds.activeBand == null){
      // clear canvases
      resizeCanvases();
      cpuCtx.setTransform(1,0,0,1,0,0);
      cpuCtx.fillStyle = '#000';
      cpuCtx.fillRect(0,0,els.cpuCanvas.width, els.cpuCanvas.height);
      overlayCtx.setTransform(1,0,0,1,0,0);
      overlayCtx.clearRect(0,0,els.overlayCanvas.width, els.overlayCanvas.height);
      return;
    }

    const seq = ++state.renderSeq;

    resizeCanvases();
    const dpr = window.devicePixelRatio || 1;
    const eff = ds.view.scale * dpr;

    // WebGPU init (best-effort). If it fails, we'll use CPU canvas.
    let useGPU = false;
    if (gpuSupported){
      const ok = await initWebGPU();
      if (ok) useGPU = true;
    }

    els.gpuBadge.textContent = gpuSupported ? (useGPU ? 'WebGPU: on' : 'WebGPU: off') : 'WebGPU: n/a';
    els.gpuCanvas.style.display = useGPU ? 'block' : 'none';
    els.cpuCanvas.style.display = useGPU ? 'none' : 'block';

    // Clamp view to bounds
    clampView();

    const band = ds.activeBand;
    const settings = getBandSettings(ds, band);

    // If only display params changed, reuse last raster if it matches.
    const reuse = !!opts.reuseRaster;
    let raster = null;

    if (reuse && ds.lastRaster && ds.lastRaster.band === band){
      raster = ds.lastRaster;
    } else {
      // attempt pyramid render when zoomed out
      if (eff < 1){
        raster = await tryRasterFromPyramid(ds, band, eff);
      }
      if (!raster){
        setStatus('reading…','warn');
        raster = await readRasterDirect(ds, band, eff);
      }
      ds.lastRaster = raster;
    }

    if (seq !== state.renderSeq) return;

    const range = resolveDisplayRange(ds, band, raster.dataF32);
    const params = {
      minVal: range.minVal,
      maxVal: range.maxVal,
      gamma: clamp(settings.gamma ?? 1, 0.10, 5.0),
      gain: clamp(settings.gain ?? 1, 0.0, 4.0),
      contrast: clamp(settings.contrast ?? 1, 0.1, 3.0),
    };

    // Sync UI with resolved values (without forcing user mid-edit)
    syncRangeInputsFromSettings(ds);

    try{
      const t0 = now();
      if (useGPU){
        gpuRender(raster.dataF32, raster.w, raster.h, params);
      } else {
        cpuRenderGray(raster.dataF32, raster.w, raster.h, params);
      }

      state.lastRenderMs = now() - t0;
      setStatus('ready','ok');

      // overlays
      drawOverlays(ds);

      updatePerf();
      renderThumbnail();
      updateHud();

      // view histogram mode: debounce recompute to avoid heavy updates during pan
      if (state.histMode === 'view'){
        if (state.histViewDebounce) clearTimeout(state.histViewDebounce);
        state.histViewDebounce = setTimeout(() => {
          const d = getActive();
          if (!d || d.id !== ds.id) return;
          ensureViewHistogram(d);
        }, 180);
      }

    } catch (e){
      console.error(e);
      if (seq !== state.renderSeq) return;
      setStatus('render error','err');
    }
  }

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
    bandLabel,
    probeValueAtBand,
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

  async function openSpectrumAt(ds, ix, iy){ await spectrum.openSpectrumAt(ds, ix, iy); }
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
  function onPointerUp(){ interactions.onPointerUp(); }
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

  function openExportDialog(kind){ exportDialog.openExportDialog(kind); }
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
    applyRangeFromInputs,
    applyRangeFromNumbers,
    ensureViewHistogram,
    syncRangeInputsFromSettings,
    histPickHandle,
    applyHistogramDrag,
    addDatasetsFromFileList,
    resizeCanvases,
    redrawSpectrum,
    disposePyramid,
    updateMetaUI,
    updatePerf,
    updateZoomLabelBoot: updateZoomLabel,
    setGpuBadgeAvailable: () => { els.gpuBadge.textContent = gpuSupported ? "WebGPU: available" : "WebGPU: n/a"; }
  });
})();











