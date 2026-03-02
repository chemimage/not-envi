import { clamp } from "../core/utils.js";

export function createThumbnailController(deps) {
  const {
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
    getDevicePixelRatio
  } = deps;

  async function renderWindowToImageData(ds, band, x0, y0, outW, outH, step) {
    let raw;
    if (ds.meta.interleave === "bip") {
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
      contrast: clamp(settings.contrast ?? 1, 0.1, 3.0)
    };

    const img = new ImageData(outW, outH);
    const dst = img.data;
    for (let i = 0, j = 0; i < f32.length; i++, j += 4) {
      const t = tone01(f32[i], params.minVal, params.maxVal, params.gamma, params.gain, params.contrast);
      const u = Math.round(t * 255);
      dst[j] = u;
      dst[j + 1] = u;
      dst[j + 2] = u;
      dst[j + 3] = 255;
    }
    return img;
  }

  async function buildThumbnail(ds) {
    if (!ds) return;
    const twCss = 220;
    const thCss = 160;
    const dpr = getDevicePixelRatio();
    const tw = Math.floor(twCss * dpr);
    const th = Math.floor(thCss * dpr);
    els.thumb.width = tw;
    els.thumb.height = th;

    const stepX = Math.ceil(ds.meta.samples / tw);
    const stepY = Math.ceil(ds.meta.lines / th);
    const step = Math.max(1, Math.max(stepX, stepY));

    const outW = Math.min(tw, Math.ceil(ds.meta.samples / step));
    const outH = Math.min(th, Math.ceil(ds.meta.lines / step));

    try {
      const img = await renderWindowToImageData(ds, ds.activeBand, 0, 0, outW, outH, step);
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
      ds.thumb._t = now();
    } catch (e) {
      console.warn("thumb error", e);
    }
  }

  function renderThumbnail() {
    const ds = getActive();
    els.thumbWrap.style.display = els.chkThumb.checked ? "block" : "none";
    if (!els.chkThumb.checked || !ds) return;

    if (!ds.thumb.ready || (now() - (ds.thumb._t || 0)) > 1500) {
      buildThumbnail(ds);
      return;
    }

    if (ds.thumb.base) {
      const tw = els.thumb.width;
      const th = els.thumb.height;
      thumbCtx.save();
      thumbCtx.imageSmoothingEnabled = false;
      thumbCtx.setTransform(1, 0, 0, 1, 0, 0);
      thumbCtx.clearRect(0, 0, tw, th);
      thumbCtx.drawImage(ds.thumb.base, 0, 0, ds.thumb.baseW, ds.thumb.baseH, ds.thumb.x0, ds.thumb.y0, ds.thumb.w, ds.thumb.h);
      thumbCtx.restore();
    }

    const dpr = getDevicePixelRatio();
    const eff = ds.view.scale * dpr;
    const viewW = els.cpuCanvas.width / eff;
    const viewH = els.cpuCanvas.height / eff;
    const vx0 = ds.view.x / ds.meta.samples;
    const vy0 = ds.view.y / ds.meta.lines;
    const vx1 = (ds.view.x + viewW) / ds.meta.samples;
    const vy1 = (ds.view.y + viewH) / ds.meta.lines;
    const rx = ds.thumb.x0 + vx0 * ds.thumb.w;
    const ry = ds.thumb.y0 + vy0 * ds.thumb.h;
    const rw = (vx1 - vx0) * ds.thumb.w;
    const rh = (vy1 - vy0) * ds.thumb.h;

    thumbCtx.save();
    thumbCtx.setTransform(1, 0, 0, 1, 0, 0);
    thumbCtx.strokeStyle = "rgba(106,169,255,.95)";
    thumbCtx.lineWidth = 2 * dpr;
    thumbCtx.strokeRect(rx, ry, rw, rh);
    thumbCtx.restore();
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

    const eff = ds.view.scale * dpr;
    const viewW = els.cpuCanvas.width / eff;
    const viewH = els.cpuCanvas.height / eff;
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
