export function createViewControls(deps) {
  const {
    state,
    els,
    clamp,
    getActive,
    onRender
  } = deps;

  function computeFitScale(ds) {
    const rect = els.main.getBoundingClientRect();
    return Math.min(rect.width / ds.meta.samples, rect.height / ds.meta.lines);
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

  function clampView() {
    const ds = getActive();
    if (!ds) return;
    const minS = minScaleFor(ds);
    ds.view.minScale = minS;
    ds.view.scale = clamp(ds.view.scale, minS, 128);

    const dpr = window.devicePixelRatio || 1;
    const eff = ds.view.scale * dpr;
    const viewW = els.cpuCanvas.width / eff;
    const viewH = els.cpuCanvas.height / eff;
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
    const rect = els.main.getBoundingClientRect();
    const s = Math.min(rect.width / ds.meta.samples, rect.height / ds.meta.lines);
    updateZoomRange(ds);
    ds.view.scale = s;
    ds.view.x = 0;
    ds.view.y = 0;
    clampView();
    els.zoom.value = String(scaleToSlider(ds.view.scale));
    updateZoomLabel();
    onRender();
  }

  function screenToImage(sx, sy) {
    const ds = getActive();
    const dpr = window.devicePixelRatio || 1;
    const eff = ds.view.scale * dpr;
    return { x: ds.view.x + sx / eff, y: ds.view.y + sy / eff };
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
