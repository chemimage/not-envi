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
    els.cpuCanvas.width = w;
    els.cpuCanvas.height = h;
    els.overlayCanvas.width = w;
    els.overlayCanvas.height = h;
  }

  function scheduleRender() {
    if (state._rafPending) return;
    state._rafPending = true;
    requestAnimationFrame(() => {
      state._rafPending = false;
      render();
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
    const eff = ds.view.scale * dpr;
    const colorMode = isThreeBandColorMode(ds);

    let useGPU = false;
    if (!colorMode && gpuSupported) {
      const ok = await initWebGPU();
      if (ok) useGPU = true;
    }

    els.gpuCanvas.style.display = useGPU ? "block" : "none";
    els.cpuCanvas.style.display = useGPU ? "none" : "block";

    clampView();
    const band = ds.activeBand;
    const settings = getBandSettings(ds, band);

    const reuse = !!opts.reuseRaster;
    let raster = null;
    let compositeRaster = null;
    if (colorMode) {
      if (reuse && ds.lastCompositeRaster && ds.lastCompositeRaster.mode === getThreeBandDisplayMode(ds)) {
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
    scheduleRender,
    render
  };
}
