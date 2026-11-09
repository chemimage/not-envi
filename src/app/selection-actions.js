// Contextual analysis actions share the existing annotation and analysis controllers.
export function createSelectionActionsController(deps) {
  const {
    state, els, getActive, getActivePanel, getPanelRectDevice,
    getHistogramSelectionItems, screenToImage,
    beginDrawingAtPointer, updateDrawingAtPointer, finishDrawingAtPointer, cancelDrawing,
    beginAreaMoveAtPointer, updateAreaMoveAtPointer, finishAreaMoveAtPointer, cancelAreaMove,
    selectAreaAtPointer, openSpectrumAt, openSpectrumForEffectiveArea,
    closeSpectrum, setAnalysisHistogramOpen, closeAnalysisHistogramPanel,
    drawOverlays, onPointerDown
  } = deps;
  let gesture = null;
  let spaceHeld = false;
  const touchPanPointers = new Set();
  let dismissedKey = null;

  const slot = () => Number(getActivePanel()?.slot || 1);
  const isUi = (target) => !!target?.closest?.("[data-ui-surface]");
  const isEditable = (target) => !!target?.closest?.("input, textarea, select, [contenteditable='true']");
  const isPanGesture = (ev) => ev.button === 1 || spaceHeld
    || (ev.pointerType === "touch" && touchPanPointers.size > 0);
  const consume = (ev) => { ev.preventDefault(); ev.stopImmediatePropagation(); };

  function target() {
    const ds = getActive();
    if (!ds) return null;
    const point = state.contextPoint;
    if (point?.dsId === ds.id && point.slot === slot()) {
      return { ds, point, points: [point], key: `${ds.id}:${slot()}:point:${point.x},${point.y}` };
    }
    const items = getHistogramSelectionItems(ds);
    const points = items.flatMap((item) => item.points || []);
    if (!points.length) return null;
    return { ds, points, key: `${ds.id}:${slot()}:area:${items.map((item) => item.id).join(",")}` };
  }

  function viewport() {
    const rect = getPanelRectDevice();
    const dpr = window.devicePixelRatio || 1;
    return { x: (rect?.x || 0) / dpr, y: (rect?.y || 0) / dpr,
      w: (rect?.w || els.cpuCanvas.width) / dpr,
      h: (rect?.h || els.cpuCanvas.height) / dpr };
  }

  function refresh() {
    const toolbar = els.selectionActions;
    if (!toolbar) return;
    const current = target();
    const tool = state.draw.tool;
    if (!current || gesture || state.draw.draft || state.draw.areaMove
      || (tool !== "none" && tool !== "rect" && tool !== "shape") || dismissedKey === current.key) {
      toolbar.hidden = true;
      return;
    }
    const vp = viewport();
    const view = getActivePanel()?.view || current.ds.view;
    const pixelCenter = current.point ? 0.5 : 0;
    const xs = current.points.map((p) => vp.x + (p.x + pixelCenter - view.x) * view.scale);
    const ys = current.points.map((p) => vp.y + (p.y + pixelCenter - view.y) * view.scale);
    const left = Math.min(...xs), right = Math.max(...xs);
    const top = Math.min(...ys), bottom = Math.max(...ys);
    if (right < vp.x || left > vp.x + vp.w || bottom < vp.y || top > vp.y + vp.h) {
      toolbar.hidden = true;
      return;
    }
    els.btnToolHistogram.hidden = !!current.point;
    toolbar.hidden = false;
    els.btnToolSpectral.setAttribute("aria-pressed", String(!!state.spectrumPickEnabled));
    els.btnToolHistogram.setAttribute("aria-pressed", String(!!state.analysisHist.open));
    const gap = Number.parseFloat(window.getComputedStyle(toolbar).gap) || 4;
    const width = toolbar.offsetWidth || 36;
    const height = toolbar.offsetHeight || (current.point ? 36 : 72 + gap);
    const inset = 8;
    let x = right + gap;
    let y = current.point ? top + gap : top;
    const above = x + width > vp.x + vp.w - inset;
    if (above) {
      x = left;
      y = top - height - gap;
    }
    x = Math.max(vp.x + inset, Math.min(x, vp.x + vp.w - width - inset));
    y = Math.max(vp.y + inset, Math.min(y, vp.y + vp.h - height - inset));
    toolbar.dataset.placement = above ? "top" : "right";
    toolbar.style.left = `${x}px`;
    toolbar.style.top = `${y}px`;
  }

  function clearAnalysis() {
    state.spectrumPickEnabled = false;
    closeSpectrum();
    closeAnalysisHistogramPanel();
  }

  function imagePoint(ev) {
    const rect = els.main.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return screenToImage((ev.clientX - rect.left) * dpr, (ev.clientY - rect.top) * dpr);
  }

  function validPoint(point, ds) {
    return point && Number.isFinite(point.x) && Number.isFinite(point.y)
      && point.x >= 0 && point.y >= 0 && point.x < ds.meta.samples && point.y < ds.meta.lines;
  }

  function cancel() {
    const previous = gesture;
    gesture = null;
    if (previous?.type === "region") cancelDrawing();
    if (previous?.type === "move") cancelAreaMove(previous.start.pointerId);
    refresh();
  }

  function bind() {
    els.main.addEventListener("pointerdown", (ev) => {
      if (isUi(ev.target) || isPanGesture(ev) || ev.button !== 0 || state.selection.enabled) return;
      if (gesture && ev.pointerType === "touch" && ev.pointerId !== gesture.start.pointerId) {
        // Hand both pointers to the existing pinch/pan controller.
        const first = gesture.start;
        cancel();
        touchPanPointers.add(first.pointerId);
        touchPanPointers.add(ev.pointerId);
        onPointerDown(first);
        return;
      }
      if (state.draw.tool !== "none") return;
      const ds = getActive();
      if (!ds) return;
      if (!validPoint(imagePoint(ev), ds)) {
        dismissedKey = target()?.key;
        refresh();
        consume(ev);
        return;
      }
      dismissedKey = null;
      state.contextPoint = null;
      if (beginAreaMoveAtPointer(ev)) {
        gesture = { start: ev, type: "move", dsId: ds.id, slot: slot() };
      } else if (selectAreaAtPointer(ev)) {
        drawOverlays();
        consume(ev);
        return;
      } else {
        gesture = { start: ev, type: "pending", dsId: ds.id, slot: slot() };
        clearAnalysis();
      }
      refresh();
      consume(ev);
    }, true);

    window.addEventListener("pointermove", (ev) => {
      if (!gesture || gesture.start.pointerId !== ev.pointerId) return;
      if (getActive()?.id !== gesture.dsId || slot() !== gesture.slot) { cancel(); return; }
      if (gesture.type === "move") updateAreaMoveAtPointer(ev);
      else {
        const distance = Math.hypot(ev.clientX - gesture.start.clientX, ev.clientY - gesture.start.clientY);
        if (gesture.type === "pending" && distance >= 5) {
          gesture.type = "region";
          beginDrawingAtPointer(gesture.start, { tool: "rect", shapeMode: "rect" });
        }
        if (gesture.type === "region") updateDrawingAtPointer(ev);
      }
      consume(ev);
    }, true);

    window.addEventListener("pointerup", (ev) => {
      touchPanPointers.delete(ev.pointerId);
      if (!gesture || gesture.start.pointerId !== ev.pointerId) return;
      const finished = gesture;
      gesture = null;
      const ds = getActive();
      if (!ds || ds.id !== finished.dsId || slot() !== finished.slot) { cancelDrawing(); consume(ev); return; }
      if (finished.type === "region") finishDrawingAtPointer(ev);
      else if (finished.type === "move") finishAreaMoveAtPointer(ev);
      else {
        const point = imagePoint(ev);
        if (validPoint(point, ds)) {
          state.contextPoint = { dsId: ds.id, slot: slot(), x: Math.floor(point.x), y: Math.floor(point.y) };
        }
      }
      drawOverlays();
      consume(ev);
    }, true);

    window.addEventListener("pointercancel", (ev) => {
      touchPanPointers.delete(ev.pointerId);
      if (!gesture || gesture.start.pointerId !== ev.pointerId) return;
      cancel();
      consume(ev);
    }, true);
    window.addEventListener("keydown", (ev) => {
      if (isEditable(ev.target)) return;
      if (ev.code === "Space" && !ev.target?.closest?.("button, [role='button']")) {
        spaceHeld = true;
        ev.preventDefault();
      }
      if (ev.key === "Escape") {
        cancel();
        dismissedKey = target()?.key;
        refresh();
      }
    });
    window.addEventListener("keyup", (ev) => { if (ev.code === "Space") spaceHeld = false; });
    window.addEventListener("blur", () => { spaceHeld = false; touchPanPointers.clear(); cancel(); });
    window.addEventListener("resize", refresh);
  }

  async function openSpectral() {
    const current = target();
    if (!current) return;
    closeAnalysisHistogramPanel();
    state.spectrumPickEnabled = true;
    const box = els.selectionActions.getBoundingClientRect();
    const anchor = { clientX: box.right, clientY: box.top, pointerType: "mouse" };
    if (current.point) await openSpectrumAt(current.ds, current.point.x, current.point.y, { ...anchor, forcePoint: true });
    else await openSpectrumForEffectiveArea(current.ds, anchor, false);
    refresh();
  }

  function openSpatial() {
    if (!target() || target().point) return;
    state.spectrumPickEnabled = false;
    closeSpectrum();
    setAnalysisHistogramOpen(true);
    refresh();
  }

  return { bind, refresh, isPanGesture, openSpectral, openSpatial };
}
