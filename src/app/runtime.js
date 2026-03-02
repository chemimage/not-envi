import { createExportDialogController, createExportService } from "../export/export-controller.js";
import { createDatasetRuntime } from "./dataset-runtime.js";
import { createUIPanels } from "./ui-panels.js";
import { createViewControls } from "./view-controls.js";
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
import { createHudController } from "../render/hud.js";
import { createOverlayRenderer } from "../render/overlay.js";
import { createPyramidController } from "../render/pyramid-cache.js";
import { createSpectrumController } from "../render/spectrum.js";
import { probeValueAtBand, readSpectrumAtPixel as readSpectrumAtPixelCore, wavelengthArrayOrNull as wavelengthArrayOrNullCore } from "../render/spectrum-data.js";
import { createThumbnailController } from "../render/thumbnail.js";
import { clamp, fmt, fmtNoGroup, humanBytes } from "../core/utils.js";
import { bindCoreEvents, createInteractionController } from "../ui/events.js";

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

  const HOST_LITTLE_ENDIAN = (() => {
    const b = new ArrayBuffer(2);
    new DataView(b).setUint16(0, 0x00ff, true);
    return new Uint8Array(b)[0] === 0xff;
  })();

  // ========= IO helpers =========

  // A small, bounded amount of parallelism helps on SSDs (and reduces latency for scattered reads),
  // but too much can overwhelm the browser. We keep it conservative.
  const IO_CONCURRENCY_MAX = clamp(Math.floor(((navigator && navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : 4) / 2) + 1, 2, 8);
  let IO_CONCURRENCY = IO_CONCURRENCY_MAX; // can be toggled to 1 (sequential)


  async function parallelFor(count, limit, fn){
    const n = Math.min(Math.max(1, limit|0), count|0);
    let next = 0;
    const workers = [];
    for (let w=0; w<n; w++){
      workers.push((async () => {
        while (true){
          const i = next++;
          if (i >= count) break;
          await fn(i);
        }
      })());
    }
    await Promise.all(workers);
  }

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

  const gpu = {
    supported: !!(navigator.gpu),
    ready: false,
    device: null,
    context: null,
    format: null,
    computePipeline: null,
    renderPipeline: null,
    samplerNearest: null,
    uniformBuf: null,
    uniformArr: null,
    inBuf: null,
    inBufBytes: 0,
    outTex: null,
    outTexW: 0,
    outTexH: 0,
    outView: null,
    computeBindGroup: null,
    renderBindGroup: null,
    lastError: null,
  };

  async function initWebGPU(){
    if (!gpu.supported) return false;
    if (gpu.ready) return true;
    try{
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('No WebGPU adapter available');
      const device = await adapter.requestDevice();
      const context = els.gpuCanvas.getContext('webgpu');
      if (!context) throw new Error('WebGPU context not available');

      const format = navigator.gpu.getPreferredCanvasFormat();
      gpu.device = device;
      gpu.context = context;
      gpu.format = format;

      const wgsl = {
        compute: `
struct Params {
  width: u32,
  height: u32,
  _pad0: u32,
  _pad1: u32,
  minVal: f32,
  maxVal: f32,
  gamma: f32,
  gain: f32,
  contrast: f32,
  _pad2: f32,
  _pad3: f32,
  _pad4: f32,
};

@group(0) @binding(0) var<storage, read> inData: array<f32>;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params: Params;

fn tone(v: f32) -> f32 {
  let denom = max(1e-12, params.maxVal - params.minVal);
  var t = (v - params.minVal) / denom;
  // NaN check: if t != t then it's NaN
  if (!(t == t)) { t = 0.0; }
  t = clamp(t, 0.0, 1.0);
  t = pow(t, params.gamma);
  t = (t - 0.5) * params.contrast + 0.5;
  t = t * params.gain;
  return clamp(t, 0.0, 1.0);
}

@compute @workgroup_size(16,16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x;
  let y = gid.y;
  if (x >= params.width || y >= params.height) { return; }
  let idx = y * params.width + x;
  let v = inData[idx];
  let t = tone(v);
  textureStore(outTex, vec2<i32>(i32(x), i32(y)), vec4<f32>(t, t, t, 1.0));
}
`,
        render: `
struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0)
  );
  var uvs = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(1.0, 0.0)
  );
  var o: VSOut;
  o.pos = vec4<f32>(positions[vi], 0.0, 1.0);
  o.uv = uvs[vi];
  return o;
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  return textureSample(tex, samp, in.uv);
}
`,
      };

      gpu.computePipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: device.createShaderModule({code: wgsl.compute}), entryPoint: 'main' }
      });

      gpu.renderPipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: device.createShaderModule({code: wgsl.render}), entryPoint: 'vs' },
        fragment: { module: device.createShaderModule({code: wgsl.render}), entryPoint: 'fs',
          targets: [{ format }]
        },
        primitive: { topology: 'triangle-list' }
      });

      gpu.samplerNearest = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });

      // Uniforms: use 16-byte aligned struct; we pack into Float32Array/Uint32Array via a shared buffer.
      gpu.uniformBuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      gpu.uniformArr = new ArrayBuffer(64);

      gpu.ready = true;
      gpu.lastError = null;
      return true;
    } catch (e){
      gpu.lastError = e;
      console.warn('WebGPU init failed:', e);
      return false;
    }
  }

  function gpuConfigureCanvas(){
    if (!gpu.ready) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = els.main.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));

    if (els.gpuCanvas.width !== w || els.gpuCanvas.height !== h){
      els.gpuCanvas.width = w;
      els.gpuCanvas.height = h;
      gpu.context.configure({ device: gpu.device, format: gpu.format, alphaMode: 'opaque' });
    }
  }

  function gpuEnsureInBuffer(bytes){
    if (!gpu.ready) return;
    if (gpu.inBuf && gpu.inBufBytes >= bytes) return;
    gpu.inBufBytes = bytes;
    gpu.inBuf = gpu.device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  function gpuEnsureOutTexture(w, h){
    if (!gpu.ready) return;
    if (gpu.outTex && gpu.outTexW === w && gpu.outTexH === h) return;

    gpu.outTexW = w;
    gpu.outTexH = h;
    gpu.outTex = gpu.device.createTexture({
      size: {width:w, height:h},
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
    });
    gpu.outView = gpu.outTex.createView();

    gpu.computeBindGroup = gpu.device.createBindGroup({
      layout: gpu.computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: gpu.inBuf } },
        { binding: 1, resource: gpu.outView },
        { binding: 2, resource: { buffer: gpu.uniformBuf } },
      ]
    });

    gpu.renderBindGroup = gpu.device.createBindGroup({
      layout: gpu.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: gpu.samplerNearest },
        { binding: 1, resource: gpu.outView },
      ]
    });
  }

  function gpuWriteUniforms(width, height, params){
    // Pack: width(u32), height(u32), pads, then floats.
    const dv = new DataView(gpu.uniformArr);
    dv.setUint32(0, width, true);
    dv.setUint32(4, height, true);
    dv.setUint32(8, 0, true);
    dv.setUint32(12, 0, true);
    dv.setFloat32(16, params.minVal, true);
    dv.setFloat32(20, params.maxVal, true);
    dv.setFloat32(24, params.gamma, true);
    dv.setFloat32(28, params.gain, true);
    dv.setFloat32(32, params.contrast, true);
    // rest padding
    gpu.device.queue.writeBuffer(gpu.uniformBuf, 0, gpu.uniformArr);
  }

  function gpuRender(rasterF32, w, h, params){
    if (!gpu.ready) return false;

    gpuConfigureCanvas();
    gpuEnsureInBuffer(rasterF32.byteLength);
    gpuEnsureOutTexture(w, h);

    gpu.device.queue.writeBuffer(gpu.inBuf, 0, rasterF32.buffer, rasterF32.byteOffset, rasterF32.byteLength);
    gpuWriteUniforms(w, h, params);

    const encoder = gpu.device.createCommandEncoder();

    {
      const pass = encoder.beginComputePass();
      pass.setPipeline(gpu.computePipeline);
      pass.setBindGroup(0, gpu.computeBindGroup);
      const gx = Math.ceil(w / 16);
      const gy = Math.ceil(h / 16);
      pass.dispatchWorkgroups(gx, gy);
      pass.end();
    }

    {
      const colorView = gpu.context.getCurrentTexture().createView();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: colorView,
          loadOp: 'clear',
          clearValue: {r:0,g:0,b:0,a:1},
          storeOp: 'store',
        }]
      });
      pass.setPipeline(gpu.renderPipeline);
      pass.setBindGroup(0, gpu.renderBindGroup);
      pass.draw(6, 1, 0, 0);
      pass.end();
    }

    gpu.device.queue.submit([encoder.finish()]);
    return true;
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

  function setIOParallel(enabled){
    const on = !!enabled;
    state.ioParallel = on;
    IO_CONCURRENCY = on ? IO_CONCURRENCY_MAX : 1;

    // Update existing data sources + pyramid workers.
    for (const ds of state.datasets){
      try{
        if (ds && ds.ds){
          if (typeof ds.ds.setConcurrency === 'function') ds.ds.setConcurrency(IO_CONCURRENCY);
          else if (typeof ds.ds.concurrency === 'number') ds.ds.concurrency = clamp(IO_CONCURRENCY, 1, 8);
        }
        if (ds && ds.pyramid) pyramid.updateInflightForIO(ds);
      }catch(_){}
    }
    updatePerf();
  }

// ========= Cache budgeting =========

  // We size in-memory caches from the browser's best-effort memory hints.
  // Target: ~40% of the available JS heap budget (or device RAM hint), shared across open datasets.
  const CACHE_BUDGET = {
    fracOfAvailable: 0.40,
    minBytes: 256 * 1024 * 1024,
    maxBytes: 3 * 1024 * 1024 * 1024,
    fracChunk: 0.60,
    fracPyramid: 0.40,
    totalBytes: 0,
  };

  function estimateTotalCacheBudgetBytes(){
    let heapLimit = 0;
    try{
      heapLimit = (performance && performance.memory && performance.memory.jsHeapSizeLimit) ? performance.memory.jsHeapSizeLimit : 0;
    }catch(_){}
    let devBytes = 0;
    try{
      devBytes = (navigator && navigator.deviceMemory) ? (navigator.deviceMemory * 1024 * 1024 * 1024) : 0;
    }catch(_){}

    let basis = heapLimit || devBytes || (1024 * 1024 * 1024);
    if (heapLimit && devBytes) basis = Math.min(heapLimit, devBytes);

    let budget = basis * CACHE_BUDGET.fracOfAvailable;
    budget = clamp(budget, CACHE_BUDGET.minBytes, CACHE_BUDGET.maxBytes);
    return budget;
  }

  function recomputeCacheBudgets(){
    if (!CACHE_BUDGET.totalBytes){
      CACHE_BUDGET.totalBytes = estimateTotalCacheBudgetBytes();
    }
    const n = Math.max(1, state.datasets.length);
    const per = CACHE_BUDGET.totalBytes / n;

    for (const ds of state.datasets){
      const chunkSize = (ds.ds && ds.ds.chunkSize) ? ds.ds.chunkSize : (1<<20);
      const chunkBytes = Math.max(chunkSize * 8, Math.floor(per * CACHE_BUDGET.fracChunk));
      const pyramidBytes = Math.max(64 * 1024 * 1024, Math.floor(per * CACHE_BUDGET.fracPyramid));

      ds.chunkBudgetBytes = chunkBytes;
      ds.pyramidBudgetBytes = pyramidBytes;

      if (ds.ds && ds.ds.setMaxBytes) ds.ds.setMaxBytes(chunkBytes);
      if (ds.pyramid) ds.pyramid.limitBytes = pyramidBytes;
    }
    updatePerf();
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
    if (gpu.supported){
      const ok = await initWebGPU();
      if (ok) useGPU = true;
    }

    els.gpuBadge.textContent = gpu.supported ? (useGPU ? 'WebGPU: on' : 'WebGPU: off') : 'WebGPU: n/a';
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

  window.addEventListener('beforeunload', () => {
    try{
      for (const ds of state.datasets){
        if (ds && ds.pyramid){
          disposePyramid(ds.pyramid);
          ds.pyramid = null;
        }
      }
    }catch(_){}
  });

  window.addEventListener('resize', () => {
    resizeCanvases();
    const ds = getActive();
    if (ds) fitToScreen();
    redrawSpectrum();
  });

  // pointer events on main container (works regardless of which canvas is visible)
  // Double-click to open a spectrum (z-profile) panel at that pixel.
  els.main.addEventListener('dblclick', (ev) => {
    const ds = getActive();
    if (!ds) return;

    // Ignore double-clicks that originate from UI overlays.
    if (els.specPanel && els.specPanel.contains(ev.target)) return;

    const rect = els.main.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const sx = (ev.clientX - rect.left) * dpr;
    const sy = (ev.clientY - rect.top) * dpr;
    const img = screenToImage(sx, sy);
    const ix = clamp(Math.floor(img.x), 0, ds.meta.samples-1);
    const iy = clamp(Math.floor(img.y), 0, ds.meta.lines-1);
    openSpectrumAt(ds, ix, iy);
  });

  if (els.specPanel){
    els.specPanel.addEventListener('dblclick', (ev) => ev.stopPropagation());
  }
  if (els.btnSpecClose){
    els.btnSpecClose.onclick = (ev) => { ev.stopPropagation(); closeSpectrum(); };
  }
  if (els.btnSpecCSV){
    els.btnSpecCSV.onclick = (ev) => { ev.stopPropagation(); exportSpectrumCSV(); };
  }


  bindCoreEvents({
    els,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onWheel,
    }
  });
  els.main.addEventListener('pointerleave', onPointerLeave);

  els.thumb.addEventListener('click', onThumbClick);

  els.btnFit.onclick = () => fitToScreen();
  els.btn100.onclick = () => {
    const ds = getActive();
    if (!ds) return;
    ds.view.scale = 1;
    clampView();
    els.zoom.value = String(scaleToSlider(ds.view.scale));
    updateZoomLabel();
    render();
  };
  els.btnZoomIn.onclick = () => zoomAt(1.25, els.cpuCanvas.width/2, els.cpuCanvas.height/2);
  els.btnZoomOut.onclick = () => zoomAt(0.8, els.cpuCanvas.width/2, els.cpuCanvas.height/2);

  els.zoom.oninput = () => {
    const ds = getActive();
    if (!ds) return;
    const s = sliderToScale(Number(els.zoom.value));
    const centerX = els.cpuCanvas.width/2;
    const centerY = els.cpuCanvas.height/2;
    const before = screenToImage(centerX, centerY);
    ds.view.scale = s;
    // Clamp zoom (fit is min).
    const minS = minScaleFor(ds);
    ds.view.scale = clamp(ds.view.scale, minS, 128);
    const after = screenToImage(centerX, centerY);
    ds.view.x += (before.x - after.x);
    ds.view.y += (before.y - after.y);
    clampView();
    els.zoom.value = String(scaleToSlider(ds.view.scale));
    updateZoomLabel();
    render();
  };

  els.chkThumb.oninput = () => renderThumbnail();
  els.chkGrid.oninput = () => render();
  els.chkScale.oninput = () => render();

  if (els.chkIOParallel){
    els.chkIOParallel.oninput = () => setIOParallel(els.chkIOParallel.checked);
  }

  els.btnSelect.onclick = () => {
    const ds = getActive();
    if (!ds) return;
    state.selection.enabled = !state.selection.enabled;
    if (state.selection.enabled){
      els.btnSelect.classList.add('primary');
      setStatus('select a region','warn');
    } else {
      els.btnSelect.classList.remove('primary');
      clearSelection();
      setStatus('ready','ok');
    }
  };

  els.btnExportPNG.onclick = () => openExportDialog('png');
  els.btnExportTIFF.onclick = () => openExportDialog('tiff');

  // Export dialog
  els.expModeRaw.oninput = () => updateExportDialogUI();
  els.expModeRendered.oninput = () => updateExportDialogUI();
  els.expRawScopeSel.oninput = () => updateExportEstimate();
  els.expRawScopeWhole.oninput = () => updateExportEstimate();
  els.expRenScopeSel.oninput = () => updateExportEstimate();
  els.expRenScopeView.oninput = () => updateExportEstimate();
  els.expRenScopeWhole.oninput = () => updateExportEstimate();

  els.btnExpCancel.onclick = () => {
    try { els.exportDlg.close(); } catch { els.exportDlg.open = false; }
  };
  els.btnExpGo.onclick = () => {
    runExportFromDialog().catch(err => {
      console.error(err);
      alert('Export failed. See console for details.');
      setStatus('ready','ok');
    });
  };

  els.bandSearch.oninput = () => rebuildBandTree();
  els.btnExpandAll.onclick = () => {
    for (const ds of state.datasets) ds.treeExpanded = true;
    rebuildBandTree({preserveScroll:true});
  };
  els.btnCollapseAll.onclick = () => {
    for (const ds of state.datasets) ds.treeExpanded = false;
    rebuildBandTree({preserveScroll:true});
  };

  els.btnReset.onclick = () => {
    const ds = getActive();
    if (!ds) return;
    resetDisplay(ds);
  };
  els.btnAuto.onclick = () => {
    const ds = getActive();
    if (!ds) return;
    autoDisplay(ds);
  };

  els.slContrast.oninput = () => {
    const ds = getActive();
    if (!ds) return;
    const s = getBandSettings(ds, ds.activeBand);
    s.contrast = Number(els.slContrast.value);
    els.lblContrast.textContent = Number(s.contrast).toFixed(2);
    drawHistogram(ds);
    render({reuseRaster:true});
  };

  els.slGamma.oninput = () => {
    const ds = getActive();
    if (!ds) return;
    const s = getBandSettings(ds, ds.activeBand);
    s.gamma = Number(els.slGamma.value);
    els.lblGamma.textContent = Number(s.gamma).toFixed(2);
    drawHistogram(ds);
    render({reuseRaster:true});
  };

  els.slGain.oninput = () => {
    const ds = getActive();
    if (!ds) return;
    const s = getBandSettings(ds, ds.activeBand);
    s.gain = Number(els.slGain.value);
    els.lblGain.textContent = Number(s.gain).toFixed(2);
    drawHistogram(ds);
    render({reuseRaster:true});
  };

  els.rangeMin.oninput = () => {
    const ds = getActive();
    if (!ds) return;
    applyRangeFromInputs(ds);
    drawHistogram(ds);
    render({reuseRaster:true});
  };
  els.rangeMax.oninput = () => {
    const ds = getActive();
    if (!ds) return;
    applyRangeFromInputs(ds);
    drawHistogram(ds);
    render({reuseRaster:true});
  };

  els.numMin.onchange = () => {
    const ds = getActive();
    if (!ds) return;
    applyRangeFromNumbers(ds);
    drawHistogram(ds);
    render({reuseRaster:true});
  };
  els.numMax.onchange = () => {
    const ds = getActive();
    if (!ds) return;
    applyRangeFromNumbers(ds);
    drawHistogram(ds);
    render({reuseRaster:true});
  };

  els.chkHistView.oninput = () => {
    const ds = getActive();
    state.histMode = els.chkHistView.checked ? 'view' : 'whole';
    if (!ds) return;
    if (state.histMode === 'view'){
      ensureViewHistogram(ds);
    } else {
      ds.bandStatsView = null;
      syncRangeInputsFromSettings(ds, {force:true});
      drawHistogram(ds);
    }
  };

  // Histogram pointer interaction
  els.hist.addEventListener('pointerdown', (ev) => {
    const ds = getActive();
    if (!ds) return;
    const handle = histPickHandle(ds, ev.clientX, ev.clientY);
    if (!handle) return;
    state.histDrag.active = true;
    state.histDrag.handle = handle;
    els.hist.setPointerCapture(ev.pointerId);
    applyHistogramDrag(ds, handle, ev.clientX);
  });
  els.hist.addEventListener('pointermove', (ev) => {
    if (!state.histDrag.active) return;
    const ds = getActive();
    if (!ds) return;
    applyHistogramDrag(ds, state.histDrag.handle, ev.clientX);
  });
  els.hist.addEventListener('pointerup', (ev) => {
    state.histDrag.active = false;
    state.histDrag.handle = null;
    try{ els.hist.releasePointerCapture(ev.pointerId); }catch(_){}
  });
  els.hist.addEventListener('pointercancel', () => {
    state.histDrag.active = false;
    state.histDrag.handle = null;
  });

  // File picking
  // Click-to-open: the drop area is also the file picker trigger (no separate button).
  els.dropzone.addEventListener('click', (ev) => {
    const t = ev.target;
    if (t && t.closest && t.closest('a,button')) return;
    try{
      els.filePicker.click();
    }catch(_){}
  });
  els.dropzone.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' '){
      ev.preventDefault();
      els.filePicker.click();
    }
  });

  els.filePicker.onchange = async (ev) => {
    const files = ev.target.files;
    if (!files || !files.length) return;
    await addDatasetsFromFileList(files);
    els.filePicker.value = '';
  };

  // Drag and drop
  els.dropzone.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    els.dropzone.classList.add('dragover');
  });
  els.dropzone.addEventListener('dragleave', () => els.dropzone.classList.remove('dragover'));
  els.dropzone.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    els.dropzone.classList.remove('dragover');
    const files = ev.dataTransfer?.files;
    if (!files || !files.length) return;
    await addDatasetsFromFileList(files);
  });

  // ========= Init =========

  (function boot(){
    resizeCanvases();
    setStatus('idle','');
    updateMetaUI();
    updatePerf();
    updateZoomLabel();

    if (els.chkIOParallel){
      els.chkIOParallel.checked = state.ioParallel;
      setIOParallel(state.ioParallel);
    }

    if (gpu.supported){
      els.gpuBadge.textContent = 'WebGPU: available';
    } else {
      els.gpuBadge.textContent = 'WebGPU: n/a';
    }
  })();

})();








