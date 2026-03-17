import { clamp } from "../core/utils.js";
import { resolveRasterSampling } from "./raster-geometry.js";
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
    getBandSettings,
    resolveDisplayRange,
    initWebGPU,
    gpuSupported,
    gpuRender,
    cpuRenderGray,
    cpuRenderColor,
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

  async function readRasterDirect(ds, band, eff) {
    const canvasW = els.cpuCanvas.width;
    const canvasH = els.cpuCanvas.height;
    const geom = resolveRasterSampling(ds, canvasW, canvasH, eff);
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
    out.fill(Number.NaN);

    if (validW > 0 && validH > 0) {
      let raw;
      if (ds.meta.interleave === "bip") {
        raw = await readBandWindowBIP(ds.meta, ds.ds, band, srcX0, srcY0, validW, validH, step);
      } else {
        raw = await readBandWindow(ds.meta, ds.ds, band, srcX0, srcY0, validW, validH, step);
      }
      const src = toFloat32(raw);
      for (let r = 0; r < validH; r += 1) {
        const srcOff = r * validW;
        const dstOff = (rowStart + r) * rasterW + colStart;
        out.set(src.subarray(srcOff, srcOff + validW), dstOff);
      }
    }

    return { band, dataF32: out, w: rasterW, h: rasterH, source: "direct", level: 0, step, x0: ds.view.x, y0: ds.view.y };
  }

  function viewExtendsOutside(ds, eff) {
    const viewW = els.cpuCanvas.width / eff;
    const viewH = els.cpuCanvas.height / eff;
    return (
      ds.view.x < 0
      || ds.view.y < 0
      || (ds.view.x + viewW) > ds.meta.samples
      || (ds.view.y + viewH) > ds.meta.lines
    );
  }

  async function readRasterForBand(ds, band, eff) {
    let raster = null;
    if (eff < 1 && !viewExtendsOutside(ds, eff)) raster = await tryRasterFromPyramid(ds, band, eff);
    if (!raster) {
      setStatus("reading…", "warn");
      raster = await readRasterDirect(ds, band, eff);
    }
    return raster;
  }

  async function readCompositeRaster(ds, eff) {
    const mode = getThreeBandDisplayMode(ds);
    const sourceBands = [0, 1, 2];
    const rasters = await Promise.all(sourceBands.map((band) => readRasterForBand(ds, band, eff)));
    const rasterByBand = new Map(rasters.map((raster) => [raster.band, raster]));
    return {
      mode,
      channelBands: resolveThreeBandChannelOrder(mode),
      rasterByBand
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

  function updateScreenPreviewCache(ds, modeKey, eff, sourceCanvas) {
    if (!ds || !sourceCanvas) return;
    ds.lastScreenFrame = {
      modeKey,
      eff,
      viewX: ds.view.x,
      viewY: ds.view.y,
      canvas: cloneCanvasImage(sourceCanvas)
    };
  }

  function drawCachedScreenPreview(ds, modeKey, eff) {
    const frame = ds?.lastScreenFrame;
    if (!frame || frame.modeKey !== modeKey || !frame.canvas) return false;
    const prevEff = Math.max(1e-9, Number(frame.eff) || 0);
    const scale = eff / prevEff;
    if (!Number.isFinite(scale) || scale <= 0) return false;

    const cpuCtx = els.cpuCanvas.getContext("2d", { alpha: false });
    const dx = ((Number(frame.viewX) || 0) - ds.view.x) * eff;
    const dy = ((Number(frame.viewY) || 0) - ds.view.y) * eff;

    cpuCtx.save();
    cpuCtx.setTransform(1, 0, 0, 1, 0, 0);
    cpuCtx.imageSmoothingEnabled = false;
    cpuCtx.fillStyle = "#000";
    cpuCtx.fillRect(0, 0, els.cpuCanvas.width, els.cpuCanvas.height);
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
    const ds = getActive();
    if (!ds || ds.activeBand == null) return false;
    resizeCanvases();
    clampView();
    const dpr = window.devicePixelRatio || 1;
    const eff = ds.view.scale * dpr;
    const colorMode = isThreeBandColorMode(ds);
    const colorRenderMode = colorMode ? getThreeBandDisplayMode(ds) : null;
    const modeKey = renderModeKey(ds, ds.activeBand, colorMode, colorRenderMode);
    const drew = drawCachedScreenPreview(ds, modeKey, eff);
    renderThumbnail();
    updateHud();
    drawOverlays(ds);
    return drew;
  }

  function schedulePreview() {
    if (previewRafPending) return;
    previewRafPending = true;
    requestAnimationFrame(() => {
      previewRafPending = false;
      renderPreview();
    });
  }

  async function render(opts = {}) {
    const ds = getActive();
    if (!ds || ds.activeBand == null) {
      resizeCanvases();
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
      return;
    }

    const seq = ++state.renderSeq;
    resizeCanvases();
    const dpr = window.devicePixelRatio || 1;
    const colorMode = isThreeBandColorMode(ds);
    const colorRenderMode = colorMode ? getThreeBandDisplayMode(ds) : null;
    const band = ds.activeBand;
    const modeKey = renderModeKey(ds, band, colorMode, colorRenderMode);

    let useGPU = false;
    if (!colorMode && gpuSupported) {
      const ok = await initWebGPU();
      if (ok) useGPU = true;
    }

    clampView();
    const eff = ds.view.scale * dpr;
    const settings = getBandSettings(ds, band);

    const reuse = !!opts.reuseRaster;
    let raster = null;
    let compositeRaster = null;
    const reuseComposite = reuse && ds.lastCompositeRaster && ds.lastCompositeRaster.mode === colorRenderMode;
    const reuseGray = reuse && ds.lastRaster && ds.lastRaster.band === band;
    const needsFreshRaster = colorMode ? !reuseComposite : !reuseGray;
    if (needsFreshRaster && drawCachedScreenPreview(ds, modeKey, eff)) {
      drawOverlays(ds);
      updateHud();
    }
    if (colorMode) {
      if (reuseComposite) {
        compositeRaster = ds.lastCompositeRaster;
      } else {
        compositeRaster = await readCompositeRaster(ds, eff);
        ds.lastCompositeRaster = compositeRaster;
      }
      raster = compositeRaster.rasterByBand.get(band) || compositeRaster.rasterByBand.get(0) || null;
      ds.lastRaster = raster;
    } else {
      if (reuse && ds.lastRaster && ds.lastRaster.band === band) {
        raster = ds.lastRaster;
      } else {
        raster = await readRasterForBand(ds, band, eff);
      }
      ds.lastRaster = raster;
    }
    if (seq !== state.renderSeq) return;

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
        cpuRenderColor(channelRasters, channelParams);
      } else if (useGPU) gpuRender(raster.dataF32, raster.w, raster.h, params);
      else cpuRenderGray(raster.dataF32, raster.w, raster.h, params);
      updateScreenPreviewCache(ds, modeKey, eff, useGPU ? els.gpuCanvas : els.cpuCanvas);

      state.lastRenderMs = now() - t0;
      setStatus("ready", "ok");
      renderThumbnail();
      updateHud();
      drawOverlays(ds);
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

  return {
    resizeCanvases,
    renderPreview,
    schedulePreview,
    scheduleRender,
    render
  };
}
