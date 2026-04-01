import { clamp } from "../core/utils.js";
import { resolveThreeBandChannelOrder } from "../app/three-band-display.js";
import { createFloat32ScratchPool } from "../core/float-scratch.js";
import { APP_CONFIG } from "../app/config.js";

export function createThumbnailController(deps) {
  const {
    els,
    thumbCtx,
    toFloat32,
    tone01,
    resolveDisplayRange,
    getBandSettings,
    readBandWindow,
    readBandWindowBIP,
    getActive,
    render,
    getActiveViewportCss,
    getActiveViewportDevice,
    getDevicePixelRatio,
    isThreeBandColorMode,
    recenterViewAtFraction
  } = deps;
  const floatScratchPool = createFloat32ScratchPool({
    maxRetainedBuffers: APP_CONFIG.scratch.thumbnail.maxRetainedBuffers,
    maxRetainedElements: APP_CONFIG.scratch.thumbnail.maxRetainedElements
  });

  function syncThumbWrapSize() {
    const viewport = (typeof getActiveViewportCss === "function")
      ? getActiveViewportCss()
      : null;
    const rect = viewport || els.main.getBoundingClientRect();
    const viewW = Math.max(1, rect.width || rect.w || 1);
    const viewH = Math.max(1, rect.height || rect.h || 1);
    const aspect = viewW / viewH;

    const maxW = 220;
    const maxH = 220;
    const minW = 120;
    const minH = 80;

    let twCss = maxW;
    let thCss = twCss / aspect;
    if (thCss > maxH) {
      thCss = maxH;
      twCss = thCss * aspect;
    }

    twCss = clamp(Math.round(twCss), minW, maxW);
    thCss = clamp(Math.round(thCss), minH, maxH);
    els.thumbWrap.style.width = `${twCss}px`;
    els.thumbWrap.style.height = `${thCss}px`;
    return { twCss, thCss };
  }

  function createImageDataCompat(width, height) {
    if (typeof ImageData !== "undefined") {
      return new ImageData(width, height);
    }
    return { width, height, data: new Uint8ClampedArray(width * height * 4) };
  }

  function isJsdomRuntime() {
    return typeof navigator !== "undefined" && /jsdom/i.test(String(navigator.userAgent || ""));
  }

  function calcThumbPixels() {
    const { twCss, thCss } = syncThumbWrapSize();
    const dpr = getDevicePixelRatio();
    return {
      tw: Math.max(1, Math.floor(twCss * dpr)),
      th: Math.max(1, Math.floor(thCss * dpr)),
      dpr
    };
  }

  function ensureThumbCanvasSize(tw, th) {
    if (els.thumb.width !== tw) els.thumb.width = tw;
    if (els.thumb.height !== th) els.thumb.height = th;
  }

  function thumbBuildKey(ds, tw, th) {
    const mode = isThreeBandColorMode && isThreeBandColorMode(ds) ? (ds.displayMode || "rgb") : "gray";
    return `${ds.id || "ds"}:${mode}:${ds.activeBand}:${tw}x${th}`;
  }

  async function readWindowF32(ds, band, x0, y0, outW, outH, step) {
    const length = Math.max(0, outW * outH);
    const scratch = floatScratchPool.acquire(length);
    try {
      const raw = ds.meta.interleave === "bip"
        ? await readBandWindowBIP(ds.meta, ds.ds, band, x0, y0, outW, outH, step, scratch)
        : await readBandWindow(ds.meta, ds.ds, band, x0, y0, outW, outH, step, scratch);
      return {
        data: raw === scratch ? scratch : toFloat32(raw, scratch),
        release() {
          floatScratchPool.release(scratch);
        }
      };
    } catch (err) {
      floatScratchPool.release(scratch);
      throw err;
    }
  }

  async function renderWindowToImageData(ds, band, x0, y0, outW, outH, step) {
    const window = await readWindowF32(ds, band, x0, y0, outW, outH, step);
    try {
      const f32 = window.data;
      const settings = getBandSettings(ds, band);
      const range = resolveDisplayRange(ds, band, f32);
      const params = {
        minVal: range.minVal,
        maxVal: range.maxVal,
        brightness: clamp(settings.brightness ?? 0, -1, 1),
        gain: clamp(settings.gain ?? 1, 0.0, 4.0),
        contrast: clamp(settings.contrast ?? 1, 0.1, 3.0)
      };

      const img = createImageDataCompat(outW, outH);
      const dst = img.data;
      for (let i = 0, j = 0; i < f32.length; i++, j += 4) {
        const t = tone01(f32[i], params.minVal, params.maxVal, params.brightness, params.gain, params.contrast);
        const u = Math.round(t * 255);
        dst[j] = u;
        dst[j + 1] = u;
        dst[j + 2] = u;
        dst[j + 3] = 255;
      }
      return img;
    } finally {
      window.release();
    }
  }

  async function renderCompositeWindowToImageData(ds, x0, y0, outW, outH, step) {
    const channelBands = resolveThreeBandChannelOrder(ds.displayMode || "rgb");
    const channelWindows = await Promise.all(channelBands.map((band) => readWindowF32(ds, band, x0, y0, outW, outH, step)));
    try {
      const channelData = channelWindows.map((window) => window.data);
      const channelParams = channelBands.map((band, idx) => {
        const f32 = channelData[idx];
        const settings = getBandSettings(ds, band);
        const range = resolveDisplayRange(ds, band, f32);
        return {
          minVal: range.minVal,
          maxVal: range.maxVal,
          brightness: clamp(settings.brightness ?? 0, -1, 1),
          gain: clamp(settings.gain ?? 1, 0.0, 4.0),
          contrast: clamp(settings.contrast ?? 1, 0.1, 3.0)
        };
      });

      const img = createImageDataCompat(outW, outH);
      const dst = img.data;
      for (let i = 0, j = 0; i < channelData[0].length; i += 1, j += 4) {
        dst[j] = Math.round(tone01(channelData[0][i], channelParams[0].minVal, channelParams[0].maxVal, channelParams[0].brightness, channelParams[0].gain, channelParams[0].contrast) * 255);
        dst[j + 1] = Math.round(tone01(channelData[1][i], channelParams[1].minVal, channelParams[1].maxVal, channelParams[1].brightness, channelParams[1].gain, channelParams[1].contrast) * 255);
        dst[j + 2] = Math.round(tone01(channelData[2][i], channelParams[2].minVal, channelParams[2].maxVal, channelParams[2].brightness, channelParams[2].gain, channelParams[2].contrast) * 255);
        dst[j + 3] = 255;
      }
      return img;
    } finally {
      for (const window of channelWindows) window.release();
    }
  }

  async function buildThumbnail(ds, buildKey, tw, th) {
    if (!ds) return;
    if (isJsdomRuntime()) return;
    ensureThumbCanvasSize(tw, th);
    const seq = (ds.thumb.buildSeq || 0) + 1;
    ds.thumb.buildSeq = seq;
    ds.thumb.buildPendingKey = buildKey;

    const stepX = Math.ceil(ds.meta.samples / tw);
    const stepY = Math.ceil(ds.meta.lines / th);
    const step = Math.max(1, Math.max(stepX, stepY));

    const outW = Math.min(tw, Math.ceil(ds.meta.samples / step));
    const outH = Math.min(th, Math.ceil(ds.meta.lines / step));

    try {
      const img = (isThreeBandColorMode && isThreeBandColorMode(ds))
        ? await renderCompositeWindowToImageData(ds, 0, 0, outW, outH, step)
        : await renderWindowToImageData(ds, ds.activeBand, 0, 0, outW, outH, step);
      if (ds.thumb.buildSeq !== seq) return;
      thumbCtx.save();
      thumbCtx.imageSmoothingEnabled = false;
      thumbCtx.setTransform(1, 0, 0, 1, 0, 0);
      thumbCtx.clearRect(0, 0, tw, th);

      const scale = Math.min(tw / outW, th / outH);
      const dw = outW * scale;
      const dh = outH * scale;
      const dx = (tw - dw) / 2;
      const dy = (th - dh) / 2;

      const off = document.createElement("canvas");
      off.width = outW;
      off.height = outH;
      off.getContext("2d", { alpha: false }).putImageData(img, 0, 0);
      thumbCtx.drawImage(off, 0, 0, outW, outH, dx, dy, dw, dh);
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
      ds.thumb.buildKey = buildKey;
      ds.thumb.buildPendingKey = null;
    } catch (e) {
      console.warn("thumb error", e);
      if (ds.thumb.buildSeq === seq) ds.thumb.buildPendingKey = null;
    }
  }

  function renderThumbnail() {
    const ds = getActive();
    els.thumbWrap.style.display = "block";
    if (!ds) return;
    const { tw, th, dpr } = calcThumbPixels();
    ensureThumbCanvasSize(tw, th);

    const key = thumbBuildKey(ds, tw, th);
    const needsBuild = !ds.thumb.ready || ds.thumb.buildKey !== key;
    if (needsBuild && ds.thumb.buildPendingKey !== key) {
      void buildThumbnail(ds, key, tw, th);
    }

    if (!ds.thumb.base) {
      return;
    }

    thumbCtx.save();
    thumbCtx.imageSmoothingEnabled = false;
    thumbCtx.setTransform(1, 0, 0, 1, 0, 0);
    thumbCtx.clearRect(0, 0, tw, th);
    thumbCtx.drawImage(ds.thumb.base, 0, 0, ds.thumb.baseW, ds.thumb.baseH, ds.thumb.x0, ds.thumb.y0, ds.thumb.w, ds.thumb.h);
    thumbCtx.restore();

    const eff = ds.view.scale * dpr;
    const viewport = (typeof getActiveViewportDevice === "function")
      ? getActiveViewportDevice()
      : { width: els.cpuCanvas.width, height: els.cpuCanvas.height };
    const viewW = Math.max(1, Number(viewport.width || viewport.w || 1)) / eff;
    const viewH = Math.max(1, Number(viewport.height || viewport.h || 1)) / eff;
    const vx0 = ds.view.x / ds.meta.samples;
    const vy0 = ds.view.y / ds.meta.lines;
    const vx1 = (ds.view.x + viewW) / ds.meta.samples;
    const vy1 = (ds.view.y + viewH) / ds.meta.lines;
    const rx = ds.thumb.x0 + vx0 * ds.thumb.w;
    const ry = ds.thumb.y0 + vy0 * ds.thumb.h;
    const rw = (vx1 - vx0) * ds.thumb.w;
    const rh = (vy1 - vy0) * ds.thumb.h;

    const eps = 1.5 * dpr;
    const fullView =
      rx <= (ds.thumb.x0 + eps) &&
      ry <= (ds.thumb.y0 + eps) &&
      (rx + rw) >= (ds.thumb.x0 + ds.thumb.w - eps) &&
      (ry + rh) >= (ds.thumb.y0 + ds.thumb.h - eps);

    if (!fullView) {
      thumbCtx.save();
      thumbCtx.setTransform(1, 0, 0, 1, 0, 0);
      thumbCtx.strokeStyle = "rgba(209,213,219,0.95)";
      thumbCtx.lineWidth = 2 * dpr;
      thumbCtx.strokeRect(rx, ry, rw, rh);
      thumbCtx.restore();
    }
  }

  function onThumbClick(ev) {
    const ds = getActive();
    if (!ds || !ds.thumb.ready) return;
    const rect = els.thumb.getBoundingClientRect();
    const dpr = getDevicePixelRatio();
    const sx = (ev.clientX - rect.left) * dpr;
    const sy = (ev.clientY - rect.top) * dpr;

    const nx = (sx - ds.thumb.x0) / ds.thumb.w;
    const ny = (sy - ds.thumb.y0) / ds.thumb.h;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;

    if (typeof recenterViewAtFraction === "function") {
      if (recenterViewAtFraction(nx, ny) !== false) {
        render();
        return;
      }
    }

    const eff = ds.view.scale * dpr;
    const viewport = (typeof getActiveViewportDevice === "function")
      ? getActiveViewportDevice()
      : { width: els.cpuCanvas.width, height: els.cpuCanvas.height };
    const viewW = Math.max(1, Number(viewport.width || viewport.w || 1)) / eff;
    const viewH = Math.max(1, Number(viewport.height || viewport.h || 1)) / eff;
    ds.view.x = clamp(nx * ds.meta.samples - viewW / 2, 0, Math.max(0, ds.meta.samples - viewW));
    ds.view.y = clamp(ny * ds.meta.lines - viewH / 2, 0, Math.max(0, ds.meta.lines - viewH));
    render();
  }

  return {
    renderWindowToImageData,
    renderThumbnail,
    onThumbClick
  };
}
