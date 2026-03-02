import { createExportService } from "../export/export-service.js";
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
  percentileFromHist as percentileFromHistCore,
  quickStatsFromArray as quickStatsFromArrayCore,
  resolveDisplayRange as resolveDisplayRangeCore,
  tone01 as tone01Core,
  typeDefaultRange as typeDefaultRangeCore
} from "../render/display-math.js";
import { createPyramidController } from "../render/pyramid-cache.js";
import { probeValueAtBand, readSpectrumAtPixel as readSpectrumAtPixelCore, wavelengthArrayOrNull as wavelengthArrayOrNullCore } from "../render/spectrum-data.js";

(() => {
  'use strict';

  // ========= Utilities =========

  const $ = (sel) => document.querySelector(sel);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const now = () => performance.now();

  function fmt(n){
    if (typeof n === 'number' && isFinite(n)){
      // If it looks like an integer, keep it clean; else show a few decimals.
      const abs = Math.abs(n);
      if (abs >= 1000) return n.toLocaleString(undefined, {maximumFractionDigits: 3});
      if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
      return n.toFixed(6).replace(/0+$/,'').replace(/\.$/,'');
    }
    return String(n);
  }

  // Like fmt(), but never uses locale grouping separators.
  // Useful for wavelengths/band names where users expect the header's raw-looking numbers.
  function fmtNoGroup(n){
    if (typeof n === 'number' && isFinite(n)){
      if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
      return n.toFixed(6).replace(/0+$/,'').replace(/\.$/,'');
    }
    return String(n);
  }

  function fmtUm(v){
    if (!isFinite(v)) return '—';
    const abs = Math.abs(v);
    const dec = abs < 10 ? 3 : abs < 100 ? 2 : abs < 1000 ? 1 : 0;
    return Number(v).toFixed(dec).replace(/\.0+$/,'').replace(/(\.[0-9]*[1-9])0+$/,'$1');
  }

  function humanBytes(n){
    if (!isFinite(n) || n < 0) return '—';
    const units = ['B','KB','MB','GB','TB'];
    let u = 0;
    while (n >= 1024 && u < units.length-1){ n/=1024; u++; }
    return `${n.toFixed(u===0?0:1)} ${units[u]}`;
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

  let nextDatasetId = 1;

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

  function computeFitScale(ds){
    const rect = els.main.getBoundingClientRect();
    return Math.min(rect.width / ds.meta.samples, rect.height / ds.meta.lines);
  }

  // Minimum zoom-out: once the full dataset fits, don't allow zooming out further.
  function minScaleFor(ds){
    const fit = computeFitScale(ds);
    return Math.min(1, fit);
  }

  function updateZoomRange(ds){
    if (!ds){
      state.zoomExpMin = -6;
      state.zoomExpMax = 4;
      return;
    }
    const minScale = Math.max(1e-9, minScaleFor(ds));
    const minExp = Math.log2(minScale);
    // Extend slider range when fit scale is smaller than our default.
    state.zoomExpMin = Math.min(-6, Math.floor(minExp) - 1);
    state.zoomExpMax = 4;
  }

  // slider 0..100 -> scale ~ 2^[zoomExpMin..zoomExpMax]
  function sliderToScale(v){
    const t = clamp(v/100, 0, 1);
    const exp = state.zoomExpMin + t*(state.zoomExpMax - state.zoomExpMin);
    return Math.pow(2, exp);
  }
  function scaleToSlider(s){
    const exp = Math.log2(Math.max(1e-9, s));
    const t = (exp - state.zoomExpMin) / Math.max(1e-9, (state.zoomExpMax - state.zoomExpMin));
    return clamp(Math.round(t*100), 0, 100);
  }
  function updateZoomLabel(){
    const ds = getActive();
    if (!ds){ els.zoomLabel.textContent = '—'; return; }
    els.zoomLabel.textContent = (ds.view.scale * 100).toFixed(1) + '%';
  }

  // ========= Dataset helpers =========

  function getActive(){
    return state.datasets.find(d => d.id === state.activeId) || null;
  }

  function setActiveDataset(id, {fit=false} = {}){
    state.activeId = id;
    closeSpectrum();
    rebuildDatasetList();
    rebuildBandTree();
    updateMetaUI();
    updatePerf();
    updateDisplayUI(true);
    const ds = getActive();
    updateZoomRange(ds);
    if (fit) fitToScreen();
    else render();
  }

  function guessDatasetName(hdrFile, dataFile){
    const n = hdrFile?.name || dataFile?.name || 'dataset';
    return n.replace(/\.hdr$/i,'').replace(/\.(img|dat|raw|bin|bip|bil|bsq)$/i,'');
  }

  function bandLabel(ds, b){
    if (!ds || !ds.meta) return `Band ${b}`;
    const names = ds.meta.bandNames;
    if (Array.isArray(names) && names[b] != null && String(names[b]).trim()){
      return String(names[b]).trim();
    }
    const wl = ds.meta.wavelengths ? ds.meta.wavelengths[b] : null;
    if (wl != null && wl !== undefined) return fmtNoGroup(wl);
    return `Band ${b}`;
  }

  function makeDatasetFromLoadedFiles({hdrFile, dataFile, meta, base, cached}){
    const initialBand = (meta.defaultBands && meta.defaultBands.length) ? meta.defaultBands[0] : 0;
    const ds = {
      id: 'ds' + (nextDatasetId++),
      name: guessDatasetName(hdrFile, dataFile),
      meta,
      ds: cached,
      baseDs: base,
      view: {x:0,y:0,scale:1},
      activeBand: clamp(initialBand, 0, meta.bands-1),
      bandSettings: new Map(),
      bandStatsWhole: new Map(),
      bandStatsView: null,
      thumb: {ready:false, _t:0, scale:1, x0:0, y0:0, w:0, h:0},
      treeExpanded: true,
      pyramid: null,
      lastRaster: null,
    };
    ds.bandSettings.set(ds.activeBand, {min:null, max:null, gamma:1, gain:1, contrast:1});
    return ds;
  }

  function attachDataset(ds){
    state.datasets.unshift(ds);
    recomputeCacheBudgets();
    setActiveDataset(ds.id, {fit:true});
    buildBandStatsWhole(ds, ds.activeBand).catch(()=>{});
  }

  async function addDatasetsFromFileList(files){
    const list = Array.from(files || []);
    if (!list.length) return;

    let result;
    try{
      result = await addDatasetsFromFileListMod(list, {
        setStatus,
        ioConcurrency: IO_CONCURRENCY,
        chunkSize: 1<<20,
        cacheBytes: 128 * 1024 * 1024,
        createDataset: makeDatasetFromLoadedFiles,
      });
    } catch (e){
      console.error(e);
      alert((e && e.message) ? e.message : String(e));
      setStatus('error','err');
      return;
    }

    const {datasets, missing, headersFound} = result;
    if (!headersFound){
      alert('No .hdr file found. Please select/drop the ENVI header (.hdr) and its matching binary file.');
      return;
    }
    if (!datasets.length){
      alert('No complete ENVI pairs found.\n\nMissing data file for:\n' + missing.join('\n'));
      return;
    }

    for (const ds of datasets){
      attachDataset(ds);
    }

    if (missing.length){
      alert('Some headers had no matching data file in your selection:\n\n' + missing.join('\n'));
    }
  }

  async function addDatasetFromFiles(hdrFile, dataFile){
    const ds = await addDatasetFromFilesMod(hdrFile, dataFile, {
      setStatus,
      ioConcurrency: IO_CONCURRENCY,
      chunkSize: 1<<20,
      cacheBytes: 128 * 1024 * 1024,
      createDataset: makeDatasetFromLoadedFiles,
    });
    attachDataset(ds);
  }

  // ========= UI rebuild =========

  function rebuildDatasetList(){
    els.datasetCount.textContent = String(state.datasets.length);
    els.datasetList.innerHTML = '';
    for (const ds of state.datasets){
      const div = document.createElement('div');
      div.className = 'ds-item' + (ds.id === state.activeId ? ' active' : '');
      div.onclick = () => setActiveDataset(ds.id);

      const left = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = ds.name;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `${ds.meta.samples}×${ds.meta.lines}  bands:${ds.meta.bands}  ${ds.meta.interleave}`;
      left.appendChild(title);
      left.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'actions';
      const btnClose = document.createElement('button');
      btnClose.className = 'btn danger';
      btnClose.textContent = 'Close';
      btnClose.onclick = (ev) => { ev.stopPropagation(); closeDataset(ds.id); };
      actions.appendChild(btnClose);

      div.appendChild(left);
      div.appendChild(actions);
      els.datasetList.appendChild(div);
    }
  }

  function updateMetaUI(){
    const ds = getActive();
    if (!ds){
      els.metaSamples.textContent = '—';
      els.metaLines.textContent = '—';
      els.metaBands.textContent = '—';
      els.metaInterleave.textContent = '—';
      els.metaType.textContent = '—';
      els.metaEndian.textContent = '—';
      els.metaWlUnits.textContent = '—';
      els.metaScale.textContent = '—';
      els.metaExtra.textContent = '—';
      return;
    }
    els.metaSamples.textContent = fmt(ds.meta.samples);
    els.metaLines.textContent = fmt(ds.meta.lines);
    els.metaBands.textContent = fmt(ds.meta.bands);
    els.metaInterleave.textContent = ds.meta.interleave;
    els.metaType.textContent = `${ds.meta.dataType} (${ds.meta.dataTypeInfo.name})`;
    els.metaEndian.textContent = ds.meta.littleEndian ? 'little' : 'big';

    els.metaWlUnits.textContent = (ds.meta.wlUnits && String(ds.meta.wlUnits).trim()) ? String(ds.meta.wlUnits).trim() : '—';

    const sc = ds.meta.scale;
    if (sc && isFinite(sc.umPerPixelX) && isFinite(sc.umPerPixelY)){
      const x = Number(sc.umPerPixelX);
      const y = Number(sc.umPerPixelY);
      const same = Math.abs(x - y) <= Math.max(1e-9, Math.abs(x) * 1e-6);
      els.metaScale.textContent = same
        ? `${fmtNoGroup(x)} µm/px`
        : `${fmtNoGroup(x)} × ${fmtNoGroup(y)} µm/px`;
      els.metaScale.title = `Parsed from ${sc.source || 'header'}`;
    } else {
      els.metaScale.textContent = '—';
      els.metaScale.title = '';
    }

    const desc = (ds.meta.desc && String(ds.meta.desc).trim()) ? String(ds.meta.desc).trim() : '';
    els.metaExtra.textContent = desc || '—';
  }

  function updatePerf(){
    const ds = getActive();
    if (!ds){
      els.perfBytes.textContent = '0';
      els.perfCache.textContent = '0 MB';
      els.perfPyramid.textContent = '0 MB';
      els.perfBarCacheText.textContent = '—';
      els.perfBarReadText.textContent = '—';
      els.perfBarCacheFill.style.width = '0%';
      els.perfBarReadFill.style.width = '0%';
      return;
    }
    const bytesRead = ds.ds.bytesRead || 0;
    const chunkUsed = ds.ds.cacheBytes ? ds.ds.cacheBytes() : 0;
    const pyramidUsed = ds.pyramid ? ds.pyramid.totalBytes : 0;

    els.perfBytes.textContent = humanBytes(bytesRead);
    els.perfCache.textContent = humanBytes(chunkUsed);
    els.perfPyramid.textContent = humanBytes(pyramidUsed);

    const chunkCap = (ds.ds && ds.ds.maxBytes) ? ds.ds.maxBytes : 0;
    const pyramidCap = (ds.pyramid && ds.pyramid.limitBytes) ? ds.pyramid.limitBytes : 0;
    const cap = Math.max(1, chunkCap + pyramidCap);
    const used = chunkUsed + pyramidUsed;
    const frac = clamp(used / cap, 0, 1);
    els.perfBarCacheFill.style.width = (frac*100).toFixed(1) + '%';
    els.perfBarCacheText.textContent = `${humanBytes(used)} / ${humanBytes(cap)}`;

    const expected = (ds.meta.headerOffset||0) + (ds.meta.samples * ds.meta.lines * ds.meta.bands * ds.meta.dataTypeInfo.bytes);
    const full = Math.max(1, expected || 0, ds.ds.size || 0);
    const fracRead = clamp(bytesRead / full, 0, 1);
    els.perfBarReadFill.style.width = (fracRead*100).toFixed(1) + '%';
    els.perfBarReadText.textContent = `${humanBytes(bytesRead)} / ${humanBytes(full)}`;
  }

  function rebuildBandTree({preserveScroll=false} = {}){
    const q = (els.bandSearch.value || '').trim().toLowerCase();
    const prevScroll = preserveScroll ? els.bandTree.scrollTop : 0;
    els.bandTree.innerHTML = '';

    for (const ds of state.datasets){
      const node = document.createElement('div');
      node.className = 'tree-ds' + (ds.id === state.activeId ? ' active' : '');

      const head = document.createElement('div');
      head.className = 'tree-head';

      const caret = document.createElement('button');
      caret.className = 'caret';
      caret.textContent = ds.treeExpanded ? '▾' : '▸';
      caret.title = ds.treeExpanded ? 'Collapse' : 'Expand';
      caret.onclick = (ev) => {
        ev.stopPropagation();
        ds.treeExpanded = !ds.treeExpanded;
        rebuildBandTree({preserveScroll:true});
      };

      const name = document.createElement('div');
      name.className = 'tree-name';
      name.textContent = ds.name;
      name.title = ds.name;

      const meta = document.createElement('div');
      meta.className = 'tree-meta';
      meta.textContent = `${ds.meta.bands} bands`;

      const btnClose = document.createElement('button');
      btnClose.className = 'btn danger';
      btnClose.textContent = 'Close';
      btnClose.title = 'Close dataset';
      btnClose.onclick = (ev) => { ev.stopPropagation(); closeDataset(ds.id); };

      head.appendChild(caret);
      head.appendChild(name);
      head.appendChild(meta);
      head.appendChild(btnClose);

      head.onclick = () => setActiveDataset(ds.id);

      node.appendChild(head);

      if (ds.treeExpanded){
        const bandsWrap = document.createElement('div');
        bandsWrap.className = 'tree-bands';

        for (let b=0; b<ds.meta.bands; b++){
          const wl = ds.meta.wavelengths ? ds.meta.wavelengths[b] : null;
          const label = bandLabel(ds, b);

          if (q){
            const hay = (`${ds.name} ${b} ${label} ${wl!=null ? fmtNoGroup(wl) : ''}`).toLowerCase();
            if (!hay.includes(q)) continue;
          }

          const row = document.createElement('div');
          row.className = 'band-row' + ((ds.id === state.activeId && b === ds.activeBand) ? ' active' : '');
          row.onclick = () => {
            setActiveDataset(ds.id);
            setActiveBand(ds, b);
          };

          const lab = document.createElement('div');
          lab.className = 'label';
          lab.textContent = label;
          lab.title = `Band ${b}`;
          row.appendChild(lab);

          const btn = document.createElement('button');
          btn.className = 'btn';
          btn.textContent = 'View';
          btn.onclick = (ev) => {
            ev.stopPropagation();
            setActiveDataset(ds.id);
            setActiveBand(ds, b);
          };
          row.appendChild(btn);

          bandsWrap.appendChild(row);
        }

        node.appendChild(bandsWrap);
      }

      els.bandTree.appendChild(node);
    }

    if (preserveScroll) els.bandTree.scrollTop = prevScroll;
  }

  // ========= Display settings =========

  function getBandSettings(ds, band){
    if (!ds.bandSettings.has(band)){
      ds.bandSettings.set(band, {min:null, max:null, gamma:1, gain:1, contrast:1});
    }
    return ds.bandSettings.get(band);
  }

  function resolveStats(ds){
    const band = ds.activeBand;
    if (band == null) return null;
    if (state.histMode === 'view'){
      return ds.bandStatsView;
    }
    return ds.bandStatsWhole.get(band) || null;
  }

  function setActiveBand(ds, band){
    if (!ds) return;
    band = clamp(band|0, 0, ds.meta.bands-1);
    ds.activeBand = band;
    getBandSettings(ds, band); // ensure exists
    rebuildBandTree({preserveScroll:true});
    updateDisplayUI(true);
    render();
    // compute stats in background if missing (whole image)
    if (!ds.bandStatsWhole.has(band)){
      buildBandStatsWhole(ds, band).catch(()=>{});
    }
  }

  function updateDisplayUI(force=false){
    const ds = getActive();
    if (!ds || ds.activeBand == null){
      els.dispDataset.textContent = '—';
      els.dispBand.textContent = '—';
      els.dispWl.textContent = '—';
      els.lblRange.textContent = 'min —  max —  γ —';
      return;
    }
    const b = ds.activeBand;
    els.dispDataset.textContent = ds.name;
    els.dispBand.textContent = bandLabel(ds, b);
    els.dispBand.title = `Band index ${b}`;
    const wl = ds.meta.wavelengths ? ds.meta.wavelengths[b] : null;
    els.dispWl.textContent = (wl!=null ? fmtNoGroup(wl) : '—') + (ds.meta.wlUnits ? ` ${ds.meta.wlUnits}` : '');

    const s = getBandSettings(ds, b);
    els.slContrast.value = String(s.contrast ?? 1);
    els.slGamma.value = String(s.gamma ?? 1);
    els.slGain.value = String(s.gain ?? 1);
    els.lblContrast.textContent = Number(els.slContrast.value).toFixed(2);
    els.lblGamma.textContent = Number(els.slGamma.value).toFixed(2);
    els.lblGain.textContent = Number(els.slGain.value).toFixed(2);

    // Range UI depends on stats domain; may be missing initially.
    syncRangeInputsFromSettings(ds, {force});
    drawHistogram(ds);
  }

  function syncRangeInputsFromSettings(ds, {force=false} = {}){
    const b = ds.activeBand;
    if (b == null) return;
    const s = getBandSettings(ds, b);
    const stats = resolveStats(ds);

    let domMin, domMax;
    if (stats){
      domMin = stats.min;
      domMax = stats.max;
    } else if (ds.lastRaster && ds.lastRaster.band === b){
      const est = quickStatsFromArray(ds.lastRaster.dataF32);
      domMin = est.min;
      domMax = est.max;
    } else {
      domMin = 0;
      domMax = 1;
    }

    if (!isFinite(domMin) || !isFinite(domMax) || domMax === domMin){
      domMin = 0; domMax = 1;
    }

    const curMin = (s.min != null && isFinite(s.min)) ? s.min : (stats ? stats.p1 : domMin);
    const curMax = (s.max != null && isFinite(s.max)) ? s.max : (stats ? stats.p99 : domMax);

    const minVal = clamp(curMin, domMin, domMax);
    const maxVal = clamp(curMax, domMin, domMax);

    // numbers
    if (force || document.activeElement !== els.numMin) els.numMin.value = fmt(minVal);
    if (force || document.activeElement !== els.numMax) els.numMax.value = fmt(maxVal);

    // ranges normalized 0..1
    const tMin = (minVal - domMin) / (domMax - domMin);
    const tMax = (maxVal - domMin) / (domMax - domMin);

    if (force || document.activeElement !== els.rangeMin) els.rangeMin.value = String(clamp(tMin,0,1));
    if (force || document.activeElement !== els.rangeMax) els.rangeMax.value = String(clamp(tMax,0,1));

    // update range badge
    els.lblRange.textContent = `min ${fmt(minVal)}  max ${fmt(maxVal)}  γ ${Number(s.gamma ?? 1).toFixed(2)}`;
  }

  function applyRangeFromInputs(ds){
    const b = ds.activeBand;
    if (b == null) return;
    const s = getBandSettings(ds, b);
    const stats = resolveStats(ds);
    if (!stats) return;

    const domMin = stats.min;
    const domMax = stats.max;

    // from range sliders
    let tMin = Number(els.rangeMin.value);
    let tMax = Number(els.rangeMax.value);
    if (!isFinite(tMin)) tMin = 0;
    if (!isFinite(tMax)) tMax = 1;
    if (tMin > tMax){ const tmp = tMin; tMin = tMax; tMax = tmp; }

    const minVal = domMin + tMin * (domMax - domMin);
    const maxVal = domMin + tMax * (domMax - domMin);

    s.min = minVal;
    s.max = maxVal;

    // sync number fields
    els.numMin.value = fmt(minVal);
    els.numMax.value = fmt(maxVal);
    syncRangeInputsFromSettings(ds);
  }

  function applyRangeFromNumbers(ds){
    const b = ds.activeBand;
    if (b == null) return;
    const s = getBandSettings(ds, b);
    const stats = resolveStats(ds);
    if (!stats) return;

    const domMin = stats.min;
    const domMax = stats.max;

    let minVal = Number(els.numMin.value);
    let maxVal = Number(els.numMax.value);

    if (!isFinite(minVal)) minVal = s.min ?? stats.p1;
    if (!isFinite(maxVal)) maxVal = s.max ?? stats.p99;
    if (minVal > maxVal){ const tmp = minVal; minVal = maxVal; maxVal = tmp; }

    minVal = clamp(minVal, domMin, domMax);
    maxVal = clamp(maxVal, domMin, domMax);

    s.min = minVal;
    s.max = maxVal;

    // sync sliders
    const tMin = (minVal - domMin)/(domMax-domMin);
    const tMax = (maxVal - domMin)/(domMax-domMin);
    els.rangeMin.value = String(clamp(tMin,0,1));
    els.rangeMax.value = String(clamp(tMax,0,1));
    syncRangeInputsFromSettings(ds);
  }

  function resetDisplay(ds){
    const b = ds.activeBand;
    if (b == null) return;
    const s = getBandSettings(ds, b);
    s.min = null;
    s.max = null;
    s.gamma = 1;
    s.gain = 1;
    s.contrast = 1;
    updateDisplayUI(true);
    // re-render (reuse raster)
    render({reuseRaster:true});
  }

  function autoDisplay(ds){
    const b = ds.activeBand;
    if (b == null) return;
    const s = getBandSettings(ds, b);

    const stats = (ds.bandStatsWhole.get(b) || ds.bandStatsView);
    if (stats){
      s.min = stats.p1;
      s.max = stats.p99;
    } else {
      s.min = null;
      s.max = null;
    }
    s.gamma = 1;
    s.gain = 1;
    s.contrast = 1;

    updateDisplayUI(true);
    render({reuseRaster:true});
  }

  // ========= Histogram computation & drawing =========

  function quickStatsFromArray(arr){ return quickStatsFromArrayCore(arr); }

  function computeHistogram(arr, bins=256){ return computeHistogramCore(arr, bins); }

  function percentileFromHist(bins, min, max, q, total){ return percentileFromHistCore(bins, min, max, q, total); }

  async function buildBandStatsWhole(ds, band){
    if (!ds || band == null) return;
    // If we already have it, skip
    if (ds.bandStatsWhole.has(band)) return;

    // sample whole image to ~512x512 (or less)
    const target = 512;
    const stepX = Math.ceil(ds.meta.samples / target);
    const stepY = Math.ceil(ds.meta.lines / target);
    const step = Math.max(1, Math.max(stepX, stepY));
    const outW = Math.min(target, Math.ceil(ds.meta.samples / step));
    const outH = Math.min(target, Math.ceil(ds.meta.lines / step));

    try{
      setStatus('histogram…','warn');
      let raw;
      if (ds.meta.interleave === 'bip'){
        raw = await readBandWindowBIP(ds.meta, ds.ds, band, 0, 0, outW, outH, step);
      } else {
        raw = await readBandWindow(ds.meta, ds.ds, band, 0, 0, outW, outH, step);
      }
      const f32 = toFloat32(raw);
      const stats = computeHistogram(f32, 256);
      ds.bandStatsWhole.set(band, stats);

      // If this band is active and we're in whole mode, refresh UI.
      if (ds.id === state.activeId && ds.activeBand === band && state.histMode === 'whole'){
        syncRangeInputsFromSettings(ds, {force:true});
        drawHistogram(ds);
      }
      setStatus('ready','ok');
    } catch (e){
      console.warn('Histogram build failed', e);
      setStatus('ready','ok');
    }
  }

  function ensureViewHistogram(ds){
    if (!ds || !ds.lastRaster) return;
    const b = ds.activeBand;
    if (b == null) return;
    if (ds.lastRaster.band !== b) return;

    const stats = computeHistogram(ds.lastRaster.dataF32, 256);
    ds.bandStatsView = stats;
    syncRangeInputsFromSettings(ds, {force:true});
    drawHistogram(ds);
  }

  function tone01(v, minVal, maxVal, gamma, gain, contrast){ return tone01Core(v, minVal, maxVal, gamma, gain, contrast); }

  function drawHistogram(ds){
    const canvas = els.hist;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h){
      canvas.width = w; canvas.height = h;
    }
    const ctx = canvas.getContext('2d', {alpha:true});
    ctx.save();
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,w,h);

    const b = ds?.activeBand;
    const s = (ds && b!=null) ? getBandSettings(ds, b) : null;
    const stats = (ds && b!=null) ? resolveStats(ds) : null;

    // background
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0,0,w,h);

    if (!ds || !s || !stats || !stats.bins){
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = `${12*dpr}px ${getComputedStyle(document.body).fontFamily}`;
      ctx.fillText('Histogram not ready (select a band)', 10*dpr, 20*dpr);
      ctx.restore();
      return;
    }

    const bins = stats.bins;
    const maxBin = Math.max(1, ...bins);
    const pad = 10 * dpr;
    const plotX0 = pad;
    const plotY0 = pad;
    const plotW = w - 2*pad;
    const plotH = h - 2*pad;

    // bars
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    for (let i=0; i<bins.length; i++){
      const t = i / (bins.length - 1);
      const x = plotX0 + t * plotW;
      const barH = (bins[i] / maxBin) * plotH;
      ctx.fillRect(x, plotY0 + (plotH - barH), Math.max(1, plotW / bins.length), barH);
    }

    // compute active range
    const domMin = stats.min;
    const domMax = stats.max;
    const minVal = (s.min != null && isFinite(s.min)) ? s.min : stats.p1;
    const maxVal = (s.max != null && isFinite(s.max)) ? s.max : stats.p99;
    const gamma = s.gamma ?? 1;
    const gain = s.gain ?? 1;
    const contrast = s.contrast ?? 1;

    // range highlight
    const xMin = plotX0 + ((minVal - domMin)/(domMax-domMin)) * plotW;
    const xMax = plotX0 + ((maxVal - domMin)/(domMax-domMin)) * plotW;
    ctx.fillStyle = 'rgba(106,169,255,0.08)';
    ctx.fillRect(Math.min(xMin,xMax), plotY0, Math.abs(xMax-xMin), plotH);

    // transfer curve
    ctx.strokeStyle = 'rgba(106,169,255,0.95)';
    ctx.lineWidth = 2*dpr;
    ctx.beginPath();
    for (let ix=0; ix<=256; ix++){
      const t = ix/256;
      const raw = domMin + t*(domMax-domMin);
      const y01 = tone01(raw, minVal, maxVal, gamma, gain, contrast);
      const x = plotX0 + t*plotW;
      const y = plotY0 + (1 - y01)*plotH;
      if (ix===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.stroke();

    // handles
    function drawHandle(x, kind){
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1*dpr;
      ctx.beginPath();
      ctx.moveTo(x, plotY0);
      ctx.lineTo(x, plotY0 + plotH);
      ctx.stroke();

      const r = 6*dpr;
      const y = plotY0 + plotH + 0.5*r;
      ctx.fillStyle = kind==='mid' ? 'rgba(255,255,255,0.9)' : 'rgba(106,169,255,0.95)';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI*2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.stroke();
    }

    const midT = Math.pow(0.5, 1/Math.max(1e-6, gamma));
    const midVal = minVal + midT * (maxVal - minVal);
    const xMid = plotX0 + ((midVal - domMin)/(domMax-domMin)) * plotW;

    drawHandle(xMin, 'min');
    drawHandle(xMid, 'mid');
    drawHandle(xMax, 'max');

    // border
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1*dpr;
    ctx.strokeRect(plotX0, plotY0, plotW, plotH);

    ctx.restore();
  }

  function histPickHandle(ds, px, py){
    const canvas = els.hist;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const x = (px - rect.left) * dpr;
    const y = (py - rect.top) * dpr;

    const stats = resolveStats(ds);
    if (!stats) return null;

    const pad = 10*dpr;
    const plotX0 = pad;
    const plotY0 = pad;
    const plotW = canvas.width - 2*pad;
    const plotH = canvas.height - 2*pad;

    const s = getBandSettings(ds, ds.activeBand);
    const domMin = stats.min;
    const domMax = stats.max;
    const minVal = (s.min != null && isFinite(s.min)) ? s.min : stats.p1;
    const maxVal = (s.max != null && isFinite(s.max)) ? s.max : stats.p99;
    const gamma = s.gamma ?? 1;

    const xMin = plotX0 + ((minVal - domMin)/(domMax-domMin)) * plotW;
    const xMax = plotX0 + ((maxVal - domMin)/(domMax-domMin)) * plotW;
    const midT = Math.pow(0.5, 1/Math.max(1e-6, gamma));
    const midVal = minVal + midT*(maxVal-minVal);
    const xMid = plotX0 + ((midVal - domMin)/(domMax-domMin)) * plotW;

    const dist = (a,b) => Math.abs(a-b);
    const tol = 10*dpr;

    if (y < plotY0 || y > plotY0 + plotH + 16*dpr) return null;
    const dMin = dist(x, xMin);
    const dMid = dist(x, xMid);
    const dMax = dist(x, xMax);
    const best = Math.min(dMin,dMid,dMax);
    if (best > tol) return null;
    if (best === dMid) return 'mid';
    if (best === dMin) return 'min';
    return 'max';
  }

  function histXToRaw(ds, clientX){
    const stats = resolveStats(ds);
    if (!stats) return null;

    const canvas = els.hist;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const px = (clientX - rect.left) * dpr;

    const pad = 10*dpr;
    const plotX0 = pad;
    const plotW = canvas.width - 2*pad;

    const t = clamp((px - plotX0) / plotW, 0, 1);
    return stats.min + t * (stats.max - stats.min);
  }

  function applyHistogramDrag(ds, kind, clientX){
    const stats = resolveStats(ds);
    if (!stats) return;
    const raw = histXToRaw(ds, clientX);
    if (raw == null) return;

    const s = getBandSettings(ds, ds.activeBand);
    const minVal = (s.min != null && isFinite(s.min)) ? s.min : stats.p1;
    const maxVal = (s.max != null && isFinite(s.max)) ? s.max : stats.p99;

    if (kind === 'min'){
      const newMin = clamp(raw, stats.min, maxVal);
      s.min = newMin;
    } else if (kind === 'max'){
      const newMax = clamp(raw, minVal, stats.max);
      s.max = newMax;
    } else if (kind === 'mid'){
      const lo = (s.min != null && isFinite(s.min)) ? s.min : stats.p1;
      const hi = (s.max != null && isFinite(s.max)) ? s.max : stats.p99;
      const mid = clamp(raw, lo, hi);
      const t = clamp((mid - lo) / Math.max(1e-12, (hi - lo)), 0.001, 0.999);
      // set gamma so that t^gamma = 0.5  -> gamma = log(0.5)/log(t)
      const gamma = Math.log(0.5) / Math.log(t);
      s.gamma = clamp(gamma, 0.10, 5.0);
      els.slGamma.value = String(s.gamma);
      els.lblGamma.textContent = Number(s.gamma).toFixed(2);
    }

    syncRangeInputsFromSettings(ds, {force:true});
    drawHistogram(ds);
    render({reuseRaster:true});
  }

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

  function clampView(){
    const ds = getActive();
    if (!ds) return;
    // Clamp zoom: don't allow zooming out beyond "fit".
    const minS = minScaleFor(ds);
    ds.view.minScale = minS;
    ds.view.scale = clamp(ds.view.scale, minS, 128);

    const dpr = window.devicePixelRatio || 1;
    const eff = ds.view.scale * dpr;
    const viewW = els.cpuCanvas.width / eff;
    const viewH = els.cpuCanvas.height / eff;

    ds.view.x = clamp(ds.view.x, 0, Math.max(0, ds.meta.samples - viewW));
    ds.view.y = clamp(ds.view.y, 0, Math.max(0, ds.meta.lines - viewH));
  }

  function fitToScreen(){
    const ds = getActive();
    if (!ds) return;
    const rect = els.main.getBoundingClientRect();
    // scale is in CSS pixels per image pixel
    const s = Math.min(rect.width / ds.meta.samples, rect.height / ds.meta.lines);
    updateZoomRange(ds);
    ds.view.scale = s;
    ds.view.x = 0;
    ds.view.y = 0;
    clampView();
    els.zoom.value = String(scaleToSlider(ds.view.scale));
    updateZoomLabel();
    render();
  }

  function screenToImage(sx, sy){
    const ds = getActive();
    const dpr = window.devicePixelRatio || 1;
    const eff = ds.view.scale * dpr;
    return { x: ds.view.x + sx/eff, y: ds.view.y + sy/eff };
  }

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

  function roundRect(ctx, x, y, w, h, r){
    const rr = Math.max(0, Math.min(r, Math.min(w,h)/2));
    ctx.beginPath();
    ctx.moveTo(x+rr, y);
    ctx.arcTo(x+w, y, x+w, y+h, rr);
    ctx.arcTo(x+w, y+h, x, y+h, rr);
    ctx.arcTo(x, y+h, x, y, rr);
    ctx.arcTo(x, y, x+w, y, rr);
    ctx.closePath();
  }

  function formatDistanceUm(um){
    const a = Math.abs(um);
    if (a >= 1000){
      const mm = um / 1000;
      const s = (Math.abs(mm - Math.round(mm)) < 1e-9)
        ? String(Math.round(mm))
        : mm.toFixed(2).replace(/0+$/,'').replace(/\.$/,'');
      return `${s} mm`;
    }
    if (a >= 1){
      const s = (Math.abs(um - Math.round(um)) < 1e-9)
        ? String(Math.round(um))
        : um.toFixed(2).replace(/0+$/,'').replace(/\.$/,'');
      return `${s} µm`;
    }
    const nm = um * 1000;
    const s = (Math.abs(nm - Math.round(nm)) < 1e-9)
      ? String(Math.round(nm))
      : nm.toFixed(2).replace(/0+$/,'').replace(/\.$/,'');
    return `${s} nm`;
  }

  function chooseNiceValue(ideal, toCssLen){
    if (!isFinite(ideal) || ideal <= 0) return null;
    const target = 140;   // CSS px target
    const minOk = 60;
    const maxOk = 240;

    const exp = Math.floor(Math.log10(ideal));
    const mults = [1,2,5];

    let best = null;
    let bestScore = Infinity;

    for (let e = exp-2; e <= exp+2; e++){
      const pow = Math.pow(10, e);
      for (const m of mults){
        const v = m * pow;
        const len = toCssLen(v);
        if (!isFinite(len) || len <= 0) continue;

        const penalty = (len < minOk) ? 500 : ((len > maxOk) ? 500 : 0);
        const score = Math.abs(len - target) + penalty;

        if (score < bestScore){
          bestScore = score;
          best = v;
        }
      }
    }
    return best ?? ideal;
  }

  function drawScaleBar(ds){
    if (!els.chkScale.checked) return;

    const dpr = window.devicePixelRatio || 1;
    const eff = ds.view.scale * dpr;
    const canvasW = els.overlayCanvas.width;
    const canvasH = els.overlayCanvas.height;

    let barImgPx = 0;
    let label = '';
    const sc = ds.meta.scale;

    if (sc && isFinite(sc.umPerPixelX) && sc.umPerPixelX > 0){
      const umPerPx = Number(sc.umPerPixelX);
      const idealUm = 140 * umPerPx / Math.max(1e-9, ds.view.scale);
      const niceUm = chooseNiceValue(idealUm, (um) => (um / umPerPx) * ds.view.scale);
      barImgPx = niceUm / umPerPx;
      label = formatDistanceUm(niceUm);
    } else {
      const idealPx = 140 / Math.max(1e-9, ds.view.scale);
      const nicePx = chooseNiceValue(idealPx, (px) => px * ds.view.scale);
      barImgPx = Math.max(1, Math.round(nicePx));
      label = `${fmtNoGroup(barImgPx)} px`;
    }

    const barDevPx = barImgPx * eff;

    const pad = 12 * dpr;
    const innerPad = 10 * dpr;
    const barYGap = 10 * dpr;
    const fontPx = 12 * dpr;

    overlayCtx.save();
    overlayCtx.setTransform(1,0,0,1,0,0);
    overlayCtx.font = `${fontPx}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
    overlayCtx.textAlign = 'right';
    overlayCtx.textBaseline = 'top';

    const textW = overlayCtx.measureText(label).width;
    const boxW = Math.max(barDevPx, textW) + innerPad*2;
    const boxH = (fontPx + barYGap + 8*dpr + innerPad*2);

    const x1 = canvasW - pad;
    const y1 = canvasH - pad;
    const x0 = x1 - boxW;
    const y0 = y1 - boxH;

    overlayCtx.fillStyle = 'rgba(0,0,0,0.55)';
    overlayCtx.strokeStyle = 'rgba(255,255,255,0.22)';
    overlayCtx.lineWidth = 1 * dpr;
    roundRect(overlayCtx, x0, y0, boxW, boxH, 8*dpr);
    overlayCtx.fill();
    overlayCtx.stroke();

    overlayCtx.fillStyle = 'rgba(255,255,255,0.92)';
    overlayCtx.fillText(label, x1 - innerPad, y0 + innerPad);

    const barX1 = x1 - innerPad;
    const barX0 = barX1 - barDevPx;
    const barY  = y1 - innerPad - 2*dpr;

    overlayCtx.strokeStyle = 'rgba(255,255,255,0.92)';
    overlayCtx.lineWidth = 1 * dpr;
    overlayCtx.beginPath();
    overlayCtx.moveTo(barX0, barY);
    overlayCtx.lineTo(barX1, barY);
    overlayCtx.moveTo(barX0, barY - 6*dpr);
    overlayCtx.lineTo(barX0, barY + 1*dpr);
    overlayCtx.moveTo(barX1, barY - 6*dpr);
    overlayCtx.lineTo(barX1, barY + 1*dpr);
    overlayCtx.stroke();

    overlayCtx.restore();
  }

  function drawOverlays(ds){
    overlayCtx.save();
    overlayCtx.setTransform(1,0,0,1,0,0);
    overlayCtx.clearRect(0,0,els.overlayCanvas.width, els.overlayCanvas.height);

    if (!ds){
      overlayCtx.restore();
      return;
    }

    if (els.chkGrid.checked){
      const dpr = window.devicePixelRatio || 1;
      const eff = ds.view.scale * dpr;
      const canvasW = els.overlayCanvas.width;
      const canvasH = els.overlayCanvas.height;
      const viewW = canvasW / eff;
      const viewH = canvasH / eff;

      const targetPx = 100;
      const imgSpacing = Math.max(1, targetPx / eff);
      const pow = Math.pow(2, Math.round(Math.log2(imgSpacing)));
      const step = pow;

      const startX = Math.floor(ds.view.x / step) * step;
      const endX = ds.view.x + viewW;
      const startY = Math.floor(ds.view.y / step) * step;
      const endY = ds.view.y + viewH;

      overlayCtx.strokeStyle = 'rgba(255,255,255,0.12)';
      overlayCtx.lineWidth = 1 * dpr;
      overlayCtx.beginPath();

      for (let x = startX; x <= endX; x += step){
        const sx = (x - ds.view.x) * eff;
        overlayCtx.moveTo(sx, 0);
        overlayCtx.lineTo(sx, canvasH);
      }
      for (let y = startY; y <= endY; y += step){
        const sy = (y - ds.view.y) * eff;
        overlayCtx.moveTo(0, sy);
        overlayCtx.lineTo(canvasW, sy);
      }
      overlayCtx.stroke();
    }

    drawScaleBar(ds);

    overlayCtx.restore();
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

  async function renderWindowToImageData(ds, band, x0, y0, outW, outH, step){
    let raw;
    if (ds.meta.interleave === 'bip'){
      raw = await readBandWindowBIP(ds.meta, ds.ds, band, x0, y0, outW, outH, step);
    } else {
      raw = await readBandWindow(ds.meta, ds.ds, band, x0, y0, outW, outH, step);
    }
    const f32 = toFloat32(raw);

    const settings = getBandSettings(ds, band);
    const range = resolveDisplayRange(ds, band, f32);
    const params = {
      minVal: range.minVal,
      maxVal: range.maxVal,
      gamma: clamp(settings.gamma ?? 1, 0.10, 5.0),
      gain: clamp(settings.gain ?? 1, 0.0, 4.0),
      contrast: clamp(settings.contrast ?? 1, 0.1, 3.0),
    };

    const img = new ImageData(outW, outH);
    const dst = img.data;
    for (let i=0, j=0; i<f32.length; i++, j+=4){
      const t = tone01(f32[i], params.minVal, params.maxVal, params.gamma, params.gain, params.contrast);
      const u = Math.round(t * 255);
      dst[j]=u; dst[j+1]=u; dst[j+2]=u; dst[j+3]=255;
    }
    return img;
  }

  async function buildThumbnail(ds){
    if (!ds) return;

    const twCss = 220;
    const thCss = 160;
    const dpr = window.devicePixelRatio || 1;
    const tw = Math.floor(twCss * dpr);
    const th = Math.floor(thCss * dpr);
    els.thumb.width = tw;
    els.thumb.height = th;

    const stepX = Math.ceil(ds.meta.samples / tw);
    const stepY = Math.ceil(ds.meta.lines / th);
    const step = Math.max(1, Math.max(stepX, stepY));

    const outW = Math.min(tw, Math.ceil(ds.meta.samples / step));
    const outH = Math.min(th, Math.ceil(ds.meta.lines / step));

    try{
      const img = await renderWindowToImageData(ds, ds.activeBand, 0,0,outW,outH,step);

      thumbCtx.save();
      thumbCtx.imageSmoothingEnabled = false;
      thumbCtx.setTransform(1,0,0,1,0,0);
      thumbCtx.clearRect(0,0,tw,th);

      const scale = Math.min(tw/outW, th/outH);
      const dw = outW*scale;
      const dh = outH*scale;
      const dx = (tw - dw)/2;
      const dy = (th - dh)/2;

      const off = document.createElement('canvas');
      off.width = outW; off.height = outH;
      off.getContext('2d', {alpha:false}).putImageData(img,0,0);
      thumbCtx.drawImage(off, 0,0,outW,outH, dx,dy,dw,dh);
      thumbCtx.restore();

      ds.thumb.base = off;
      ds.thumb.baseW = outW;
      ds.thumb.baseH = outH;

      ds.thumb.ready = true;
      ds.thumb.scale = scale;
      ds.thumb.x0 = dx;
      ds.thumb.y0 = dy;
      ds.thumb.w = dw;
      ds.thumb.h = dh;
      ds.thumb._t = now();
    } catch(e){
      console.warn('thumb error', e);
    }
  }

  function renderThumbnail(){
    const ds = getActive();
    els.thumbWrap.style.display = els.chkThumb.checked ? 'block' : 'none';
    if (!els.chkThumb.checked || !ds) return;

    if (!ds.thumb.ready || (now() - (ds.thumb._t||0)) > 1500){
      buildThumbnail(ds);
      return;
    }

    // redraw base thumbnail (avoid accumulating viewport rectangles)
    if (ds.thumb.base){
      const tw = els.thumb.width;
      const th = els.thumb.height;
      thumbCtx.save();
      thumbCtx.imageSmoothingEnabled = false;
      thumbCtx.setTransform(1,0,0,1,0,0);
      thumbCtx.clearRect(0,0,tw,th);
      thumbCtx.drawImage(ds.thumb.base, 0,0, ds.thumb.baseW, ds.thumb.baseH, ds.thumb.x0, ds.thumb.y0, ds.thumb.w, ds.thumb.h);
      thumbCtx.restore();
    }

    // overlay viewport rectangle
    const dpr = window.devicePixelRatio || 1;
    const eff = ds.view.scale * dpr;
    const viewW = els.cpuCanvas.width / eff;
    const viewH = els.cpuCanvas.height / eff;

    const vx0 = ds.view.x / ds.meta.samples;
    const vy0 = ds.view.y / ds.meta.lines;
    const vx1 = (ds.view.x + viewW) / ds.meta.samples;
    const vy1 = (ds.view.y + viewH) / ds.meta.lines;

    const rx = ds.thumb.x0 + vx0*ds.thumb.w;
    const ry = ds.thumb.y0 + vy0*ds.thumb.h;
    const rw = (vx1-vx0)*ds.thumb.w;
    const rh = (vy1-vy0)*ds.thumb.h;

    thumbCtx.save();
    thumbCtx.setTransform(1,0,0,1,0,0);
    thumbCtx.strokeStyle = 'rgba(106,169,255,.95)';
    thumbCtx.lineWidth = 2*dpr;
    thumbCtx.strokeRect(rx, ry, rw, rh);
    thumbCtx.restore();
  }

  function onThumbClick(ev){
    const ds = getActive();
    if (!ds || !ds.thumb.ready) return;
    const rect = els.thumb.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const sx = (ev.clientX - rect.left) * dpr;
    const sy = (ev.clientY - rect.top) * dpr;

    const nx = (sx - ds.thumb.x0) / ds.thumb.w;
    const ny = (sy - ds.thumb.y0) / ds.thumb.h;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;

    const eff = ds.view.scale * dpr;
    const viewW = els.cpuCanvas.width / eff;
    const viewH = els.cpuCanvas.height / eff;

    ds.view.x = clamp(nx*ds.meta.samples - viewW/2, 0, Math.max(0, ds.meta.samples - viewW));
    ds.view.y = clamp(ny*ds.meta.lines - viewH/2, 0, Math.max(0, ds.meta.lines - viewH));
    render();
  }

  // Magnifier removed (keeps first-load lighter).

  // ========= HUD probe =========

  let probeSeq = 0;
  async function probeValue(ds, ix, iy, band){
    const mySeq = ++probeSeq;
    const v = await probeValueAtBand(ds, ix, iy, band);
    if (mySeq !== probeSeq) return null;
    return v;
  }

  let _hudTimer = null;
  function updateHud(){
    const ds = getActive();
    if (!ds){
      els.hudPos.textContent = 'x: —  y: —';
      els.hudPos.title = '';
      els.hudVal.textContent = 'value: —';
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const img = screenToImage(state.mouse.x * dpr, state.mouse.y * dpr);
    const ix = Math.floor(img.x);
    const iy = Math.floor(img.y);

    const sc = ds.meta.scale;
    if (sc && isFinite(sc.umPerPixelX) && isFinite(sc.umPerPixelY)){
      const xUm = ix * Number(sc.umPerPixelX);
      const yUm = iy * Number(sc.umPerPixelY);
      els.hudPos.textContent = `x: ${fmtUm(xUm)} µm  y: ${fmtUm(yUm)} µm`;
      els.hudPos.title = `px x:${ix}  y:${iy}`;
    } else {
      els.hudPos.textContent = `x: ${ix}  y: ${iy}`;
      els.hudPos.title = '';
    }

    const band = ds.activeBand;
    if (band == null){
      els.hudVal.textContent = 'value: —';
      return;
    }

    if (_hudTimer) clearTimeout(_hudTimer);
    _hudTimer = setTimeout(() => {
      probeValue(ds, ix, iy, band).then(v => {
        if (v === null || v === undefined || !isFinite(v)) {
          els.hudVal.textContent = `value: —`;
        } else {
          const bName = bandLabel(ds, band);
          els.hudVal.textContent = `${bName}: ${v.toFixed(4)}`;
        }
      }).catch(()=>{});
    }, 40);
  }

  
  // ========= Spectrum (z-profile) panel =========

  let specSeq = 0;
  const specState = {open:false, dsId:null, x:0, y:0, xVals:null, yVals:null};

  function showSpectrumPanel(show){
    if (!els.specPanel) return;
    els.specPanel.style.display = show ? 'block' : 'none';
    specState.open = !!show;
  }

  function resizeSpecCanvas(){
    if (!els.specCanvas) return;
    const dpr = window.devicePixelRatio || 1;
    const r = els.specCanvas.getBoundingClientRect();
    const w = Math.max(10, Math.floor(r.width * dpr));
    const h = Math.max(10, Math.floor(r.height * dpr));
    if (els.specCanvas.width !== w || els.specCanvas.height !== h){
      els.specCanvas.width = w;
      els.specCanvas.height = h;
    }
  }

  function formatAxisNumber(v){
    const a = Math.abs(v);
    if (!isFinite(v)) return '—';
    if (a >= 1000) return fmtNoGroup(Math.round(v));
    if (a >= 100) return v.toFixed(1);
    if (a >= 10) return v.toFixed(2);
    return v.toFixed(3);
  }

  function drawSpectrumPlot(ds, xVals, yVals){
    resizeSpecCanvas();
    const c = els.specCanvas;
    const ctx = specCtx;
    const W = c.width, H = c.height;
    const dpr = window.devicePixelRatio || 1;

    // Background
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle = '#0a0d13';
    ctx.fillRect(0,0,W,H);

    const padL = Math.round(52 * dpr);
    const padR = Math.round(12 * dpr);
    const padT = Math.round(12 * dpr);
    const padB = Math.round(30 * dpr);

    const x0 = padL, y0 = padT;
    const x1 = W - padR, y1 = H - padB;
    const plotW = Math.max(1, x1 - x0);
    const plotH = Math.max(1, y1 - y0);

    // Ranges
    let xmin = Infinity, xmax = -Infinity;
    let ymin = Infinity, ymax = -Infinity;
    for (let i=0; i<yVals.length; i++){
      const xv = xVals ? xVals[i] : i;
      const yv = yVals[i];
      if (isFinite(xv)){ xmin = Math.min(xmin, xv); xmax = Math.max(xmax, xv); }
      if (isFinite(yv)){ ymin = Math.min(ymin, yv); ymax = Math.max(ymax, yv); }
    }
    if (!isFinite(xmin) || !isFinite(xmax) || xmin === xmax){
      xmin = 0; xmax = Math.max(1, yVals.length-1);
    }
    if (!isFinite(ymin) || !isFinite(ymax) || ymin === ymax){
      ymin = (isFinite(ymin) ? ymin : 0);
      ymax = ymin + 1;
    }

    // Expand y-range slightly for readability
    const yPad = (ymax - ymin) * 0.06;
    ymin -= yPad;
    ymax += yPad;

    const xToPx = (x) => x0 + (x - xmin) / (xmax - xmin) * plotW;
    const yToPx = (y) => y1 - (y - ymin) / (ymax - ymin) * plotH;

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    const gridN = 4;
    for (let i=0; i<=gridN; i++){
      const yy = y0 + (i/gridN) * plotH;
      ctx.moveTo(x0, yy);
      ctx.lineTo(x1, yy);
    }
    for (let i=0; i<=gridN; i++){
      const xx = x0 + (i/gridN) * plotW;
      ctx.moveTo(xx, y0);
      ctx.lineTo(xx, y1);
    }
    ctx.stroke();

    // Axes
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0, y1);
    ctx.lineTo(x1, y1);
    ctx.stroke();

    // Line (decimate for very large band counts)
    const N = yVals.length;
    const maxPts = 1400;
    const step = Math.max(1, Math.ceil(N / maxPts));

    ctx.strokeStyle = 'rgba(220,235,255,0.95)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    let started = false;
    for (let i=0; i<N; i+=step){
      const xv = xVals ? xVals[i] : i;
      const yv = yVals[i];
      if (!isFinite(xv) || !isFinite(yv)) continue;
      const px = xToPx(xv);
      const py = yToPx(yv);
      if (!started){ ctx.moveTo(px, py); started = true; }
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Selected band marker (current band in the viewer)
    const selBand = (ds && Number.isFinite(ds.activeBand)) ? ds.activeBand : null;
    if (selBand != null && selBand >= 0 && selBand < yVals.length){
      const xv = xVals ? xVals[selBand] : selBand;
      const yv = yVals[selBand];
      if (isFinite(xv)){
        const px = xToPx(xv);
        ctx.save();
        ctx.strokeStyle = 'rgba(106,169,255,0.55)';
        ctx.lineWidth = 1 * dpr;
        ctx.setLineDash([4*dpr, 4*dpr]);
        ctx.beginPath();
        ctx.moveTo(px, y0);
        ctx.lineTo(px, y1);
        ctx.stroke();
        ctx.setLineDash([]);
        if (isFinite(yv)){
          const py = yToPx(yv);
          ctx.fillStyle = 'rgba(106,169,255,0.95)';
          ctx.beginPath();
          ctx.arc(px, py, 3*dpr, 0, Math.PI*2);
          ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.6)';
          ctx.lineWidth = 1 * dpr;
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // Labels (full range on X; avoid "A … B")
    ctx.fillStyle = 'rgba(235,245,255,0.92)';
    ctx.font = `${Math.round(11*dpr)}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    ctx.textBaseline = 'middle';

    // Y ticks (left)
    ctx.textAlign = 'right';
    for (let i=0; i<=4; i++){
      const t = i/4;
      const yv = ymin + (1-t)*(ymax-ymin);
      const py = y0 + t*plotH;
      ctx.fillText(formatAxisNumber(yv), x0 - 8*dpr, py);
    }

    // X ticks (bottom)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i=0; i<=4; i++){
      const t = i/4;
      const xv = xmin + t*(xmax-xmin);
      const px = x0 + t*plotW;
      ctx.fillText(formatAxisNumber(xv), px, y1 + 6*dpr);
    }

    // X axis unit label (small)
    const unit = (ds.meta.wlUnits && String(ds.meta.wlUnits).trim()) ? String(ds.meta.wlUnits).trim() : '';
    const xLabel = xVals ? (unit ? unit : 'Wavelength') : 'Band index';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(200,210,220,0.75)';
    ctx.fillText(xLabel, x1, y1 + 6*dpr);
  }

  async function readSpectrumAtPixel(ds, ix, iy){
    return readSpectrumAtPixelCore(ds, ix, iy, IO_CONCURRENCY);
  }

  function wavelengthArrayOrNull(ds){
    return wavelengthArrayOrNullCore(ds);
  }

  async function openSpectrumAt(ds, ix, iy){
    if (!ds) return;
    specState.dsId = ds.id;
    specState.x = ix; specState.y = iy;

    const mySeq = ++specSeq;

    showSpectrumPanel(true);

    const sc = ds.meta.scale;
    if (sc && isFinite(sc.umPerPixelX) && isFinite(sc.umPerPixelY)){
      const xUm = ix * Number(sc.umPerPixelX);
      const yUm = iy * Number(sc.umPerPixelY);
      els.specSub.textContent = `${ds.name} • x:${fmtUm(xUm)} µm  y:${fmtUm(yUm)} µm  (px ${ix},${iy})`;
    } else {
      els.specSub.textContent = `${ds.name} • px ${ix}, ${iy}`;
    }

    els.specFoot.textContent = 'Loading spectrum…';

    // Wait a frame so layout is ready before sizing the canvas
    await new Promise(r => requestAnimationFrame(r));
    if (mySeq !== specSeq) return;

    try{
      const yVals = await readSpectrumAtPixel(ds, ix, iy);
      if (mySeq !== specSeq) return;

      const xVals = wavelengthArrayOrNull(ds);
      drawSpectrumPlot(ds, xVals, yVals);
      specState.xVals = xVals;
      specState.yVals = yVals;

      // Footer info
      let ymin = Infinity, ymax = -Infinity;
      for (let i=0;i<yVals.length;i++){
        const v = yVals[i];
        if (!isFinite(v)) continue;
        ymin = Math.min(ymin, v);
        ymax = Math.max(ymax, v);
      }
      if (!isFinite(ymin) || !isFinite(ymax)){ ymin = 0; ymax = 0; }
      els.specFoot.textContent = `Bands: ${ds.meta.bands} • Value range: ${formatAxisNumber(ymin)} … ${formatAxisNumber(ymax)} • Double‑click another point to update.`;
      updatePerf();
    } catch (e){
      console.error(e);
      els.specFoot.textContent = 'Failed to read spectrum. See console.';
    }
  }

  function redrawSpectrum(){
    if (!specState.open) return;
    const ds = getActive();
    if (!ds || ds.id !== specState.dsId) return;
    if (!specState.yVals) return;
    drawSpectrumPlot(ds, specState.xVals, specState.yVals);
  }

  function closeSpectrum(){
    specSeq++;
    specState.xVals = null;
    specState.yVals = null;
    showSpectrumPanel(false);
  }

  function exportSpectrumCSV(){
    const ds = getActive();
    if (!ds || !specState.open || ds.id !== specState.dsId || !specState.yVals){
      alert('Spectrum not ready yet. Double‑click in the image to open it first.');
      return;
    }

    const yVals = specState.yVals;
    const xVals = specState.xVals;

    const unit = (ds.meta.wlUnits && String(ds.meta.wlUnits).trim()) ? String(ds.meta.wlUnits).trim() : '';
    const xLabel = xVals ? (unit ? unit : 'wavelength') : 'band_index';

    const lines = [];
    lines.push(`# dataset: ${ds.name}`);
    lines.push(`# pixel: ${specState.x},${specState.y}`);
    if (ds.meta.scale && isFinite(ds.meta.scale.umPerPixelX) && isFinite(ds.meta.scale.umPerPixelY)){
      const xUm = specState.x * Number(ds.meta.scale.umPerPixelX);
      const yUm = specState.y * Number(ds.meta.scale.umPerPixelY);
      lines.push(`# physical_um: ${fmtUm(xUm)},${fmtUm(yUm)}`);
    }
    lines.push(`# bands: ${ds.meta.bands}`);
    if (ds.activeBand != null) lines.push(`# active_band: ${ds.activeBand}`);

    const cols = ['band_index','band_name'];
    if (xVals) cols.push(xLabel);
    cols.push('value');
    lines.push(cols.join(','));

    const names = Array.isArray(ds.meta.bandNames) ? ds.meta.bandNames : null;
    for (let b=0; b<yVals.length; b++){
      const name = (names && names[b] != null) ? String(names[b]).trim().replace(/\s+/g,' ') : '';
      const row = [String(b), '"' + name.replace(/"/g,'""') + '"'];
      if (xVals) row.push(String(xVals[b]));
      row.push(String(yVals[b]));
      lines.push(row.join(','));
    }

    const csv = lines.join('\n') + '\n';
    const base = `${ds.name}_spectrum_${specState.x}_${specState.y}`;
    downloadBlob(new Blob([csv], {type:'text/csv'}), `${sanitizeFilePart(base)}.csv`);
  }


// ========= Mouse interaction =========

  function updateSelectionRect(){
    const x0 = Math.min(state.selection.x0, state.selection.x1);
    const y0 = Math.min(state.selection.y0, state.selection.y1);
    const x1 = Math.max(state.selection.x0, state.selection.x1);
    const y1 = Math.max(state.selection.y0, state.selection.y1);

    els.selRect.style.display = 'block';
    els.selRect.style.left = x0 + 'px';
    els.selRect.style.top = y0 + 'px';
    els.selRect.style.width = Math.max(1, x1-x0) + 'px';
    els.selRect.style.height = Math.max(1, y1-y0) + 'px';
  }

  function clearSelection(){
    state.selection.drawing = false;
    state.selection.imgRect = null;
    els.selRect.style.display = 'none';
  }

  function finalizeSelection(){
    const ds = getActive();
    if (!ds) return;

    const dpr = window.devicePixelRatio || 1;
    const x0 = Math.min(state.selection.x0, state.selection.x1) * dpr;
    const y0 = Math.min(state.selection.y0, state.selection.y1) * dpr;
    const x1 = Math.max(state.selection.x0, state.selection.x1) * dpr;
    const y1 = Math.max(state.selection.y0, state.selection.y1) * dpr;

    const a = screenToImage(x0, y0);
    const b = screenToImage(x1, y1);

    const ix0 = Math.floor(Math.min(a.x, b.x));
    const iy0 = Math.floor(Math.min(a.y, b.y));
    const ix1 = Math.ceil(Math.max(a.x, b.x));
    const iy1 = Math.ceil(Math.max(a.y, b.y));

    state.selection.imgRect = {
      x0: clamp(ix0, 0, ds.meta.samples),
      y0: clamp(iy0, 0, ds.meta.lines),
      x1: clamp(ix1, 0, ds.meta.samples),
      y1: clamp(iy1, 0, ds.meta.lines),
    };
  }

  function onPointerDown(ev){
    const ds = getActive();
    if (!ds) return;
    const rect = els.main.getBoundingClientRect();
    state.mouse.dragging = true;
    state.mouse.lastX = ev.clientX - rect.left;
    state.mouse.lastY = ev.clientY - rect.top;

    if (state.selection.enabled){
      state.selection.drawing = true;
      state.selection.x0 = state.mouse.lastX;
      state.selection.y0 = state.mouse.lastY;
      state.selection.x1 = state.mouse.lastX;
      state.selection.y1 = state.mouse.lastY;
      updateSelectionRect();
    }
  }

  function onPointerMove(ev){
    const ds = getActive();
    const rect = els.main.getBoundingClientRect();
    state.mouse.in = true;
    state.mouse.x = ev.clientX - rect.left;
    state.mouse.y = ev.clientY - rect.top;

    if (ds && state.mouse.dragging && !state.selection.drawing){
      const dx = state.mouse.x - state.mouse.lastX;
      const dy = state.mouse.y - state.mouse.lastY;
      state.mouse.lastX = state.mouse.x;
      state.mouse.lastY = state.mouse.y;

      ds.view.x -= dx / ds.view.scale;
      ds.view.y -= dy / ds.view.scale;
      clampView();
      render();
    }

    if (state.selection.drawing){
      state.selection.x1 = state.mouse.x;
      state.selection.y1 = state.mouse.y;
      updateSelectionRect();
    }

    updateHud();
  }

  function onPointerUp(){
    state.mouse.dragging = false;
    if (state.selection.drawing){
      state.selection.drawing = false;
      finalizeSelection();
      setStatus('ready','ok');
    }
  }

  function onPointerLeave(){
    state.mouse.in = false;
    state.mouse.dragging = false;
  }

  function zoomAt(factor, sx, sy){
    const ds = getActive();
    if (!ds) return;

    const before = screenToImage(sx, sy);
    const minS = minScaleFor(ds);
    ds.view.scale = clamp(ds.view.scale * factor, minS, 128);
    const after = screenToImage(sx, sy);

    ds.view.x += (before.x - after.x);
    ds.view.y += (before.y - after.y);

    clampView();
    els.zoom.value = String(scaleToSlider(ds.view.scale));
    updateZoomLabel();
    render();
  }

  function onWheel(ev){
    const ds = getActive();
    if (!ds) return;
    ev.preventDefault();
    const rect = els.main.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const sx = (ev.clientX - rect.left) * dpr;
    const sy = (ev.clientY - rect.top) * dpr;

    const factor = ev.deltaY < 0 ? 1.25 : 0.8;
    zoomAt(factor, sx, sy);
  }

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

  function sanitizeFilePart(s){ return exportService.sanitizeFilePart(s); }
  function viewRect(ds){ return exportService.viewRect(ds); }
  function wholeRect(ds){ return exportService.wholeRect(ds); }
  function clampRect(ds, rect){ return exportService.clampRect(ds, rect); }
  function resolveExportRect(ds, scope){ return exportService.resolveExportRect(ds, scope); }

  function openExportDialog(kind){
    const ds = getActive();
    if (!ds || ds.activeBand == null){
      alert('Please select a dataset and band first.');
      return;
    }
    state.exportKind = kind;

    const hasSel = !!state.selection.imgRect;
    els.expTitle.textContent = `Export ${kind.toUpperCase()}`;

    const b = ds.activeBand;
    els.expInfo.textContent = `${ds.name} • ${bandLabel(ds, b)} (band ${b})`;

    // Raw is TIFF-only.
    if (kind === 'png'){
      els.expModeRaw.disabled = true;
      els.expModeRendered.checked = true;
    } else {
      els.expModeRaw.disabled = false;
      els.expModeRaw.checked = true;
    }

    els.expLblRawSel.textContent = hasSel ? 'Selection stack (all bands)' : 'Current view stack (all bands)';
    els.expLblRenSel.textContent = hasSel ? 'Selection' : 'Selection (none)';
    els.expRenScopeSel.disabled = !hasSel;
    if (hasSel) els.expRenScopeSel.checked = true;
    else els.expRenScopeView.checked = true;

    updateExportDialogUI();
    try { els.exportDlg.showModal(); }
    catch { els.exportDlg.open = true; }
  }

  function updateExportDialogUI(){
    const kind = state.exportKind;
    // Force rendered mode for PNG.
    if (kind === 'png' && els.expModeRaw.checked){
      els.expModeRendered.checked = true;
    }
    const mode = (els.expModeRaw.checked && kind === 'tiff') ? 'raw' : 'rendered';
    els.expRawOptions.style.display = (mode === 'raw') ? 'block' : 'none';
    els.expRenderedOptions.style.display = (mode === 'rendered') ? 'block' : 'none';
    updateExportEstimate();
  }

  function updateExportEstimate(){
    const ds = getActive();
    if (!ds){
      els.expEstimate.textContent = 'Estimated output: —';
      els.expNote.textContent = '—';
      els.expWarning.style.display = 'none';
      return;
    }

    const kind = state.exportKind;
    const mode = (els.expModeRaw.checked && kind === 'tiff') ? 'raw' : 'rendered';

    let rect;
    let estBytes = 0;

    if (mode === 'raw'){
      const scope = els.expRawScopeWhole.checked ? 'whole' : 'sel';
      rect = resolveExportRect(ds, scope);
      const bpp = ds.meta.dataTypeInfo.bytes;
      estBytes = rect.w * rect.h * ds.meta.bands * bpp;
      els.expNote.innerHTML = `Raw stack (all bands): <b>${rect.w}×${rect.h}</b> × <b>${ds.meta.bands}</b> (${ds.meta.dataTypeInfo.name}), uncompressed TIFF.`;
    } else {
      const scope = els.expRenScopeWhole.checked ? 'whole' : (els.expRenScopeSel.checked ? 'sel' : 'view');
      rect = resolveExportRect(ds, scope);
      estBytes = rect.w * rect.h * 4;
      els.expNote.innerHTML = `Rendered view: <b>${rect.w}×${rect.h}</b> pixels from the current band.`;
      if (kind === 'png'){
        els.expNote.innerHTML += ` <span class="badge">PNG is rendered only</span> (use TIFF for raw).`;
      }
    }

    els.expEstimate.textContent = `Estimated output: ${humanBytes(estBytes)}`;
    const warn = estBytes > (512 * 1024 * 1024) || (rect && rect.w * rect.h > 20_000_000);
    els.expWarning.style.display = warn ? 'inline-flex' : 'none';
  }

  async function runExportFromDialog(){ await exportService.runExportFromDialog(); }
  async function exportRendered(ds, kind, rect){ await exportService.exportRendered(ds, kind, rect); }
  async function exportRawStackTIFF(ds, rect){ await exportService.exportRawStackTIFF(ds, rect); }

  // ========= Close dataset =========

  function closeDataset(id){
    const idx = state.datasets.findIndex(d => d.id === id);
    if (idx === -1) return;
    const ds = state.datasets[idx];

    if (specState.open && specState.dsId === id) closeSpectrum();

    // dispose caches
    try{ if (ds.pyramid) disposePyramid(ds.pyramid); }catch(_){}
    try{ ds.ds.close(); }catch(_){}

    state.datasets.splice(idx, 1);

    if (state.activeId === id){
      state.activeId = state.datasets[0]?.id || null;
    }

    recomputeCacheBudgets();

    rebuildDatasetList();
    rebuildBandTree();
    updateMetaUI();
    updatePerf();
    updateDisplayUI(true);
    clearSelection();
    render();
  }

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
    if (specState.open) redrawSpectrum();
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


  els.main.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  els.main.addEventListener('pointerleave', onPointerLeave);
  els.main.addEventListener('wheel', onWheel, {passive:false});

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

