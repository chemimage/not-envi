export function bindCoreEvents({ els, handlers }) {
  if (els.main && handlers.onPointerDown) {
    els.main.addEventListener("pointerdown", handlers.onPointerDown);
  }
  if (handlers.onPointerMove) {
    window.addEventListener("pointermove", handlers.onPointerMove);
  }
  if (handlers.onPointerUp) {
    window.addEventListener("pointerup", handlers.onPointerUp);
  }
  if (els.main && handlers.onWheel) {
    els.main.addEventListener("wheel", handlers.onWheel, { passive: false });
  }
}

export function createInteractionController(deps) {
  const {
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
    updateZoomLabel
  } = deps;

  function updateSelectionRect() {
    const x0 = Math.min(state.selection.x0, state.selection.x1);
    const y0 = Math.min(state.selection.y0, state.selection.y1);
    const x1 = Math.max(state.selection.x0, state.selection.x1);
    const y1 = Math.max(state.selection.y0, state.selection.y1);

    els.selRect.style.display = "block";
    els.selRect.style.left = `${x0}px`;
    els.selRect.style.top = `${y0}px`;
    els.selRect.style.width = `${Math.max(1, x1 - x0)}px`;
    els.selRect.style.height = `${Math.max(1, y1 - y0)}px`;
  }

  function clearSelection() {
    state.selection.drawing = false;
    state.selection.imgRect = null;
    els.selRect.style.display = "none";
  }

  function finalizeSelection() {
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
      y1: clamp(iy1, 0, ds.meta.lines)
    };
  }

  function onPointerDown(ev) {
    const ds = getActive();
    if (!ds) return;
    const rect = els.main.getBoundingClientRect();
    state.mouse.dragging = true;
    state.mouse.lastX = ev.clientX - rect.left;
    state.mouse.lastY = ev.clientY - rect.top;

    if (state.selection.enabled) {
      state.selection.drawing = true;
      state.selection.x0 = state.mouse.lastX;
      state.selection.y0 = state.mouse.lastY;
      state.selection.x1 = state.mouse.lastX;
      state.selection.y1 = state.mouse.lastY;
      updateSelectionRect();
    }
  }

  function onPointerMove(ev) {
    const ds = getActive();
    const rect = els.main.getBoundingClientRect();
    state.mouse.in = true;
    state.mouse.x = ev.clientX - rect.left;
    state.mouse.y = ev.clientY - rect.top;

    if (ds && state.mouse.dragging && !state.selection.drawing) {
      const dx = state.mouse.x - state.mouse.lastX;
      const dy = state.mouse.y - state.mouse.lastY;
      state.mouse.lastX = state.mouse.x;
      state.mouse.lastY = state.mouse.y;

      ds.view.x -= dx / ds.view.scale;
      ds.view.y -= dy / ds.view.scale;
      clampView();
      render();
    }

    if (state.selection.drawing) {
      state.selection.x1 = state.mouse.x;
      state.selection.y1 = state.mouse.y;
      updateSelectionRect();
    }

    updateHud();
  }

  function onPointerUp() {
    state.mouse.dragging = false;
    if (state.selection.drawing) {
      state.selection.drawing = false;
      finalizeSelection();
      setStatus("ready", "ok");
    }
  }

  function onPointerLeave() {
    state.mouse.in = false;
    state.mouse.dragging = false;
  }

  function zoomAt(factor, sx, sy) {
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

  function onWheel(ev) {
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

  return {
    clearSelection,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerLeave,
    onWheel,
    zoomAt
  };
}
