export function createSpectralDragController(deps) {
  const {
    els,
    getActive,
    screenToImage,
    getEffectiveAreaSelectionKey,
    getSpectrumPickEnabled,
    openSpectrumAt,
    closeSpectrum,
    onTargetChange
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
    drag.lastDatasetId = null;
    drag.lastIx = null;
    drag.lastIy = null;
    drag.lastAreaKey = "";
  }

  function dismissSelection() {
    stop();
    if (typeof onTargetChange === "function") onTargetChange(null);
    if (typeof closeSpectrum === "function") closeSpectrum();
  }

  function eventToTarget(ev) {
    const ds = getActive();
    if (!ds) return null;
    const rect = els.main.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const sx = (ev.clientX - rect.left) * dpr;
    const sy = (ev.clientY - rect.top) * dpr;
    const img = screenToImage(sx, sy);
    const areaKey = getEffectiveAreaSelectionKey ? String(getEffectiveAreaSelectionKey(ds) || "") : "";
    const pointerType = ev.pointerType
      || ((ev.sourceCapabilities && ev.sourceCapabilities.firesTouchEvents) ? "touch" : "mouse");
    const rawX = Number(img?.x);
    const rawY = Number(img?.y);
    if (
      !Number.isFinite(rawX)
      || !Number.isFinite(rawY)
      || rawX < 0
      || rawY < 0
      || rawX >= ds.meta.samples
      || rawY >= ds.meta.lines
    ) {
      return { ds, outOfBounds: true, areaKey, clientX: ev.clientX, clientY: ev.clientY, pointerType };
    }
    const ix = Math.floor(rawX);
    const iy = Math.floor(rawY);
    return { ds, ix, iy, areaKey, clientX: ev.clientX, clientY: ev.clientY, pointerType };
  }

  function enqueueUpdate(target) {
    if (!target || !target.ds) return;
    if (target.outOfBounds) {
      if (drag.inFlight) {
        drag.pending = target;
        return;
      }
      dismissSelection();
      return;
    }
    const sameTarget = target.areaKey
      ? (drag.lastDatasetId === target.ds.id && drag.lastAreaKey === target.areaKey)
      : (drag.lastDatasetId === target.ds.id && drag.lastIx === target.ix && drag.lastIy === target.iy);
    if (sameTarget && !drag.inFlight) return;
    if (!target.areaKey && typeof onTargetChange === "function") {
      onTargetChange({
        dsId: target.ds.id,
        x: target.ix,
        y: target.iy
      });
    }

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

  function previewFromEvent(ev) {
    const target = eventToTarget(ev);
    return !!(target && !target.outOfBounds);
  }

  function beginFromEvent(ev) {
    const target = eventToTarget(ev);
    if (!target) return false;
    if (target.outOfBounds) {
      dismissSelection();
      return true;
    }
    drag.activePointerId = ev.pointerId;
    enqueueUpdate(target);
    return true;
  }

  function updateFromEvent(ev) {
    if (drag.activePointerId == null || ev.pointerId !== drag.activePointerId) return false;
    const target = eventToTarget(ev);
    if (!target) return false;
    if (target.outOfBounds) {
      dismissSelection();
      return true;
    }
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
    previewFromEvent,
    beginFromEvent,
    updateFromEvent,
    endFromEvent
  };
}
