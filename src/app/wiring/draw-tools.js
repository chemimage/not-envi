export function wireDrawToolInteractions(deps) {
  const {
    state,
    els,
    getActive,
    activatePanelAtClientPoint,
    getActiveViewportDevice,
    closeSpectrum,
    exportSpectrumCSV,
    getDrawTool,
    getDrawShapeMode,
    getSpectrumPickEnabled,
    getEffectiveAreaSelectionCount,
    getAreaSelectionMode,
    getDrawColor,
    setDrawTool,
    setDrawShapeMode,
    setSpectrumPickEnabled,
    setAreaSelectionMode,
    setDrawColor,
    selectAreaAtPointer,
    isAreaMovePointer,
    beginAreaMoveAtPointer,
    updateAreaMoveAtPointer,
    finishAreaMoveAtPointer,
    cancelAreaMove,
    resolvePointerCursor,
    isDrawingPointer,
    beginDrawingAtPointer,
    updateDrawingAtPointer,
    finishDrawingAtPointer,
    cancelDrawing,
    eraseDrawingAtPointer,
    clearAllAnnotations,
    updateRulerHoverAtPointer,
    clearRulerHover,
    toggleAnalysisHistogramPanel,
    getAnalysisHistogramOpen,
    setAnalysisHistogramOpen,
    closeAnalysisHistogramPanel,
    refreshAnalysisHistogram,
    positionAnalysisHistogramPanel,
    onAnalysisHistogramPointerMove,
    onAnalysisHistogramPointerLeave,
    openSpectrumForEffectiveArea,
    cycleDisplayAdjustColor,
    triggerSaveExport,
    render,
    spectralDrag
  } = deps;

  const SHAPE_MODE_META = {
    rect: { label: "", title: "Free rectangle" },
    "1:1": { label: "1:1", title: "Square 1:1" },
    "3:4": { label: "3:4", title: "Aspect ratio 3:4 or 4:3" },
    "9:16": { label: "9:16", title: "Aspect ratio 9:16 or 16:9" },
    polygon: { label: "Poly", title: "Polygon" }
  };

  function resolveShapeModeMeta(mode) {
    return SHAPE_MODE_META[mode] || SHAPE_MODE_META.rect;
  }

  function resolveShapeToolFromMode() {
    const mode = getDrawShapeMode ? getDrawShapeMode() : "rect";
    return mode === "polygon" ? "shape" : "rect";
  }

  let drawColorFlyoutOpen = false;
  let shapeModeFlyoutOpen = false;

  function setDrawColorFlyoutOpen(nextOpen) {
    drawColorFlyoutOpen = !!nextOpen;
    if (els.drawTools && els.drawTools.classList) {
      if (typeof els.drawTools.classList.toggle === "function") {
        els.drawTools.classList.toggle("draw-color-open", drawColorFlyoutOpen);
      } else if (drawColorFlyoutOpen && typeof els.drawTools.classList.add === "function") {
        els.drawTools.classList.add("draw-color-open");
      } else if (!drawColorFlyoutOpen && typeof els.drawTools.classList.remove === "function") {
        els.drawTools.classList.remove("draw-color-open");
      }
    }
    if (els.drawColorPreview && els.drawColorPreview.setAttribute) {
      els.drawColorPreview.setAttribute("aria-expanded", drawColorFlyoutOpen ? "true" : "false");
    }
    if (els.drawColorFlyout && els.drawColorFlyout.setAttribute) {
      els.drawColorFlyout.setAttribute("aria-hidden", drawColorFlyoutOpen ? "false" : "true");
    }
  }

  function setShapeModeFlyoutOpen(nextOpen) {
    shapeModeFlyoutOpen = !!nextOpen;
    if (els.drawTools && els.drawTools.classList) {
      if (typeof els.drawTools.classList.toggle === "function") {
        els.drawTools.classList.toggle("shape-mode-open", shapeModeFlyoutOpen);
      } else if (shapeModeFlyoutOpen && typeof els.drawTools.classList.add === "function") {
        els.drawTools.classList.add("shape-mode-open");
      } else if (!shapeModeFlyoutOpen && typeof els.drawTools.classList.remove === "function") {
        els.drawTools.classList.remove("shape-mode-open");
      }
    }
    if (els.toolShape && els.toolShape.setAttribute) {
      els.toolShape.setAttribute("aria-expanded", shapeModeFlyoutOpen ? "true" : "false");
    }
    if (els.shapeModeFlyout && els.shapeModeFlyout.setAttribute) {
      els.shapeModeFlyout.setAttribute("aria-hidden", shapeModeFlyoutOpen ? "false" : "true");
    }
  }

  function setCanvasCursor(cursor) {
    const value = cursor || "";
    if (els.main && els.main.style) els.main.style.cursor = value;
    if (els.cpuCanvas && els.cpuCanvas.style) els.cpuCanvas.style.cursor = value;
    if (els.gpuCanvas && els.gpuCanvas.style) els.gpuCanvas.style.cursor = value;
  }

  function syncDrawToolUI() {
    const active = getDrawTool ? getDrawTool() : "none";
    const shapeToolActive = active === "rect" || active === "shape";
    const spectral = getSpectrumPickEnabled ? !!getSpectrumPickEnabled() : false;
    if (!spectral && els.specPanel && els.specPanel.style.display !== "none") closeSpectrum();
    const areaMode = getAreaSelectionMode ? getAreaSelectionMode() : "group";
    const singleArea = areaMode === "single";
    if (els.toolRuler) els.toolRuler.classList.toggle("active", active === "ruler");
    if (els.toolRect) els.toolRect.classList.toggle("active", shapeToolActive);
    if (els.shapeModeAnchor && els.shapeModeAnchor.style) {
      els.shapeModeAnchor.style.display = shapeToolActive ? "" : "none";
    }
    if (!shapeToolActive && shapeModeFlyoutOpen) setShapeModeFlyoutOpen(false);
    const shapeMode = getDrawShapeMode ? getDrawShapeMode() : (active === "shape" ? "polygon" : "rect");
    const shapeModeMeta = resolveShapeModeMeta(shapeMode);
    if (els.toolShapeLabel) els.toolShapeLabel.textContent = shapeModeMeta.label;
    if (els.toolShapeIcon && els.toolShapeIcon.classList) {
      els.toolShapeIcon.classList.remove("fa-square", "fa-draw-polygon", "fa-regular", "fa-solid");
      if (shapeMode === "polygon") {
        els.toolShapeIcon.classList.add("fa-solid", "fa-draw-polygon");
      } else {
        els.toolShapeIcon.classList.add("fa-regular", "fa-square");
      }
    }
    if (els.toolShape && els.toolShape.classList) {
      els.toolShape.classList.toggle("draw-mode-trigger-polygon", shapeMode === "polygon");
    }
    if (els.toolShape) {
      els.toolShape.classList.toggle("active", shapeModeFlyoutOpen);
      if (els.toolShape.setAttribute) {
        els.toolShape.setAttribute("aria-label", `Shape mode: ${shapeModeMeta.title}`);
      }
      els.toolShape.title = `Shape mode: ${shapeModeMeta.title}`;
    }
    if (Array.isArray(els.shapeModeButtons)) {
      for (const btn of els.shapeModeButtons) {
        const on = String(btn?.dataset?.shapeMode || "") === shapeMode;
        if (btn && btn.classList) btn.classList.toggle("active", on);
        if (btn && btn.setAttribute) btn.setAttribute("aria-pressed", on ? "true" : "false");
      }
    }
    if (els.toolEraser) els.toolEraser.classList.toggle("active", active === "eraser");
    if (els.btnToolAreaMode) {
      els.btnToolAreaMode.classList.remove("active");
      els.btnToolAreaMode.setAttribute("aria-pressed", singleArea ? "true" : "false");
      els.btnToolAreaMode.title = singleArea ? "Selected area only" : "Union of all area";
      els.btnToolAreaMode.setAttribute("aria-label", singleArea ? "Selected area only" : "Union of all area");
    }
    if (els.iconToolAreaMode) {
      els.iconToolAreaMode.classList.remove("fa-object-group", "fa-object-ungroup");
      els.iconToolAreaMode.classList.add(singleArea ? "fa-object-ungroup" : "fa-object-group");
    }
    if (els.btnToolSpectral) {
      els.btnToolSpectral.classList.toggle("active", spectral);
      els.btnToolSpectral.setAttribute?.("aria-pressed", spectral ? "true" : "false");
    }
    if (getDrawColor) {
      const color = getDrawColor();
      if (els.drawTools && els.drawTools.style) {
        els.drawTools.style.setProperty("--draw-color-preview", color);
      }
      if (Array.isArray(els.drawColorSwatches)) {
        for (const sw of els.drawColorSwatches) {
          const on = String(sw?.dataset?.color || "").toLowerCase() === String(color).toLowerCase();
          if (sw && sw.classList) sw.classList.toggle("active", on);
          if (sw && sw.setAttribute) sw.setAttribute("aria-pressed", on ? "true" : "false");
        }
      }
    }
  }

  function setSpatialActive(active) {
    if (setAnalysisHistogramOpen) {
      setAnalysisHistogramOpen(!!active);
      return;
    }
    if (active) {
      if (toggleAnalysisHistogramPanel && !(els.btnToolHistogram && els.btnToolHistogram.classList.contains("active"))) {
        toggleAnalysisHistogramPanel();
      }
      return;
    }
    if (closeAnalysisHistogramPanel) closeAnalysisHistogramPanel();
  }

  function setSpectralActive(active) {
    if (!active) {
      spectralDrag.stop();
      closeSpectrum();
    }
    if (!setSpectrumPickEnabled) return;
    setSpectrumPickEnabled(!!active);
  }

  function reactivateDrawTool(tool) {
    if (!setDrawTool) return;
    setDrawTool("none");
    setDrawTool(tool);
  }

  function clearAllAnnotationsFromEraser(ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    if (ev && ev.stopPropagation) ev.stopPropagation();
    if (clearAllAnnotations) clearAllAnnotations();
    reactivateDrawTool("eraser");
    syncDrawToolUI();
  }

  function toggleSpatialMode() {
    const isOpen = getAnalysisHistogramOpen
      ? !!getAnalysisHistogramOpen()
      : !!(els.btnToolHistogram && els.btnToolHistogram.classList.contains("active"));
    const nextOpen = !isOpen;
    if (nextOpen && getSpectrumPickEnabled && getSpectrumPickEnabled()) setSpectralActive(false);
    setSpatialActive(nextOpen);
    syncDrawToolUI();
  }

  function toggleSpectralMode() {
    const isOn = getSpectrumPickEnabled ? !!getSpectrumPickEnabled() : false;
    const nextOn = !isOn;
    if (nextOn && getAnalysisHistogramOpen && getAnalysisHistogramOpen()) setSpatialActive(false);
    setSpectralActive(nextOn);
    if (nextOn && openSpectrumForEffectiveArea) {
      openSpectrumForEffectiveArea().catch(() => {});
    }
    syncDrawToolUI();
  }

  if (els.toolRuler && setDrawTool) {
    els.toolRuler.onclick = () => {
      setDrawTool("ruler");
      syncDrawToolUI();
    };
  }
  if (els.toolRect && setDrawTool) {
    els.toolRect.onclick = () => {
      setDrawTool(resolveShapeToolFromMode());
      syncDrawToolUI();
    };
  }
  if (els.toolShape && els.toolShape.addEventListener) {
    els.toolShape.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const active = getDrawTool ? getDrawTool() : "none";
      const shapeToolActive = active === "rect" || active === "shape";
      if (!shapeToolActive) return;
      setShapeModeFlyoutOpen(!shapeModeFlyoutOpen);
      syncDrawToolUI();
    });
  }
  if (Array.isArray(els.shapeModeButtons) && setDrawShapeMode) {
    for (const btn of els.shapeModeButtons) {
      if (!btn || !btn.addEventListener) continue;
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const mode = String(btn.dataset ? btn.dataset.shapeMode : "");
        setDrawShapeMode(mode);
        setShapeModeFlyoutOpen(false);
        syncDrawToolUI();
      });
    }
  }

  let eraserTouchLastTapAt = 0;
  let eraserTouchResetTimer = null;
  let eraserTouchSuppressClick = false;

  function resetEraserTouchTapState() {
    eraserTouchLastTapAt = 0;
    if (!eraserTouchResetTimer) return;
    clearTimeout(eraserTouchResetTimer);
    eraserTouchResetTimer = null;
  }

  if (els.toolEraser && setDrawTool) {
    if (els.toolEraser.addEventListener) {
      els.toolEraser.addEventListener("pointerup", (ev) => {
        if (ev.pointerType !== "touch") return;
        const tapAt = Number.isFinite(ev.timeStamp) ? ev.timeStamp : Date.now();
        const isDoubleTap = eraserTouchLastTapAt > 0 && (tapAt - eraserTouchLastTapAt) <= 360;
        resetEraserTouchTapState();
        if (!isDoubleTap) {
          eraserTouchLastTapAt = tapAt;
          eraserTouchResetTimer = setTimeout(() => {
            eraserTouchResetTimer = null;
            eraserTouchLastTapAt = 0;
          }, 420);
          return;
        }
        eraserTouchSuppressClick = true;
        clearAllAnnotationsFromEraser(ev);
      });
    }
    els.toolEraser.onclick = (ev) => {
      if (eraserTouchSuppressClick) {
        eraserTouchSuppressClick = false;
        if (ev && ev.preventDefault) ev.preventDefault();
        if (ev && ev.stopPropagation) ev.stopPropagation();
        return;
      }
      setDrawTool("eraser");
      syncDrawToolUI();
    };
  }
  if (els.btnToolAreaMode && setAreaSelectionMode) {
    els.btnToolAreaMode.onclick = () => {
      setAreaSelectionMode();
      syncDrawToolUI();
    };
  }
  if (els.btnToolSpectral && setSpectrumPickEnabled) {
    els.btnToolSpectral.onclick = () => {
      toggleSpectralMode();
    };
  }
  if (els.toolEraser) {
    els.toolEraser.ondblclick = (ev) => clearAllAnnotationsFromEraser(ev);
  }
  if (Array.isArray(els.drawColorSwatches) && setDrawColor) {
    for (const swatch of els.drawColorSwatches) {
      if (!swatch || !swatch.addEventListener) continue;
      swatch.addEventListener("click", () => {
        const color = swatch.dataset ? swatch.dataset.color : "";
        setDrawColor(color);
        setDrawColorFlyoutOpen(false);
        syncDrawToolUI();
        render({ reuseRaster: true });
      });
    }
  }
  if (els.drawColorPreview && els.drawColorPreview.addEventListener) {
    els.drawColorPreview.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      setDrawColorFlyoutOpen(!drawColorFlyoutOpen);
    });
  }
  window.addEventListener("pointerdown", (ev) => {
    const target = ev.target;
    if (drawColorFlyoutOpen) {
      if (!(target && target.closest && target.closest("#drawColorPreview,#drawColorSwatches"))) {
        setDrawColorFlyoutOpen(false);
      }
    }
    if (shapeModeFlyoutOpen) {
      if (!(target && target.closest && target.closest("#toolShape,#shapeModeFlyout"))) {
        setShapeModeFlyoutOpen(false);
        syncDrawToolUI();
      }
    }
  }, true);
  window.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (drawColorFlyoutOpen) setDrawColorFlyoutOpen(false);
    if (shapeModeFlyoutOpen) {
      setShapeModeFlyoutOpen(false);
      syncDrawToolUI();
    }
  });
  if (els.btnToolHistogram) {
    els.btnToolHistogram.onclick = () => {
      toggleSpatialMode();
    };
  }
  if (els.btnAnalysisHistClose) {
    els.btnAnalysisHistClose.onclick = () => {
      if (closeAnalysisHistogramPanel) closeAnalysisHistogramPanel();
    };
  }
  if (els.analysisHistCanvas && onAnalysisHistogramPointerMove) {
    els.analysisHistCanvas.addEventListener("pointermove", onAnalysisHistogramPointerMove);
    if (onAnalysisHistogramPointerLeave) {
      els.analysisHistCanvas.addEventListener("pointerleave", onAnalysisHistogramPointerLeave);
    }
  }
  if (els.btnToolExport) {
    els.btnToolExport.onclick = () => triggerSaveExport();
  }
  if (els.btnHistChannel) {
    els.btnHistChannel.onclick = (ev) => {
      ev.stopPropagation();
      const ds = getActive();
      if (!ds || !cycleDisplayAdjustColor) return;
      cycleDisplayAdjustColor(ds);
    };
  }

  setDrawColorFlyoutOpen(false);
  setShapeModeFlyoutOpen(false);
  syncDrawToolUI();

  const isDrawCreateEnabled = () => !!(
    getDrawTool
    && getActive()
    && (getDrawTool() === "ruler" || getDrawTool() === "rect" || getDrawTool() === "shape")
  );
  const isEraserEnabled = () => !!(getDrawTool && getActive() && getDrawTool() === "eraser");
  const isDrawingEnabled = () => isDrawCreateEnabled() || isEraserEnabled();
  const isRulerEnabled = () => !!(getDrawTool && getActive() && getDrawTool() === "ruler");
  const isAreaToolEnabled = () => !!(
    getDrawTool
    && getActive()
    && (getDrawTool() === "rect" || getDrawTool() === "shape")
  );
  const isUiTarget = (target) => !!(
    target
    && target.closest
    && target.closest("[data-ui-surface]")
  );

  function resolveActiveViewportCenter() {
    const viewport = (typeof getActiveViewportDevice === "function")
      ? getActiveViewportDevice()
      : { x: 0, y: 0, width: els.cpuCanvas.width, height: els.cpuCanvas.height };
    const x = Number(viewport.x || 0) + (Math.max(1, Number(viewport.width || viewport.w || els.cpuCanvas.width || 1)) * 0.5);
    const y = Number(viewport.y || 0) + (Math.max(1, Number(viewport.height || viewport.h || els.cpuCanvas.height || 1)) * 0.5);
    return { x, y };
  }

  if (els.main && activatePanelAtClientPoint) {
    els.main.addEventListener("pointerdown", (ev) => {
      if (isUiTarget(ev.target)) return;
      activatePanelAtClientPoint(ev.clientX, ev.clientY, {
        closeSpectrumOnChange: false
      });
    }, true);
  }

  if (els.main && (beginAreaMoveAtPointer || selectAreaAtPointer)) {
    els.main.addEventListener("pointerdown", (ev) => {
      if (!getActive()) return;
      const areaToolEnabled = isAreaToolEnabled();
      if (!areaToolEnabled && isDrawingEnabled()) return;
      if (state.selection && state.selection.enabled) return;
      if (isUiTarget(ev.target)) return;
      const startedMove = beginAreaMoveAtPointer ? beginAreaMoveAtPointer(ev) : false;
      if (!startedMove) {
        if (areaToolEnabled) return;
        const hit = selectAreaAtPointer ? selectAreaAtPointer(ev) : false;
        if (!hit) {
          const hasAreas = !!(getEffectiveAreaSelectionCount && getEffectiveAreaSelectionCount() > 0);
          if (!(getSpectrumPickEnabled && getSpectrumPickEnabled() && hasAreas)) return;
          ev.preventDefault();
          ev.stopImmediatePropagation();
          return;
        }
      }
      if (getSpectrumPickEnabled && getSpectrumPickEnabled() && openSpectrumForEffectiveArea) {
        openSpectrumForEffectiveArea(null, ev, false).catch(() => {});
      }
      if (resolvePointerCursor) setCanvasCursor(resolvePointerCursor(ev));
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }, true);
    window.addEventListener("pointermove", (ev) => {
      if (!isAreaMovePointer || !isAreaMovePointer(ev.pointerId)) return;
      if (updateAreaMoveAtPointer) updateAreaMoveAtPointer(ev);
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }, true);
    window.addEventListener("pointerup", (ev) => {
      if (!isAreaMovePointer || !isAreaMovePointer(ev.pointerId)) return;
      if (finishAreaMoveAtPointer) finishAreaMoveAtPointer(ev);
      if (resolvePointerCursor) setCanvasCursor(resolvePointerCursor(ev));
      else setCanvasCursor("");
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }, true);
    window.addEventListener("pointercancel", (ev) => {
      if (!isAreaMovePointer || !isAreaMovePointer(ev.pointerId)) return;
      if (cancelAreaMove) cancelAreaMove(ev.pointerId);
      setCanvasCursor("");
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }, true);
  }

  if (els.main && (beginDrawingAtPointer || eraseDrawingAtPointer)) {
    els.main.addEventListener("pointerdown", (ev) => {
      if (!isDrawingEnabled()) return;
      if (els.specPanel && els.specPanel.contains(ev.target)) return;
      if (isUiTarget(ev.target)) return;
      if (els.specPanel && els.specPanel.style.display !== "none" && !els.specPanel.contains(ev.target)) {
        closeSpectrum();
      }
      if (isEraserEnabled()) {
        if (eraseDrawingAtPointer) eraseDrawingAtPointer(ev);
        ev.preventDefault();
        ev.stopImmediatePropagation();
        return;
      }
      const started = beginDrawingAtPointer(ev);
      if (!started) return;
      if (resolvePointerCursor) setCanvasCursor(resolvePointerCursor(ev));
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }, true);
    window.addEventListener("pointermove", (ev) => {
      if (!isDrawingPointer || !isDrawingPointer(ev.pointerId)) return;
      updateDrawingAtPointer(ev);
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }, true);
    window.addEventListener("pointerup", (ev) => {
      if (!isDrawingPointer || !isDrawingPointer(ev.pointerId)) return;
      finishDrawingAtPointer(ev);
      if (resolvePointerCursor) setCanvasCursor(resolvePointerCursor(ev));
      else setCanvasCursor("");
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }, true);
    window.addEventListener("pointercancel", (ev) => {
      if (!isDrawingPointer || !isDrawingPointer(ev.pointerId)) return;
      if (cancelDrawing) cancelDrawing();
      setCanvasCursor("");
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }, true);
  }

  if (els.main && updateRulerHoverAtPointer) {
    els.main.addEventListener("pointermove", (ev) => {
      if (!isRulerEnabled()) {
        if (clearRulerHover) clearRulerHover();
        return;
      }
      if (isDrawingPointer && isDrawingPointer(ev.pointerId)) return;
      if (isUiTarget(ev.target)) {
        if (clearRulerHover) clearRulerHover();
        return;
      }
      updateRulerHoverAtPointer(ev);
    });
    els.main.addEventListener("pointerleave", () => {
      if (clearRulerHover) clearRulerHover();
      setCanvasCursor("");
    });
  }

  if (els.main && resolvePointerCursor) {
    els.main.addEventListener("pointermove", (ev) => {
      if (isUiTarget(ev.target)) {
        setCanvasCursor("");
        return;
      }
      const cursor = resolvePointerCursor(ev);
      setCanvasCursor(cursor);
    });
    els.main.addEventListener("pointerleave", () => {
      setCanvasCursor("");
    });
  }

  if (els.main) {
    els.main.addEventListener("pointerdown", (ev) => {
      if (!getSpectrumPickEnabled || !getSpectrumPickEnabled()) return;
      if (isDrawingEnabled()) return;
      if (state.selection && state.selection.enabled) return;
      if (isUiTarget(ev.target)) return;
      if (els.specPanel && els.specPanel.contains(ev.target)) return;
      const hasAreas = !!(getEffectiveAreaSelectionCount && getEffectiveAreaSelectionCount() > 0);
      if (hasAreas) return;
      if (els.specPanel && els.specPanel.style.display !== "none") closeSpectrum();
    });

    els.main.addEventListener("pointermove", (ev) => {
      if (!getSpectrumPickEnabled || !getSpectrumPickEnabled()) return;
      if (isDrawingEnabled()) return;
      if (state.selection && state.selection.enabled) return;
      if (isUiTarget(ev.target)) {
        setCanvasCursor("");
        return;
      }
      if (els.specPanel && els.specPanel.contains(ev.target)) {
        setCanvasCursor("");
        return;
      }
      const hasAreas = !!(getEffectiveAreaSelectionCount && getEffectiveAreaSelectionCount() > 0);
      if (hasAreas) {
        setCanvasCursor("");
        return;
      }
      const started = spectralDrag.previewFromEvent(ev);
      if (!started) {
        setCanvasCursor("");
        return;
      }
      setCanvasCursor("crosshair");
    });

    els.main.addEventListener("pointerdown", (ev) => {
      if (!getSpectrumPickEnabled || !getSpectrumPickEnabled()) return;
      if (isDrawingEnabled()) return;
      if (state.selection && state.selection.enabled) return;
      if (isUiTarget(ev.target)) return;
      if (els.specPanel && els.specPanel.contains(ev.target)) return;
      const hasAreas = !!(getEffectiveAreaSelectionCount && getEffectiveAreaSelectionCount() > 0);
      if (hasAreas) return;
      const started = spectralDrag.beginFromEvent(ev);
      if (!started) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }, true);

    window.addEventListener("pointermove", (ev) => {
      if (!getSpectrumPickEnabled || !getSpectrumPickEnabled()) return;
      const updated = spectralDrag.updateFromEvent(ev);
      if (!updated) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }, true);

    window.addEventListener("pointerup", (ev) => {
      const ended = spectralDrag.endFromEvent(ev);
      if (!ended) return;
      setCanvasCursor("");
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }, true);

    window.addEventListener("pointercancel", (ev) => {
      const ended = spectralDrag.endFromEvent(ev);
      if (!ended) return;
      setCanvasCursor("");
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }, true);
  }

  els.main.addEventListener("pointerdown", (ev) => {
    if (!els.specPanel || els.specPanel.style.display === "none") return;
    if (els.specPanel.contains(ev.target)) return;
    const hasAreas = !!(getEffectiveAreaSelectionCount && getEffectiveAreaSelectionCount() > 0);
    if (getSpectrumPickEnabled && getSpectrumPickEnabled() && hasAreas) return;
    closeSpectrum();
  });

  if (els.specPanel) {
    els.specPanel.addEventListener("dblclick", (ev) => ev.stopPropagation());
  }
  if (els.btnSpecClose) {
    els.btnSpecClose.onclick = (ev) => {
      ev.stopPropagation();
      if (setSpectrumPickEnabled) {
        setSpectralActive(false);
        syncDrawToolUI();
      } else {
        closeSpectrum();
      }
    };
  }
  if (els.btnSpecCSV) {
    els.btnSpecCSV.onclick = (ev) => {
      ev.stopPropagation();
      exportSpectrumCSV();
    };
  }

  return { resolveActiveViewportCenter };
}
