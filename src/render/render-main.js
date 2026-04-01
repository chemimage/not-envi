import { clamp } from "../core/utils.js";
import { resolveRasterSampling } from "./raster-geometry.js";
import { resolveDisplayPanelBand } from "../app/display-panels.js";
import {
  getThreeBandDisplayMode,
  isThreeBandColorMode,
  resolveThreeBandChannelOrder
} from "../app/three-band-display.js";

export function createRenderer(deps) {
  const {
    state,
    els,
    now,
    setStatus,
    getActive,
    getActivePanel,
    getVisibleDatasetPanels,
    getDisplayCompositionMode,
    getPanelLayoutDevice,
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
    ensureViewHistogram
  } = deps;

  function listVisiblePanels() {
    if (typeof getVisibleDatasetPanels === "function") {
      const visible = getVisibleDatasetPanels();
      if (Array.isArray(visible)) return visible;
    }
    const ds = getActive();
    if (!ds) return [];
    return [{ panel: (typeof getActivePanel === "function" ? (getActivePanel() || { slot: 1 }) : { slot: 1 }), dataset: ds }];
  }

  function compositionMode() {
    return (typeof getDisplayCompositionMode === "function")
      ? (getDisplayCompositionMode() || "split")
      : "split";
  }

  function isOverlayComposition(visible = null) {
    const entries = Array.isArray(visible) ? visible : listVisiblePanels();
    return compositionMode() === "overlay" && entries.length > 1;
  }

  function activePanelInfo() {
    if (typeof getActivePanel === "function") return getActivePanel() || null;
    const visible = listVisiblePanels();
    return visible[0]?.panel || null;
  }

  function panelLayout() {
    if (typeof getPanelLayoutDevice === "function") {
      const layout = getPanelLayoutDevice();
      if (Array.isArray(layout)) return layout;
    }
    return [{ slot: 1, x: 0, y: 0, w: els.cpuCanvas.width || 1, h: els.cpuCanvas.height || 1 }];
  }

  function overlayColorForSlot(slot) {
    return Number(slot) === 2 ? "rgb(251 146 60)" : "rgb(103 232 249)";
  }

  function resolvePanelBand(panel, ds) {
    return resolveDisplayPanelBand(panel, ds);
  }

  const floatScratchPool = new Map();

  function acquireFloatScratch(length) {
    const size = Math.max(0, Math.floor(Number(length) || 0));
    if (!size) return new Float32Array(0);
    const bucket = floatScratchPool.get(size);
    if (bucket?.length) return bucket.pop();
    return new Float32Array(size);
  }

  function releaseFloatScratch(arr) {
    if (!(arr instanceof Float32Array) || !arr.length) return;
    const size = arr.length;
    let bucket = floatScratchPool.get(size);
    if (!bucket) {
      bucket = [];
      floatScratchPool.set(size, bucket);
    }
    if (bucket.length < 4) bucket.push(arr);
  }

  async function readRasterDirect(ds, band, eff, viewportW, viewportH) {
    const geom = resolveRasterSampling(ds, viewportW, viewportH, eff);
    const {
      step,
      rasterW,
      rasterH,
      colStart,
      rowStart,
      validW,
      validH,
      srcX0,
      srcY0
    } = geom;
    const out = new Float32Array(rasterW * rasterH);
    const fullCoverage = colStart === 0 && rowStart === 0 && validW === rasterW && validH === rasterH;
    if (!fullCoverage) out.fill(Number.NaN);

    if (validW > 0 && validH > 0) {
      const scratch = fullCoverage ? out : acquireFloatScratch(validW * validH);
      try {
        let raw;
        if (ds.meta.interleave === "bip") {
          raw = await readBandWindowBIP(ds.meta, ds.ds, band, srcX0, srcY0, validW, validH, step, scratch);
        } else {
          raw = await readBandWindow(ds.meta, ds.ds, band, srcX0, srcY0, validW, validH, step, scratch);
        }
        const src = raw === scratch ? scratch : toFloat32(raw);
        if (fullCoverage) {
          if (src !== out) out.set(src.subarray(0, out.length), 0);
        } else {
          for (let r = 0; r < validH; r += 1) {
            const srcOff = r * validW;
            const dstOff = (rowStart + r) * rasterW + colStart;
            out.set(src.subarray(srcOff, srcOff + validW), dstOff);
          }
        }
      } finally {
        if (!fullCoverage) releaseFloatScratch(scratch);
      }
    }

    return { band, dataF32: out, w: rasterW, h: rasterH, source: "direct", level: 0, step, x0: ds.view.x, y0: ds.view.y };
  }

  function viewExtendsOutside(ds, eff, viewportW, viewportH) {
    const viewW = viewportW / eff;
    const viewH = viewportH / eff;
    return (
      ds.view.x < 0
      || ds.view.y < 0
      || (ds.view.x + viewW) > ds.meta.samples
      || (ds.view.y + viewH) > ds.meta.lines
    );
  }

  async function readRasterForBand(ds, band, eff, viewportW, viewportH) {
    let raster = null;
    if (!viewExtendsOutside(ds, eff, viewportW, viewportH)) {
      raster = await tryRasterFromPyramid(ds, band, eff, viewportW, viewportH);
    }
    if (!raster) {
      setStatus("reading…", "warn");
      raster = await readRasterDirect(ds, band, eff, viewportW, viewportH);
    }
    return raster;
  }

  async function readCompositeRaster(ds, eff, viewportW, viewportH) {
    const mode = getThreeBandDisplayMode(ds);
    const sourceBands = [0, 1, 2];
    const rasters = await Promise.all(sourceBands.map((band) => readRasterForBand(ds, band, eff, viewportW, viewportH)));
    const rasterByBand = new Map(rasters.map((raster) => [raster.band, raster]));
    return {
      mode,
      channelBands: resolveThreeBandChannelOrder(mode),
      rasterByBand,
      partial: rasters.some((raster) => !!raster?.partial),
      approximate: rasters.some((raster) => !!raster?.approximate)
    };
  }

  function resizeCanvases() {
    const dpr = window.devicePixelRatio || 1;
    const rect = els.main.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (els.cpuCanvas.width !== w) els.cpuCanvas.width = w;
    if (els.cpuCanvas.height !== h) els.cpuCanvas.height = h;
    if (els.overlayCanvas.width !== w) els.overlayCanvas.width = w;
    if (els.overlayCanvas.height !== h) els.overlayCanvas.height = h;
  }

  function renderModeKey(ds, band, colorMode, colorRenderMode = null) {
    if (colorMode) return `color:${colorRenderMode || getThreeBandDisplayMode(ds)}`;
    return `gray:${band}`;
  }

  function cloneCanvasImage(sourceCanvas) {
    if (!sourceCanvas) return null;
    if (typeof document === "undefined" || typeof document.createElement !== "function") return sourceCanvas;
    if (typeof navigator !== "undefined" && /jsdom/i.test(String(navigator.userAgent || ""))) {
      return sourceCanvas;
    }
    try {
      const copy = document.createElement("canvas");
      copy.width = Math.max(1, sourceCanvas.width || 1);
      copy.height = Math.max(1, sourceCanvas.height || 1);
      const ctx = copy.getContext("2d", { alpha: false });
      if (ctx && typeof ctx.drawImage === "function") ctx.drawImage(sourceCanvas, 0, 0);
      return copy;
    } catch (_err) {
      return sourceCanvas;
    }
  }

  function tintCanvas(sourceCanvas, color) {
    if (!sourceCanvas) return null;
    if (typeof document === "undefined" || typeof document.createElement !== "function") return sourceCanvas;
    try {
      const tinted = document.createElement("canvas");
      tinted.width = Math.max(1, sourceCanvas.width || 1);
      tinted.height = Math.max(1, sourceCanvas.height || 1);
      const ctx = tinted.getContext("2d", { alpha: true });
      if (!ctx) return sourceCanvas;
      ctx.drawImage(sourceCanvas, 0, 0);
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, tinted.width, tinted.height);
      ctx.globalCompositeOperation = "source-over";
      return tinted;
    } catch (_err) {
      return sourceCanvas;
    }
  }

  function getFrameMap(ds) {
    if (!ds.lastScreenFrames || typeof ds.lastScreenFrames.get !== "function") {
      ds.lastScreenFrames = new Map();
    }
    if (ds.lastScreenFrame && !ds.lastScreenFrames.has(1)) {
      ds.lastScreenFrames.set(1, ds.lastScreenFrame);
    }
    return ds.lastScreenFrames;
  }

  function getRasterMap(ds) {
    if (!ds.lastRastersByPanel || typeof ds.lastRastersByPanel.get !== "function") {
      ds.lastRastersByPanel = new Map();
    }
    return ds.lastRastersByPanel;
  }

  function getCompositeRasterMap(ds) {
    if (!ds.lastCompositeRastersByPanel || typeof ds.lastCompositeRastersByPanel.get !== "function") {
      ds.lastCompositeRastersByPanel = new Map();
    }
    return ds.lastCompositeRastersByPanel;
  }

  function updatePanelRasterCache(ds, panelSlot, raster = null, compositeRaster = null) {
    if (!ds) return;
    const slot = Number(panelSlot) || 1;
    const rasterMap = getRasterMap(ds);
    const compositeMap = getCompositeRasterMap(ds);
    if (raster) rasterMap.set(slot, raster);
    else rasterMap.delete(slot);
    if (compositeRaster) compositeMap.set(slot, compositeRaster);
    else compositeMap.delete(slot);
  }

  function isStableRaster(raster) {
    return !!raster && !raster.partial && !raster.approximate;
  }

  function isStableCompositeRaster(compositeRaster) {
    return !!compositeRaster && !compositeRaster.partial && !compositeRaster.approximate;
  }

  function updateScreenPreviewCache(ds, panelSlot, modeKey, eff, sourceCanvas) {
    if (!ds || !sourceCanvas) return;
    const frame = {
      modeKey,
      eff,
      viewX: ds.view.x,
      viewY: ds.view.y,
      canvas: cloneCanvasImage(sourceCanvas)
    };
    getFrameMap(ds).set(Number(panelSlot) || 1, frame);
    ds.lastScreenFrame = frame;
  }

  function drawCachedScreenPreview(ds, panelSlot, modeKey, eff, viewport) {
    const frame = getFrameMap(ds).get(Number(panelSlot) || 1);
    if (!frame || frame.modeKey !== modeKey || !frame.canvas) return false;
    const prevEff = Math.max(1e-9, Number(frame.eff) || 0);
    const scale = eff / prevEff;
    if (!Number.isFinite(scale) || scale <= 0) return false;

    const cpuCtx = els.cpuCanvas.getContext("2d", { alpha: false });
    const dx = (Number(viewport.x) || 0) + (((Number(frame.viewX) || 0) - ds.view.x) * eff);
    const dy = (Number(viewport.y) || 0) + (((Number(frame.viewY) || 0) - ds.view.y) * eff);

    cpuCtx.save();
    cpuCtx.setTransform(1, 0, 0, 1, 0, 0);
    cpuCtx.imageSmoothingEnabled = false;
    cpuCtx.fillStyle = "#000";
    cpuCtx.fillRect(Number(viewport.x) || 0, Number(viewport.y) || 0, Math.max(1, Number(viewport.w) || 1), Math.max(1, Number(viewport.h) || 1));
    cpuCtx.drawImage(
      frame.canvas,
      dx,
      dy,
      frame.canvas.width * scale,
      frame.canvas.height * scale
    );
    cpuCtx.restore();

    if (els.cpuCanvas?.style) els.cpuCanvas.style.display = "block";
    if (els.gpuCanvas?.style) els.gpuCanvas.style.display = "none";
    return true;
  }

  function drawOverlayCachedPreview(entries, layout) {
    const cpuCtx = els.cpuCanvas.getContext("2d", { alpha: false });
    const dpr = window.devicePixelRatio || 1;
    let drewAny = false;
    let clearedViewport = false;

    for (const entry of entries) {
      const { panel, dataset: ds } = entry;
      const viewport = layout.find((rect) => Number(rect.slot) === Number(panel.slot));
      const band = resolvePanelBand(panel, ds);
      if (!viewport || !ds || band == null) continue;

      const prevView = ds.view;
      ds.view = panel.view || prevView;
      try {
        clampView(panel.slot, ds);
        const eff = ds.view.scale * dpr;
        const modeKey = renderModeKey(ds, band, false, null);
        const frame = getFrameMap(ds).get(Number(panel.slot) || 1);
        if (!frame || frame.modeKey !== modeKey || !frame.canvas) continue;

        const prevEff = Math.max(1e-9, Number(frame.eff) || 0);
        const scale = eff / prevEff;
        if (!Number.isFinite(scale) || scale <= 0) continue;
        const tinted = tintCanvas(frame.canvas, overlayColorForSlot(panel.slot));
        const dx = (Number(viewport.x) || 0) + (((Number(frame.viewX) || 0) - ds.view.x) * eff);
        const dy = (Number(viewport.y) || 0) + (((Number(frame.viewY) || 0) - ds.view.y) * eff);

        cpuCtx.save();
        cpuCtx.setTransform(1, 0, 0, 1, 0, 0);
        cpuCtx.imageSmoothingEnabled = false;
        cpuCtx.globalCompositeOperation = clearedViewport ? "lighter" : "source-over";
        if (!clearedViewport) {
          cpuCtx.fillStyle = "#000";
          cpuCtx.fillRect(Number(viewport.x) || 0, Number(viewport.y) || 0, Math.max(1, Number(viewport.w) || 1), Math.max(1, Number(viewport.h) || 1));
          clearedViewport = true;
        }
        cpuCtx.drawImage(
          tinted,
          dx,
          dy,
          tinted.width * scale,
          tinted.height * scale
        );
        cpuCtx.restore();
        drewAny = true;
      } finally {
        ds.view = prevView;
      }
    }

    if (drewAny) {
      if (els.cpuCanvas?.style) els.cpuCanvas.style.display = "block";
      if (els.gpuCanvas?.style) els.gpuCanvas.style.display = "none";
    }
    return drewAny;
  }

  async function withPanelView(ds, panel, fn) {
    if (!ds || !panel) return fn();
    const prevView = ds.view;
    ds.view = panel.view || prevView;
    try {
      return await fn();
    } finally {
      ds.view = prevView;
    }
  }

  function clearBaseCanvases() {
    const gpuCtx = (els.gpuCanvas && typeof els.gpuCanvas.getContext === "function")
      ? els.gpuCanvas.getContext("2d", { alpha: false })
      : null;
    const cpuCtx = els.cpuCanvas.getContext("2d", { alpha: false });
    const overlayCtx = els.overlayCanvas.getContext("2d", { alpha: true });
    if (els.gpuCanvas && els.gpuCanvas.style) els.gpuCanvas.style.display = "none";
    if (els.cpuCanvas && els.cpuCanvas.style) els.cpuCanvas.style.display = "block";
    if (gpuCtx) {
      gpuCtx.setTransform(1, 0, 0, 1, 0, 0);
      gpuCtx.fillStyle = "#000";
      gpuCtx.fillRect(0, 0, els.gpuCanvas.width, els.gpuCanvas.height);
    }
    cpuCtx.setTransform(1, 0, 0, 1, 0, 0);
    cpuCtx.fillStyle = "#000";
    cpuCtx.fillRect(0, 0, els.cpuCanvas.width, els.cpuCanvas.height);
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    overlayCtx.clearRect(0, 0, els.overlayCanvas.width, els.overlayCanvas.height);
  }

  function scheduleRender() {
    if (state._rafPending) return;
    state._rafPending = true;
    requestAnimationFrame(() => {
      state._rafPending = false;
      render();
    });
  }

  let previewRafPending = false;

  function renderPreview() {
    const visible = listVisiblePanels();
    if (!visible.length) {
      resizeCanvases();
      clearBaseCanvases();
      return false;
    }

    resizeCanvases();
    clearBaseCanvases();
    const layout = panelLayout();
    if (isOverlayComposition(visible)) {
      const drew = drawOverlayCachedPreview(visible, layout);
      renderThumbnail();
      updateHud();
      drawOverlays();
      return drew;
    }
    let drewAny = false;
    const dpr = window.devicePixelRatio || 1;
    for (const entry of visible) {
      const { panel, dataset: ds } = entry;
      const viewport = layout.find((rect) => Number(rect.slot) === Number(panel.slot));
      const band = resolvePanelBand(panel, ds);
      if (!viewport || !ds || band == null) continue;
      const prevView = ds.view;
      ds.view = panel.view || prevView;
      try {
        clampView(panel.slot, ds);
        const eff = ds.view.scale * dpr;
        const colorMode = isThreeBandColorMode(ds);
        const colorRenderMode = colorMode ? getThreeBandDisplayMode(ds) : null;
        const modeKey = renderModeKey(ds, band, colorMode, colorRenderMode);
        if (drawCachedScreenPreview(ds, panel.slot, modeKey, eff, viewport)) drewAny = true;
      } finally {
        ds.view = prevView;
      }
    }
    renderThumbnail();
    updateHud();
    drawOverlays();
    return drewAny;
  }

  function schedulePreview() {
    if (previewRafPending) return;
    previewRafPending = true;
    requestAnimationFrame(() => {
      previewRafPending = false;
      renderPreview();
    });
  }

  async function renderSinglePanel(ds, panel, opts = {}) {
    const seq = ++state.renderSeq;
    resizeCanvases();
    const dpr = window.devicePixelRatio || 1;
    const colorMode = isThreeBandColorMode(ds);
    const colorRenderMode = colorMode ? getThreeBandDisplayMode(ds) : null;
    const band = resolvePanelBand(panel, ds);
    if (band == null) return;
    const modeKey = renderModeKey(ds, band, colorMode, colorRenderMode);

    let useGPU = false;
    if (!colorMode && gpuSupported) {
      const ok = await initWebGPU();
      if (ok) useGPU = true;
    }

    clampView(panel?.slot, ds);
    const eff = ds.view.scale * dpr;
    const settings = getBandSettings(ds, band);

    const reuse = !!opts.reuseRaster;
    let raster = null;
    let compositeRaster = null;
    const reuseComposite = reuse && ds.lastCompositeRaster && ds.lastCompositeRaster.mode === colorRenderMode;
    const reuseGray = reuse && ds.lastRaster && ds.lastRaster.band === band;
    const needsFreshRaster = colorMode ? !reuseComposite : !reuseGray;
    if (needsFreshRaster && drawCachedScreenPreview(ds, panel?.slot || 1, modeKey, eff, { x: 0, y: 0, w: els.cpuCanvas.width, h: els.cpuCanvas.height })) {
      drawOverlays();
      updateHud();
    }
    if (colorMode) {
      if (reuseComposite) {
        compositeRaster = ds.lastCompositeRaster;
      } else {
        compositeRaster = await readCompositeRaster(ds, eff, els.cpuCanvas.width, els.cpuCanvas.height);
      }
      raster = compositeRaster.rasterByBand.get(band) || compositeRaster.rasterByBand.get(0) || null;
    } else {
      if (reuseGray) {
        raster = ds.lastRaster;
      } else {
        raster = await readRasterForBand(ds, band, eff, els.cpuCanvas.width, els.cpuCanvas.height);
      }
    }
    if (seq !== state.renderSeq) return;

    const stableComposite = colorMode ? isStableCompositeRaster(compositeRaster) : false;
    const stableRaster = colorMode ? stableComposite : isStableRaster(raster);
    if (colorMode) {
      ds.lastCompositeRaster = stableComposite ? compositeRaster : null;
      ds.lastRaster = stableRaster ? raster : null;
    } else {
      ds.lastRaster = stableRaster ? raster : null;
    }

    const range = resolveDisplayRange(ds, band, raster.dataF32);
    const params = {
      minVal: range.minVal,
      maxVal: range.maxVal,
      brightness: clamp(settings.brightness ?? 0, -1, 1),
      gain: clamp(settings.gain ?? 1, 0.0, 4.0),
      contrast: clamp(settings.contrast ?? 1, 0.1, 3.0)
    };
    syncRangeInputsFromSettings(ds);

    try {
      const t0 = now();
      if (els.gpuCanvas?.style) els.gpuCanvas.style.display = useGPU ? "block" : "none";
      if (els.cpuCanvas?.style) els.cpuCanvas.style.display = useGPU ? "none" : "block";
      let renderedCanvas = null;
      if (colorMode) {
        const channelRasters = compositeRaster.channelBands.map((channelBand) => compositeRaster.rasterByBand.get(channelBand));
        const channelParams = compositeRaster.channelBands.map((channelBand) => {
          const channelSettings = getBandSettings(ds, channelBand);
          const channelRange = resolveDisplayRange(ds, channelBand, compositeRaster.rasterByBand.get(channelBand).dataF32);
          return {
            minVal: channelRange.minVal,
            maxVal: channelRange.maxVal,
            brightness: clamp(channelSettings.brightness ?? 0, -1, 1),
            gain: clamp(channelSettings.gain ?? 1, 0.0, 4.0),
            contrast: clamp(channelSettings.contrast ?? 1, 0.1, 3.0)
          };
        });
        renderedCanvas = cpuRenderColor(channelRasters, channelParams);
      } else if (useGPU) {
        gpuRender(raster.dataF32, raster.w, raster.h, params);
        renderedCanvas = els.gpuCanvas;
      } else {
        renderedCanvas = cpuRenderGray(raster.dataF32, raster.w, raster.h, params);
      }
      if (stableRaster || stableComposite) {
        updateScreenPreviewCache(ds, panel?.slot || 1, modeKey, eff, renderedCanvas || (useGPU ? els.gpuCanvas : els.cpuCanvas));
        updatePanelRasterCache(ds, panel?.slot || 1, raster, compositeRaster);
      } else {
        updatePanelRasterCache(ds, panel?.slot || 1, null, null);
      }

      state.lastRenderMs = now() - t0;
      setStatus("ready", "ok");
      renderThumbnail();
      updateHud();
      drawOverlays();
      updatePerf();

      if (state.histMode === "view") {
        if (state.histViewDebounce) clearTimeout(state.histViewDebounce);
        state.histViewDebounce = setTimeout(() => {
          const d = getActive();
          if (!d || d.id !== ds.id) return;
          ensureViewHistogram(d);
        }, 180);
      }
    } catch (e) {
      console.error(e);
      if (seq !== state.renderSeq) return;
      setStatus("render error", "err");
    }
  }

  async function renderMultiPanel(opts = {}, visible = []) {
    const seq = ++state.renderSeq;
    resizeCanvases();
    clearBaseCanvases();
    const layout = panelLayout();
    const cpuCtx = els.cpuCanvas.getContext("2d", { alpha: false });
    const dpr = window.devicePixelRatio || 1;
    const activeSlot = Number(activePanelInfo()?.slot) || Number(visible[0]?.panel?.slot) || 1;
    const ordered = visible.slice().sort((a, b) => {
      if (Number(a.panel.slot) === activeSlot) return 1;
      if (Number(b.panel.slot) === activeSlot) return -1;
      return Number(a.panel.slot) - Number(b.panel.slot);
    });
    const t0 = now();

    try {
      for (const entry of ordered) {
        if (seq !== state.renderSeq) return;
        const { panel, dataset: ds } = entry;
        const viewport = layout.find((rect) => Number(rect.slot) === Number(panel.slot));
        const band = resolvePanelBand(panel, ds);
        if (!viewport || !ds || band == null) continue;
        await withPanelView(ds, panel, async () => {
          clampView(panel.slot, ds);
          const eff = ds.view.scale * dpr;
          const colorMode = isThreeBandColorMode(ds);
          const colorRenderMode = colorMode ? getThreeBandDisplayMode(ds) : null;
          const modeKey = renderModeKey(ds, band, colorMode, colorRenderMode);

          let raster = null;
          let compositeRaster = null;
          if (colorMode) {
            compositeRaster = await readCompositeRaster(ds, eff, viewport.w, viewport.h);
            raster = compositeRaster.rasterByBand.get(band) || compositeRaster.rasterByBand.get(0) || null;
          } else {
            raster = await readRasterForBand(ds, band, eff, viewport.w, viewport.h);
          }
          if (seq !== state.renderSeq) return;

          const stableComposite = colorMode ? isStableCompositeRaster(compositeRaster) : false;
          const stableRaster = colorMode ? stableComposite : isStableRaster(raster);

          const settings = getBandSettings(ds, band);
          const range = resolveDisplayRange(ds, band, raster.dataF32);
          const params = {
            minVal: range.minVal,
            maxVal: range.maxVal,
            brightness: clamp(settings.brightness ?? 0, -1, 1),
            gain: clamp(settings.gain ?? 1, 0.0, 4.0),
            contrast: clamp(settings.contrast ?? 1, 0.1, 3.0)
          };

          let renderedCanvas = null;
          if (colorMode) {
            const channelRasters = compositeRaster.channelBands.map((channelBand) => compositeRaster.rasterByBand.get(channelBand));
            const channelParams = compositeRaster.channelBands.map((channelBand) => {
              const channelSettings = getBandSettings(ds, channelBand);
              const channelRange = resolveDisplayRange(ds, channelBand, compositeRaster.rasterByBand.get(channelBand).dataF32);
              return {
                minVal: channelRange.minVal,
                maxVal: channelRange.maxVal,
                brightness: clamp(channelSettings.brightness ?? 0, -1, 1),
                gain: clamp(channelSettings.gain ?? 1, 0.0, 4.0),
                contrast: clamp(channelSettings.contrast ?? 1, 0.1, 3.0)
              };
            });
            renderedCanvas = buildColorCanvas(channelRasters, channelParams);
          } else {
            renderedCanvas = buildGrayCanvas(raster.dataF32, raster.w, raster.h, params);
          }
          drawCanvasToViewport(cpuCtx, renderedCanvas, viewport, false);
          if (stableRaster || stableComposite) {
            updateScreenPreviewCache(ds, panel.slot, modeKey, eff, renderedCanvas);
            updatePanelRasterCache(ds, panel.slot, raster, compositeRaster);
          } else {
            updatePanelRasterCache(ds, panel.slot, null, null);
          }

          if (Number(panel.slot) === activeSlot) {
            ds.lastRaster = stableRaster ? raster : null;
            ds.lastCompositeRaster = stableComposite ? compositeRaster : null;
            syncRangeInputsFromSettings(ds);
          }
        });
      }

      if (seq !== state.renderSeq) return;
      state.lastRenderMs = now() - t0;
      setStatus("ready", "ok");
      renderThumbnail();
      updateHud();
      drawOverlays();
      updatePerf();

      const activeDs = getActive();
      if (activeDs && state.histMode === "view") {
        if (state.histViewDebounce) clearTimeout(state.histViewDebounce);
        state.histViewDebounce = setTimeout(() => {
          const d = getActive();
          if (!d || d.id !== activeDs.id) return;
          ensureViewHistogram(d);
        }, 180);
      }
    } catch (e) {
      console.error(e);
      if (seq !== state.renderSeq) return;
      setStatus("render error", "err");
    }
  }

  async function renderOverlayPanels(opts = {}, visible = []) {
    const seq = ++state.renderSeq;
    resizeCanvases();
    clearBaseCanvases();
    const layout = panelLayout();
    const cpuCtx = els.cpuCanvas.getContext("2d", { alpha: false });
    const dpr = window.devicePixelRatio || 1;
    const activeSlot = Number(activePanelInfo()?.slot) || Number(visible[0]?.panel?.slot) || 1;
    const overlayLayers = [];
    const t0 = now();

    try {
      for (const entry of visible) {
        if (seq !== state.renderSeq) return;
        const { panel, dataset: ds } = entry;
        const viewport = layout.find((rect) => Number(rect.slot) === Number(panel.slot));
        const band = resolvePanelBand(panel, ds);
        if (!viewport || !ds || band == null) continue;
        await withPanelView(ds, panel, async () => {
          clampView(panel.slot, ds);
          const eff = ds.view.scale * dpr;
          const raster = await readRasterForBand(ds, band, eff, viewport.w, viewport.h);
          if (seq !== state.renderSeq) return;

          const stableRaster = isStableRaster(raster);
          const settings = getBandSettings(ds, band);
          const range = resolveDisplayRange(ds, band, raster.dataF32);
          const params = {
            minVal: range.minVal,
            maxVal: range.maxVal,
            brightness: clamp(settings.brightness ?? 0, -1, 1),
            gain: clamp(settings.gain ?? 1, 0.0, 4.0),
            contrast: clamp(settings.contrast ?? 1, 0.1, 3.0)
          };
          const renderedCanvas = buildGrayCanvas(raster.dataF32, raster.w, raster.h, params);

          if (stableRaster) {
            updateScreenPreviewCache(ds, panel.slot, renderModeKey(ds, band, false, null), eff, renderedCanvas);
            updatePanelRasterCache(ds, panel.slot, raster, null);
          } else {
            updatePanelRasterCache(ds, panel.slot, null, null);
          }

          overlayLayers.push({
            panel,
            dataset: ds,
            viewport,
            renderedCanvas,
            stableRaster,
            raster
          });

          if (Number(panel.slot) === activeSlot) {
            ds.lastRaster = stableRaster ? raster : null;
            ds.lastCompositeRaster = null;
            syncRangeInputsFromSettings(ds);
          }
        });
      }

      if (seq !== state.renderSeq) return;
      const overlayViewport = overlayLayers[0]?.viewport || { x: 0, y: 0, w: els.cpuCanvas.width, h: els.cpuCanvas.height };
      cpuCtx.save();
      cpuCtx.setTransform(1, 0, 0, 1, 0, 0);
      cpuCtx.fillStyle = "#000";
      cpuCtx.fillRect(Number(overlayViewport.x) || 0, Number(overlayViewport.y) || 0, Math.max(1, Number(overlayViewport.w) || 1), Math.max(1, Number(overlayViewport.h) || 1));
      cpuCtx.restore();

      for (let i = 0; i < overlayLayers.length; i += 1) {
        const layer = overlayLayers[i];
        const tinted = tintCanvas(layer.renderedCanvas, overlayColorForSlot(layer.panel.slot));
        cpuCtx.save();
        cpuCtx.globalCompositeOperation = i === 0 ? "source-over" : "lighter";
        drawCanvasToViewport(cpuCtx, tinted, layer.viewport, false);
        cpuCtx.restore();
      }

      state.lastRenderMs = now() - t0;
      setStatus("ready", "ok");
      renderThumbnail();
      updateHud();
      drawOverlays();
      updatePerf();

      const activeDs = getActive();
      if (activeDs && state.histMode === "view") {
        if (state.histViewDebounce) clearTimeout(state.histViewDebounce);
        state.histViewDebounce = setTimeout(() => {
          const d = getActive();
          if (!d || d.id !== activeDs.id) return;
          ensureViewHistogram(d);
        }, 180);
      }
    } catch (e) {
      console.error(e);
      if (seq !== state.renderSeq) return;
      setStatus("render error", "err");
    }
  }

  async function render(opts = {}) {
    const visible = listVisiblePanels();
    if (!visible.length) {
      resizeCanvases();
      clearBaseCanvases();
      return;
    }

    const activePanel = activePanelInfo();
    const activeEntry = visible.find((entry) => Number(entry.panel.slot) === Number(activePanel?.slot)) || visible[0];
    const activeDs = activeEntry?.dataset || getActive();
    if (!activeDs || resolvePanelBand(activeEntry?.panel || null, activeDs) == null) {
      resizeCanvases();
      clearBaseCanvases();
      return;
    }

    if (visible.length === 1) {
      await withPanelView(activeDs, activeEntry.panel, async () => {
        await renderSinglePanel(activeDs, activeEntry.panel, opts);
      });
      return;
    }

    if (els.gpuCanvas?.style) els.gpuCanvas.style.display = "none";
    if (els.cpuCanvas?.style) els.cpuCanvas.style.display = "block";
    if (isOverlayComposition(visible)) {
      await renderOverlayPanels(opts, visible);
      return;
    }
    await renderMultiPanel(opts, visible);
  }

  return {
    resizeCanvases,
    renderPreview,
    schedulePreview,
    scheduleRender,
    render
  };
}
