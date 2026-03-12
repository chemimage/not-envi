export function createSpectralDragController(deps) {
  const {
    els,
    clamp,
    getActive,
    screenToImage,
    getEffectiveAreaSelectionKey,
    getSpectrumPickEnabled,
    openSpectrumAt
  } = deps;

  const drag = {
    activePointerId: null,
    lastDatasetId: null,
    lastIx: null,
    lastIy: null,
    lastAreaKey: "",
    inFlight: false,
    pending: null
  };

  function stop() {
    drag.activePointerId = null;
    drag.pending = null;
    drag.lastAreaKey = "";
  }

  function eventToTarget(ev) {
    const ds = getActive();
    if (!ds) return null;
    const rect = els.main.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const sx = (ev.clientX - rect.left) * dpr;
    const sy = (ev.clientY - rect.top) * dpr;
    const img = screenToImage(sx, sy);
    const ix = clamp(Math.floor(img.x), 0, ds.meta.samples - 1);
    const iy = clamp(Math.floor(img.y), 0, ds.meta.lines - 1);
    const areaKey = getEffectiveAreaSelectionKey ? String(getEffectiveAreaSelectionKey(ds) || "") : "";
    const pointerType = ev.pointerType
      || ((ev.sourceCapabilities && ev.sourceCapabilities.firesTouchEvents) ? "touch" : "mouse");
    return { ds, ix, iy, areaKey, clientX: ev.clientX, clientY: ev.clientY, pointerType };
  }

  function enqueueUpdate(target) {
    if (!target || !target.ds) return;
    const sameTarget = target.areaKey
      ? (drag.lastDatasetId === target.ds.id && drag.lastAreaKey === target.areaKey)
      : (drag.lastDatasetId === target.ds.id && drag.lastIx === target.ix && drag.lastIy === target.iy);
    if (sameTarget && !drag.inFlight) return;

    if (drag.inFlight) {
      drag.pending = target;
      return;
    }

    drag.inFlight = true;
    drag.lastDatasetId = target.ds.id;
    drag.lastIx = target.ix;
    drag.lastIy = target.iy;
    drag.lastAreaKey = target.areaKey || "";
    Promise.resolve(openSpectrumAt(target.ds, target.ix, target.iy, {
      clientX: target.clientX,
      clientY: target.clientY,
      pointerType: target.pointerType
    })).catch((err) => {
      console.warn("Spectrum update failed", err);
    }).finally(() => {
      drag.inFlight = false;
      const pending = drag.pending;
      drag.pending = null;
      if (pending && getSpectrumPickEnabled && getSpectrumPickEnabled()) enqueueUpdate(pending);
    });
  }

  function beginFromEvent(ev) {
    const target = eventToTarget(ev);
    if (!target) return false;
    drag.activePointerId = ev.pointerId;
    enqueueUpdate(target);
    return true;
  }

  function updateFromEvent(ev) {
    if (drag.activePointerId == null || ev.pointerId !== drag.activePointerId) return false;
    const target = eventToTarget(ev);
    if (!target) return false;
    enqueueUpdate(target);
    return true;
  }

  function endFromEvent(ev) {
    if (drag.activePointerId == null || ev.pointerId !== drag.activePointerId) return false;
    stop();
    return true;
  }

  return {
    stop,
    beginFromEvent,
    updateFromEvent,
    endFromEvent
  };
}
