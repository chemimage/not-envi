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
    activatePanelAtClientPoint,
    clamp,
    setStatus,
    updateHud,
    screenToImage,
    clampView,
    schedulePreviewRender,
    scheduleRender,
    render,
    minScaleFor,
    scaleToSlider,
    updateZoomLabel,
    panByPixels,
    setScaleAt
  } = deps;

  const touchPoints = new Map();
  const touchGesture = {
    pinch: null
  };
  const requestRender = (typeof scheduleRender === "function") ? scheduleRender : render;
  const requestPreview = (typeof schedulePreviewRender === "function") ? schedulePreviewRender : requestRender;
  let settleRenderTimer = null;
  const isUiTarget = (target) => !!(
    target
    && target.closest
    && target.closest("[data-ui-surface]")
  );

  function clearSettledRender() {
    if (!settleRenderTimer) return;
    clearTimeout(settleRenderTimer);
    settleRenderTimer = null;
  }

  function deferSettledRender() {
    clearSettledRender();
    settleRenderTimer = setTimeout(() => {
      settleRenderTimer = null;
      requestRender();
    }, 90);
  }

  function flushSettledRender() {
    clearSettledRender();
    requestRender();
  }

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
    if (isUiTarget(ev.target)) return;
    if (activatePanelAtClientPoint) activatePanelAtClientPoint(ev.clientX, ev.clientY, { closeSpectrumOnChange: false });
    const ds = getActive();
    if (!ds) return;
    if (ev.pointerType === "touch") ev.preventDefault();
    if (ev.pointerType === "touch") clearSettledRender();
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

      if (touchPoints.size === 2) {
        const pts = Array.from(touchPoints.values());
        touchGesture.pinch = {
          lastDist: distance(pts[0], pts[1]),
          lastScale: Number(ds.view?.scale) || 1
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

      if (touchPoints.size === 2 && touchGesture.pinch && ds && !state.selection.drawing) {
        const pts = Array.from(touchPoints.values());
        const dist = distance(pts[0], pts[1]);
        const prevDist = Number(touchGesture.pinch.lastDist) || 0;
        const prevScale = Number(touchGesture.pinch.lastScale) || Number(ds.view?.scale) || 1;
        if (dist > 0 && prevDist > 0) {
          const factor = dist / prevDist;
          const midX = (pts[0].x + pts[1].x) * 0.5;
          const midY = (pts[0].y + pts[1].y) * 0.5;
          const dpr = window.devicePixelRatio || 1;
          const appliedScale = applyScaleAt(
            prevScale * factor,
            (midX - rect.left) * dpr,
            (midY - rect.top) * dpr,
            { interactive: true, deferSettled: false }
          );
          touchGesture.pinch.lastScale = Number.isFinite(appliedScale) && appliedScale > 0 ? appliedScale : prevScale;
          touchGesture.pinch.lastDist = dist;
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

      const handledPan = (typeof panByPixels === "function") ? panByPixels(dx, dy) : false;
      if (!handledPan) {
        ds.view.x -= dx / ds.view.scale;
        ds.view.y -= dy / ds.view.scale;
        clampView();
      }
      if (ev.pointerType === "touch") {
        requestPreview();
        deferSettledRender();
      } else {
        requestRender();
      }
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
      if (touchPoints.size < 2) {
        touchGesture.pinch = null;
        const remaining = Array.from(touchPoints.values())[0];
        if (remaining) {
          state.mouse.lastX = remaining.x - (Number(els.main?.getBoundingClientRect?.().left) || 0);
          state.mouse.lastY = remaining.y - (Number(els.main?.getBoundingClientRect?.().top) || 0);
        }
      }
      if (touchPoints.size === 0) flushSettledRender();
      else deferSettledRender();
    }
    state.mouse.dragging = false;
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
      if (touchPoints.size < 2) {
        touchGesture.pinch = null;
        const remaining = Array.from(touchPoints.values())[0];
        if (remaining) {
          state.mouse.lastX = remaining.x - (Number(els.main?.getBoundingClientRect?.().left) || 0);
          state.mouse.lastY = remaining.y - (Number(els.main?.getBoundingClientRect?.().top) || 0);
        }
      }
      if (touchPoints.size === 0) flushSettledRender();
      else deferSettledRender();
    } else {
      touchPoints.clear();
      touchGesture.pinch = null;
      flushSettledRender();
    }
    state.mouse.dragging = false;
  }

  function onPointerLeave() {
    state.mouse.in = false;
    state.mouse.dragging = false;
  }

  function applyScaleAt(targetScale, sx, sy, { interactive = false, deferSettled = interactive } = {}) {
    const ds = getActive();
    if (!ds) return null;

    let appliedScale = null;
    if (typeof setScaleAt === "function") {
      appliedScale = setScaleAt(targetScale, sx, sy);
    }
    if (appliedScale == null) {
      const before = screenToImage(sx, sy);
      const minS = minScaleFor(ds);
      ds.view.scale = clamp(targetScale, minS, 128);
      const after = screenToImage(sx, sy);

      ds.view.x += (before.x - after.x);
      ds.view.y += (before.y - after.y);

      clampView();
      appliedScale = ds.view.scale;
    }
    els.zoom.value = String(scaleToSlider(appliedScale || ds.view.scale));
    updateZoomLabel();
    if (interactive) {
      requestPreview();
      if (deferSettled) deferSettledRender();
    } else {
      requestRender();
    }
    return appliedScale || ds.view.scale;
  }

  function zoomAt(factor, sx, sy) {
    const ds = getActive();
    if (!ds) return;
    applyScaleAt(ds.view.scale * factor, sx, sy);
  }

  function onWheel(ev) {
    if (isUiTarget(ev.target)) return;
    if (activatePanelAtClientPoint) activatePanelAtClientPoint(ev.clientX, ev.clientY, { closeSpectrumOnChange: false });
    const ds = getActive();
    if (!ds) return;
    ev.preventDefault();
    const rect = els.main.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const sx = (ev.clientX - rect.left) * dpr;
    const sy = (ev.clientY - rect.top) * dpr;

    const factor = ev.deltaY < 0 ? 1.25 : 0.8;
    applyScaleAt(ds.view.scale * factor, sx, sy, { interactive: true });
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
