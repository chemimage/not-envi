import { clamp } from "../core/utils.js";

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

    let rasterW;
    let rasterH;
    let step;
    if (eff >= 1) {
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
    const maxX = ds.meta.samples - 1;
    const maxY = ds.meta.lines - 1;
    const colStart = Math.max(0, Math.ceil((0 - x0) / step));
    const colEnd = Math.min(rasterW - 1, Math.floor((maxX - x0) / step));
    const rowStart = Math.max(0, Math.ceil((0 - y0) / step));
    const rowEnd = Math.min(rasterH - 1, Math.floor((maxY - y0) / step));
    const validW = Math.max(0, colEnd - colStart + 1);
    const validH = Math.max(0, rowEnd - rowStart + 1);
    const out = new Float32Array(rasterW * rasterH);

    if (validW > 0 && validH > 0) {
      const srcX0 = x0 + (colStart * step);
      const srcY0 = y0 + (rowStart * step);
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

    return { band, dataF32: out, w: rasterW, h: rasterH, source: "direct", level: 0, step, x0, y0 };
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

    let useGPU = false;
    if (gpuSupported) {
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
    if (reuse && ds.lastRaster && ds.lastRaster.band === band) {
      raster = ds.lastRaster;
    } else {
      if (eff < 1 && !viewExtendsOutside(ds, eff)) raster = await tryRasterFromPyramid(ds, band, eff);
      if (!raster) {
        setStatus("reading…", "warn");
        raster = await readRasterDirect(ds, band, eff);
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
      if (useGPU) gpuRender(raster.dataF32, raster.w, raster.h, params);
      else cpuRenderGray(raster.dataF32, raster.w, raster.h, params);

      state.lastRenderMs = now() - t0;
      setStatus("ready", "ok");
      drawOverlays(ds);
      updatePerf();
      renderThumbnail();
      updateHud();

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
