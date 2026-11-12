// Contextual analysis actions share the existing annotation and analysis controllers.
export function createSelectionActionsController(deps) {
  const {
    state, els, getActive, getActivePanel, getPanelRectDevice,
    getHistogramSelectionItems, screenToImage,
    beginDrawingAtPointer, updateDrawingAtPointer, finishDrawingAtPointer, cancelDrawing,
    beginAreaMoveAtPointer, updateAreaMoveAtPointer, finishAreaMoveAtPointer, cancelAreaMove,
    selectAreaAtPointer, openSpectrumAt, openSpectrumForEffectiveArea,
    closeSpectrum, setAnalysisHistogramOpen, closeAnalysisHistogramPanel,
    drawOverlays, onPointerDown, removeAreaAnnotations, annotationWork, getDataProgress
  } = deps;
  let gesture = null;
  let spaceHeld = false;
  const touchPanPointers = new Set();
  let dismissedKey = null;
  const progressBars = new Map();

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
    return { ds, items, points, key: `${ds.id}:${slot()}:area:${items.map((item) => item.id).join(",")}` };
  }

  function viewport() {
    const rect = getPanelRectDevice();
    const dpr = window.devicePixelRatio || 1;
    return { x: (rect?.x || 0) / dpr, y: (rect?.y || 0) / dpr,
      w: (rect?.w || els.cpuCanvas.width) / dpr,
      h: (rect?.h || els.cpuCanvas.height) / dpr };
  }

  function actionPlacement({ point, left, right, top, bottom, horizontal, vp, width, height, gap }) {
    const inset = 8;
    let placement = point ? "right" : horizontal ? "top" : "right";
    let x = horizontal && !point ? left : right + gap;
    let y = point ? top + gap : horizontal ? top - height - gap : top;
    if (!point && horizontal && y < vp.y + inset) {
      placement = "bottom";
      y = bottom + gap;
    } else if (!horizontal && x + width > vp.x + vp.w - inset) {
      placement = "left";
      x = left - width - gap;
    }
    return {
      placement,
      x: Math.max(vp.x + inset, Math.min(x, vp.x + vp.w - width - inset)),
      y: Math.max(vp.y + inset, Math.min(y, vp.y + vp.h - height - inset))
    };
  }

  function actionMetrics(point, horizontal) {
    const toolbar = els.selectionActions;
    const gap = Number.parseFloat(window.getComputedStyle(toolbar).gap) || 4;
    const buttons = Array.from(toolbar.querySelectorAll("button"))
      .filter((button) => !point || button !== els.btnToolHistogram);
    const sizes = buttons.map((button) => {
      const style = window.getComputedStyle(button);
      return { width: button.offsetWidth || Number.parseFloat(style.width) || 0,
        height: button.offsetHeight || Number.parseFloat(style.height) || 0 };
    });
    return { gap,
      width: sizes.length ? (horizontal ? sizes.reduce((sum, size) => sum + size.width, 0)
        + gap * (sizes.length - 1) : Math.max(...sizes.map((size) => size.width))) : toolbar.offsetWidth,
      height: sizes.length ? (horizontal ? Math.max(...sizes.map((size) => size.height))
        : sizes.reduce((sum, size) => sum + size.height, 0) + gap * (sizes.length - 1)) : toolbar.offsetHeight
    };
  }

  function refresh() {
    const toolbar = els.selectionActions;
    if (!toolbar) return;
    const current = target();
    refreshProgress();
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
    const horizontal = !!current.point || right - left >= bottom - top;
    toolbar.dataset.orientation = horizontal ? "horizontal" : "vertical";
    toolbar.setAttribute("aria-orientation", toolbar.dataset.orientation);
    toolbar.hidden = false;
    els.btnToolSpectral.setAttribute("aria-pressed", String(!!state.spectrumPickEnabled));
    els.btnToolHistogram.setAttribute("aria-pressed", String(!!state.analysisHist.open));
    const gap = Number.parseFloat(window.getComputedStyle(toolbar).gap) || 4;
    const width = toolbar.offsetWidth;
    const height = toolbar.offsetHeight;
    const { placement, x, y } = actionPlacement({ point: current.point, horizontal,
      left, right, top, bottom, vp, width, height, gap });
    toolbar.dataset.placement = placement;
    toolbar.style.left = `${x}px`;
    toolbar.style.top = `${y}px`;
  }

  function refreshProgress() {
    if (!annotationWork || !els.selectionActions?.parentElement) return;
    const ds = getActive();
    const panel = getActivePanel();
    const drawings = panel?.annotations?.drawings || ds?.drawings || [];
    const point = state.contextPoint && state.contextPoint.dsId === ds?.id && state.contextPoint.slot === slot()
      ? state.contextPoint : null;
    const running = annotationWork.list(ds, slot(), drawings, point);
    const selected = ds ? getHistogramSelectionItems(ds) : [];
    for (const item of selected) {
      const fraction = getDataProgress?.(ds, [item]);
      const work = running.find((entry) => entry.id === item.id);
      if (work) work.dataFraction = fraction;
      else if (fraction != null && fraction < 1) running.push({
        key: `area:${item.id}`, id: item.id, points: item.points,
        label: "Loading selected image detail", dataFraction: fraction, dataOnly: true
      });
    }
    const keep = new Set();
    const vp = viewport();
    const view = panel?.view || ds?.view;
    for (const work of running) {
      if (!view) continue;
      const points = work.point ? [work.point] : work.points;
      const xs = points.map((p) => vp.x + (p.x - view.x) * view.scale);
      const ys = points.map((p) => vp.y + (p.y - view.y) * view.scale);
      const left = Math.min(...xs), right = Math.max(...xs);
      const top = Math.min(...ys), bottom = Math.max(...ys);
      if (right < vp.x || left > vp.x + vp.w || bottom < vp.y || top > vp.y + vp.h) continue;
      keep.add(work.key);
      let bar = progressBars.get(work.key);
      if (!bar) {
        bar = document.createElement("div");
        bar.className = "annotation-progress";
        bar.setAttribute("role", "progressbar");
        bar.setAttribute("aria-valuemin", "0");
        bar.setAttribute("aria-valuemax", "100");
        for (const name of ["data", "analysis"]) {
          const lane = document.createElement("span");
          lane.className = `annotation-progress-${name}`;
          lane.setAttribute("aria-hidden", "true");
          bar.append(lane);
        }
        els.selectionActions.parentElement.append(bar);
        progressBars.set(work.key, bar);
      }
      const horizontal = !!work.point || right - left >= bottom - top;
      // Follow the same outside edge as the contextual actions, including their
      // viewport fallback. The bar stays on the region edge rather than moving
      // with the toolbar's inset/clamping.
      const { placement } = actionPlacement({ point: work.point, horizontal,
        left, right, top, bottom, vp, ...actionMetrics(work.point, horizontal) });
      const verticalEdge = placement === "left" ? left - 2 : right - 2;
      const horizontalEdge = placement === "bottom" ? bottom - 2 : top - 2;
      const edgeX = Math.max(vp.x, Math.min(verticalEdge, vp.x + vp.w - 4));
      const edgeY = Math.max(vp.y, Math.min(horizontalEdge, vp.y + vp.h - 4));
      const x = Math.max(vp.x, Math.min(left, vp.x + vp.w - 4));
      const y = Math.max(vp.y, Math.min(top, vp.y + vp.h - 4));
      bar.dataset.orientation = horizontal ? "horizontal" : "vertical";
      bar.style.left = `${horizontal ? x : edgeX}px`;
      bar.style.top = `${horizontal ? edgeY : y}px`;
      bar.style.width = `${horizontal ? Math.max(4, Math.min(work.point ? 76 : right - x, vp.x + vp.w - x)) : 4}px`;
      bar.style.height = `${horizontal ? 4 : Math.max(4, Math.min(bottom - y, vp.y + vp.h - y))}px`;
      bar.setAttribute("aria-label", work.label);
      bar.dataset.indeterminate = String(!work.dataOnly && work.fraction == null);
      const fraction = work.dataOnly ? work.dataFraction : work.fraction;
      if (fraction == null) bar.removeAttribute("aria-valuenow");
      else bar.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
      bar.setAttribute("aria-description", "Blue patterned fill: selected image detail at view resolution. Pale solid fill: requested analysis, including its data reads.");
      for (const [lane, value] of [[bar.firstChild, work.dataFraction],
        [bar.lastChild, work.dataOnly ? 0 : work.fraction]]) {
        lane.style.transform = value == null ? "" : (horizontal ? `scaleX(${value})` : `scaleY(${value})`);
        lane.hidden = lane === bar.firstChild && value == null;
      }
    }
    for (const [key, bar] of progressBars) {
      if (!keep.has(key)) { bar.remove(); progressBars.delete(key); }
    }
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
    state.spectrumPickEnabled = true;
    const box = els.selectionActions.getBoundingClientRect();
    const anchor = { clientX: box.right, clientY: box.top, pointerType: "mouse" };
    if (current.point) await openSpectrumAt(current.ds, current.point.x, current.point.y, { ...anchor, forcePoint: true });
    else await openSpectrumForEffectiveArea(current.ds, anchor, false);
    refresh();
  }

  function openSpatial() {
    if (!target() || target().point) return;
    setAnalysisHistogramOpen(true);
    refresh();
  }

  function removeAnnotation() {
    const current = target();
    if (!current) return;
    clearAnalysis();
    if (current.point) state.contextPoint = null;
    else removeAreaAnnotations(current.items.map((item) => item.id));
    drawOverlays();
    refresh();
  }

  return { bind, refresh, isPanGesture, openSpectral, openSpatial, removeAnnotation };
}
