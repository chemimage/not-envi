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
  if (handlers.onPointerCancel) {
    window.addEventListener("pointercancel", handlers.onPointerCancel);
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
    openSpectrumAt,
    clampView,
    render,
    minScaleFor,
    scaleToSlider,
    updateZoomLabel
  } = deps;

  const touchPoints = new Map();
  const touchGesture = {
    pinch: null,
    longPressTimer: null,
    longPressPointerId: null,
    longPressStart: null
  };
  const LONG_PRESS_MS = 520;
  const LONG_PRESS_MOVE_TOL = 10;

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
    if (ev.pointerType === "touch") ev.preventDefault();
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

    if (ev.pointerType === "touch") {
      touchPoints.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

      if (touchPoints.size === 1 && !state.selection.enabled) {
        clearLongPress();
        touchGesture.longPressPointerId = ev.pointerId;
        touchGesture.longPressStart = { x: ev.clientX, y: ev.clientY };
        touchGesture.longPressTimer = window.setTimeout(() => {
          const active = getActive();
          if (!active || touchPoints.size !== 1) return;
          const p = touchPoints.get(ev.pointerId);
          if (!p) return;
          const r = els.main.getBoundingClientRect();
          const dpr = window.devicePixelRatio || 1;
          const sx = (p.x - r.left) * dpr;
          const sy = (p.y - r.top) * dpr;
          const img = screenToImage(sx, sy);
          const ix = clamp(Math.floor(img.x), 0, active.meta.samples - 1);
          const iy = clamp(Math.floor(img.y), 0, active.meta.lines - 1);
          if (openSpectrumAt) openSpectrumAt(active, ix, iy);
        }, LONG_PRESS_MS);
      } else {
        clearLongPress();
      }

      if (touchPoints.size === 2) {
        clearLongPress();
        const pts = Array.from(touchPoints.values());
        touchGesture.pinch = {
          startDist: distance(pts[0], pts[1]),
          startScale: ds.view.scale
        };
      }
    }
  }

  function onPointerMove(ev) {
    const ds = getActive();
    const rect = els.main.getBoundingClientRect();
    state.mouse.in = true;
    state.mouse.x = ev.clientX - rect.left;
    state.mouse.y = ev.clientY - rect.top;

    if (ev.pointerType === "touch" && touchPoints.has(ev.pointerId)) {
      ev.preventDefault();
      touchPoints.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (touchGesture.longPressPointerId === ev.pointerId && touchGesture.longPressStart) {
        const dx = ev.clientX - touchGesture.longPressStart.x;
        const dy = ev.clientY - touchGesture.longPressStart.y;
        if ((dx * dx + dy * dy) > (LONG_PRESS_MOVE_TOL * LONG_PRESS_MOVE_TOL)) {
          clearLongPress();
        }
      }

      if (touchPoints.size === 2 && touchGesture.pinch && ds && !state.selection.drawing) {
        const pts = Array.from(touchPoints.values());
        const dist = distance(pts[0], pts[1]);
        if (dist > 0 && touchGesture.pinch.startDist > 0) {
          const factor = dist / touchGesture.pinch.startDist;
          const midX = (pts[0].x + pts[1].x) * 0.5;
          const midY = (pts[0].y + pts[1].y) * 0.5;
          const dpr = window.devicePixelRatio || 1;
          applyScaleAt(touchGesture.pinch.startScale * factor, (midX - rect.left) * dpr, (midY - rect.top) * dpr);
        }
        updateHud();
        return;
      }
    }

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

  function onPointerUp(ev) {
    if (ev && ev.pointerType === "touch") {
      ev.preventDefault();
      touchPoints.delete(ev.pointerId);
      if (touchPoints.size < 2) touchGesture.pinch = null;
    }
    state.mouse.dragging = false;
    clearLongPress();
    if (state.selection.drawing) {
      state.selection.drawing = false;
      finalizeSelection();
      setStatus("ready", "ok");
    }
  }

  function onPointerCancel(ev) {
    if (ev && typeof ev.pointerId === "number") {
      if (ev.pointerType === "touch") ev.preventDefault();
      touchPoints.delete(ev.pointerId);
      if (touchPoints.size < 2) touchGesture.pinch = null;
      if (touchGesture.longPressPointerId === ev.pointerId) clearLongPress();
    } else {
      touchPoints.clear();
      touchGesture.pinch = null;
      clearLongPress();
    }
    state.mouse.dragging = false;
  }

  function onPointerLeave() {
    state.mouse.in = false;
    state.mouse.dragging = false;
    clearLongPress();
  }

  function applyScaleAt(targetScale, sx, sy) {
    const ds = getActive();
    if (!ds) return;

    const before = screenToImage(sx, sy);
    const minS = minScaleFor(ds);
    ds.view.scale = clamp(targetScale, minS, 128);
    const after = screenToImage(sx, sy);

    ds.view.x += (before.x - after.x);
    ds.view.y += (before.y - after.y);

    clampView();
    els.zoom.value = String(scaleToSlider(ds.view.scale));
    updateZoomLabel();
    render();
  }

  function zoomAt(factor, sx, sy) {
    const ds = getActive();
    if (!ds) return;
    applyScaleAt(ds.view.scale * factor, sx, sy);
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

  function clearLongPress() {
    if (touchGesture.longPressTimer != null) {
      clearTimeout(touchGesture.longPressTimer);
    }
    touchGesture.longPressTimer = null;
    touchGesture.longPressPointerId = null;
    touchGesture.longPressStart = null;
  }

  function distance(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.hypot(dx, dy);
  }

  return {
    clearSelection,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onPointerLeave,
    onWheel,
    zoomAt
  };
}
