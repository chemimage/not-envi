export function createViewControls(deps) {
  const {
    state,
    els,
    clamp,
    getActive,
    getPanelRectCss,
    getPanelRectDevice,
    onRender
  } = deps;

  function resolveViewportCssRect() {
    const rect = (typeof getPanelRectCss === "function") ? getPanelRectCss() : null;
    if (rect) return rect;
    const main = els.main?.getBoundingClientRect ? els.main.getBoundingClientRect() : null;
    return {
      x: 0,
      y: 0,
      w: Math.max(1, Number(main?.width) || 1),
      h: Math.max(1, Number(main?.height) || 1)
    };
  }

  function resolveViewportDeviceRect(slot = null) {
    const rect = (typeof getPanelRectDevice === "function") ? getPanelRectDevice(slot) : null;
    if (rect) return rect;
    return {
      x: 0,
      y: 0,
      w: Math.max(1, Number(els.cpuCanvas?.width) || 1),
      h: Math.max(1, Number(els.cpuCanvas?.height) || 1)
    };
  }

  function computeFitScale(ds) {
    const rect = resolveViewportCssRect();
    return Math.min(rect.w / ds.meta.samples, rect.h / ds.meta.lines);
  }

  function minScaleFor(ds) {
    const fit = computeFitScale(ds);
    return Math.min(1, fit);
  }

  function updateZoomRange(ds) {
    if (!ds) {
      state.zoomExpMin = -6;
      state.zoomExpMax = 4;
      return;
    }
    const minScale = Math.max(1e-9, minScaleFor(ds));
    const minExp = Math.log2(minScale);
    state.zoomExpMin = Math.min(-6, Math.floor(minExp) - 1);
    state.zoomExpMax = 4;
  }

  function sliderToScale(v) {
    const t = clamp(v / 100, 0, 1);
    const exp = state.zoomExpMin + t * (state.zoomExpMax - state.zoomExpMin);
    return Math.pow(2, exp);
  }

  function scaleToSlider(s) {
    const exp = Math.log2(Math.max(1e-9, s));
    const t = (exp - state.zoomExpMin) / Math.max(1e-9, (state.zoomExpMax - state.zoomExpMin));
    return clamp(Math.round(t * 100), 0, 100);
  }

  function updateZoomLabel() {
    const ds = getActive();
    if (!ds) {
      els.zoomLabel.textContent = "—";
      return;
    }
    els.zoomLabel.textContent = `${(ds.view.scale * 100).toFixed(1)}%`;
  }

  function clampView(slot = null) {
    const ds = getActive();
    if (!ds) return;
    const minS = minScaleFor(ds);
    ds.view.minScale = minS;
    ds.view.scale = clamp(ds.view.scale, minS, 128);

    const dpr = window.devicePixelRatio || 1;
    const viewport = resolveViewportDeviceRect(slot);
    const eff = ds.view.scale * dpr;
    const viewW = viewport.w / eff;
    const viewH = viewport.h / eff;
    if (viewW >= ds.meta.samples) {
      ds.view.x = (ds.meta.samples - viewW) * 0.5;
    } else {
      ds.view.x = clamp(ds.view.x, 0, Math.max(0, ds.meta.samples - viewW));
    }
    if (viewH >= ds.meta.lines) {
      ds.view.y = (ds.meta.lines - viewH) * 0.5;
    } else {
      ds.view.y = clamp(ds.view.y, 0, Math.max(0, ds.meta.lines - viewH));
    }
  }

  function fitToScreen() {
    const ds = getActive();
    if (!ds) return;
    const rect = resolveViewportCssRect();
    const s = Math.min(rect.w / ds.meta.samples, rect.h / ds.meta.lines);
    updateZoomRange(ds);
    ds.view.scale = s;
    ds.view.x = 0;
    ds.view.y = 0;
    clampView();
    els.zoom.value = String(scaleToSlider(ds.view.scale));
    updateZoomLabel();
    onRender();
  }

  function screenToImage(sx, sy, slot = null) {
    const ds = getActive();
    if (!ds) return { x: 0, y: 0 };
    const viewport = resolveViewportDeviceRect(slot);
    const dpr = window.devicePixelRatio || 1;
    const eff = ds.view.scale * dpr;
    const localX = (Number(sx) || 0) - (Number(viewport.x) || 0);
    const localY = (Number(sy) || 0) - (Number(viewport.y) || 0);
    return { x: ds.view.x + localX / eff, y: ds.view.y + localY / eff };
  }

  return {
    computeFitScale,
    minScaleFor,
    updateZoomRange,
    sliderToScale,
    scaleToSlider,
    updateZoomLabel,
    clampView,
    fitToScreen,
    screenToImage
  };
}
