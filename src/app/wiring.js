import { bindCoreEvents } from "../ui/events.js";

export function wireApp(deps) {
  const {
    state,
    els,
    clamp,
    getActive,
    closeSpectrum,
    exportSpectrumCSV,
    screenToImage,
    openSpectrumAt,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onPointerLeave,
    onWheel,
    onThumbClick,
    fitToScreen,
    clampView,
    scaleToSlider,
    updateZoomLabel,
    render,
    zoomAt,
    sliderToScale,
    minScaleFor,
    setIOParallel,
    clearSelection,
    setStatus,
    openExportDialog,
    updateExportDialogUI,
    updateExportEstimate,
    runExportFromDialog,
    rebuildBandTree,
    resetDisplay,
    autoDisplay,
    getBandSettings,
    drawHistogram,
    applyRangeFromNumbers,
    histPickHandle,
    applyHistogramDrag,
    addDatasetsFromFileList,
    resizeCanvases,
    redrawSpectrum,
    disposePyramid,
    updateMetaUI,
    updatePerf,
    getDrawTool,
    getSpectrumPickEnabled,
    getEffectiveAreaSelectionCount,
    getEffectiveAreaSelectionKey,
    getAreaSelectionMode,
    getDrawColor,
    setDrawTool,
    setSpectrumPickEnabled,
    setAreaSelectionMode,
    setDrawColor,
    selectAreaAtPointer,
    isAreaMovePointer,
    beginAreaMoveAtPointer,
    updateAreaMoveAtPointer,
    finishAreaMoveAtPointer,
    cancelAreaMove,
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
    updateZoomLabelBoot,
    setGpuBadgeAvailable
  } = deps;

  function runExportWithErrorHandling() {
    return runExportFromDialog().catch((err) => {
      console.error(err);
      alert("Export failed. See console for details.");
      setStatus("ready", "ok");
    });
  }

  function triggerSaveExport() {
    if (els.exportDlg && els.exportDlg.open) {
      runExportWithErrorHandling();
      return;
    }
    openExportDialog();
  }

  const spectralDrag = {
    activePointerId: null,
    lastDatasetId: null,
    lastIx: null,
    lastIy: null,
    lastAreaKey: "",
    inFlight: false,
    pending: null
  };

  function stopSpectralDrag() {
    spectralDrag.activePointerId = null;
    spectralDrag.pending = null;
    spectralDrag.lastAreaKey = "";
  }

  function eventToSpectrumTarget(ev) {
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

  function enqueueSpectrumUpdate(target) {
    if (!target || !target.ds) return;
    const sameTarget = target.areaKey
      ? (spectralDrag.lastDatasetId === target.ds.id && spectralDrag.lastAreaKey === target.areaKey)
      : (
        spectralDrag.lastDatasetId === target.ds.id
        && spectralDrag.lastIx === target.ix
        && spectralDrag.lastIy === target.iy
      );
    if (sameTarget && !spectralDrag.inFlight) return;

    if (spectralDrag.inFlight) {
      spectralDrag.pending = target;
      return;
    }

    spectralDrag.inFlight = true;
    spectralDrag.lastDatasetId = target.ds.id;
    spectralDrag.lastIx = target.ix;
    spectralDrag.lastIy = target.iy;
    spectralDrag.lastAreaKey = target.areaKey || "";
    Promise.resolve(openSpectrumAt(target.ds, target.ix, target.iy, {
      clientX: target.clientX,
      clientY: target.clientY,
      pointerType: target.pointerType
    })).catch((err) => {
      console.warn("Spectrum update failed", err);
    }).finally(() => {
      spectralDrag.inFlight = false;
      const pending = spectralDrag.pending;
      spectralDrag.pending = null;
      if (pending && getSpectrumPickEnabled && getSpectrumPickEnabled()) enqueueSpectrumUpdate(pending);
    });
  }

  window.addEventListener("beforeunload", () => {
    try {
      for (const ds of state.datasets) {
        if (ds && ds.pyramid) {
          disposePyramid(ds.pyramid);
          ds.pyramid = null;
        }
      }
    } catch (_err) {}
  });

  window.addEventListener("resize", () => {
    resizeCanvases();
    const ds = getActive();
    if (ds) fitToScreen();
    redrawSpectrum();
    if (positionAnalysisHistogramPanel) positionAnalysisHistogramPanel();
    if (refreshAnalysisHistogram) refreshAnalysisHistogram().catch(() => {});
  });

  function wireFlyoutPanel({
    panel,
    header,
    btnToggle,
    btnPin,
    collapseTitle = "Retract panel",
    expandTitle = "Expand panel"
  }) {
    if (!panel) return;
    const isOpen = () => panel.dataset.open !== "false";
    const isPinned = () => panel.dataset.pinned !== "false";
    const setOpen = (open) => {
      const nextOpen = !!open;
      panel.dataset.open = nextOpen ? "true" : "false";
      if (btnToggle) {
        btnToggle.textContent = nextOpen ? "Hide" : "Show";
        btnToggle.title = nextOpen ? collapseTitle : expandTitle;
        btnToggle.setAttribute("aria-expanded", nextOpen ? "true" : "false");
      }
    };
    const setPinned = (pinned, { forceOpen = true } = {}) => {
      const nextPinned = !!pinned;
      panel.dataset.pinned = nextPinned ? "true" : "false";
      if (btnPin) {
        btnPin.textContent = nextPinned ? "Pinned" : "Pin";
        btnPin.title = nextPinned ? "Unpin panel" : "Pin panel open";
        btnPin.setAttribute("aria-pressed", nextPinned ? "true" : "false");
      }
      if (nextPinned && forceOpen) setOpen(true);
    };

    setPinned(isPinned(), { forceOpen: false });
    setOpen(isOpen());
    if (isPinned() && !isOpen()) setOpen(true);

    if (btnToggle) {
      btnToggle.onclick = (ev) => {
        ev.stopPropagation();
        const nextOpen = !isOpen();
        if (!nextOpen) setPinned(false, { forceOpen: false });
        setOpen(nextOpen);
      };
    }
    if (btnPin) {
      btnPin.onclick = (ev) => {
        ev.stopPropagation();
        setPinned(!isPinned());
      };
    }
    if (header) {
      header.addEventListener("click", (ev) => {
        if (!ev.target) return;
        const target = ev.target;
        if (target.closest && target.closest("button")) return;
        if (!isOpen()) setOpen(true);
      });
    }
    panel.addEventListener("pointerenter", () => {
      if (!isPinned() && !isOpen()) setOpen(true);
    });
    panel.addEventListener("pointerleave", () => {
      if (!isPinned()) setOpen(false);
    });
  }

  wireFlyoutPanel({
    panel: els.right,
    header: els.rightHeader,
    btnToggle: els.btnRightToggle,
    btnPin: els.btnRightPin,
    collapseTitle: "Retract bands panel",
    expandTitle: "Expand bands panel"
  });
  wireFlyoutPanel({
    panel: els.displayPanel,
    header: els.displayHeader,
    btnToggle: els.btnDisplayToggle,
    btnPin: els.btnDisplayPin,
    collapseTitle: "Retract display panel",
    expandTitle: "Expand display panel"
  });

  function syncDrawToolUI() {
    const active = getDrawTool ? getDrawTool() : "none";
    const spectral = getSpectrumPickEnabled ? !!getSpectrumPickEnabled() : false;
    const areaMode = getAreaSelectionMode ? getAreaSelectionMode() : "group";
    const singleArea = areaMode === "single";
    if (els.toolRuler) els.toolRuler.classList.toggle("active", active === "ruler");
    if (els.toolRect) els.toolRect.classList.toggle("active", active === "rect");
    if (els.toolShape) els.toolShape.classList.toggle("active", active === "shape");
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
    if (els.btnToolSpectral) els.btnToolSpectral.classList.toggle("active", spectral);
    if (els.drawColor && getDrawColor) {
      const color = getDrawColor();
      els.drawColor.value = color;
      if (els.drawTools && els.drawTools.style) {
        els.drawTools.style.setProperty("--draw-color-preview", color);
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
    if (!active) stopSpectralDrag();
    if (!setSpectrumPickEnabled) return;
    setSpectrumPickEnabled(!!active);
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

  if (els.toolRuler && setDrawTool) els.toolRuler.onclick = () => { setDrawTool("ruler"); syncDrawToolUI(); };
  if (els.toolRect && setDrawTool) els.toolRect.onclick = () => { setDrawTool("rect"); syncDrawToolUI(); };
  if (els.toolShape && setDrawTool) els.toolShape.onclick = () => { setDrawTool("shape"); syncDrawToolUI(); };
  if (els.toolEraser && setDrawTool) els.toolEraser.onclick = () => { setDrawTool("eraser"); syncDrawToolUI(); };
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
    els.toolEraser.ondblclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (clearAllAnnotations) clearAllAnnotations();
      if (setDrawTool) {
        setDrawTool("none");
        setDrawTool("eraser");
      }
      syncDrawToolUI();
    };
  }
  if (els.drawColor && setDrawColor) {
    els.drawColor.oninput = () => {
      setDrawColor(els.drawColor.value);
      syncDrawToolUI();
      render({ reuseRaster: true });
    };
  }
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
  syncDrawToolUI();

  const isDrawCreateEnabled = () => !!(getDrawTool && getActive() && (getDrawTool() === "ruler" || getDrawTool() === "rect" || getDrawTool() === "shape"));
  const isEraserEnabled = () => !!(getDrawTool && getActive() && getDrawTool() === "eraser");
  const isDrawingEnabled = () => isDrawCreateEnabled() || isEraserEnabled();
  const isRulerEnabled = () => !!(getDrawTool && getActive() && getDrawTool() === "ruler");
  const isSingleAreaMode = () => !!(getAreaSelectionMode && getAreaSelectionMode() === "single");
  const isUiTarget = (target) => !!(target && target.closest && target.closest("#drawTools,#rightDock,#datasetDock,#thumbDock,#analysisHistPanel,#specPanel,header,dialog"));

  if (els.main && (beginAreaMoveAtPointer || selectAreaAtPointer)) {
    els.main.addEventListener("pointerdown", (ev) => {
      if (!isSingleAreaMode()) return;
      if (!getActive()) return;
      if (isDrawingEnabled()) return;
      if (state.selection && state.selection.enabled) return;
      if (isUiTarget(ev.target)) return;
      const startedMove = beginAreaMoveAtPointer ? beginAreaMoveAtPointer(ev) : false;
      if (!startedMove) {
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
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }, true);
    window.addEventListener("pointercancel", (ev) => {
      if (!isAreaMovePointer || !isAreaMovePointer(ev.pointerId)) return;
      if (cancelAreaMove) cancelAreaMove(ev.pointerId);
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }, true);
  }

  if (els.main && (beginDrawingAtPointer || eraseDrawingAtPointer)) {
    els.main.addEventListener("pointerdown", (ev) => {
      if (!isDrawingEnabled()) return;
      if (els.specPanel && els.specPanel.contains(ev.target)) return;
      if (isUiTarget(ev.target)) return;
      if (els.specPanel && els.specPanel.style.display !== "none" && !els.specPanel.contains(ev.target)) closeSpectrum();
      if (isEraserEnabled()) {
        if (eraseDrawingAtPointer) eraseDrawingAtPointer(ev);
        ev.preventDefault();
        ev.stopImmediatePropagation();
        return;
      }
      const started = beginDrawingAtPointer(ev);
      if (!started) return;
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
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }, true);
    window.addEventListener("pointercancel", (ev) => {
      if (!isDrawingPointer || !isDrawingPointer(ev.pointerId)) return;
      if (cancelDrawing) cancelDrawing();
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
    });
  }

  if (els.main) {
    els.main.addEventListener("pointerdown", (ev) => {
      if (!getSpectrumPickEnabled || !getSpectrumPickEnabled()) return;
      if (isDrawingEnabled()) return;
      if (state.selection && state.selection.enabled) return;
      if (isUiTarget(ev.target)) return;
      if (els.specPanel && els.specPanel.contains(ev.target)) return;
      const target = eventToSpectrumTarget(ev);
      if (!target) return;
      spectralDrag.activePointerId = ev.pointerId;
      enqueueSpectrumUpdate(target);
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }, true);

    window.addEventListener("pointermove", (ev) => {
      if (!getSpectrumPickEnabled || !getSpectrumPickEnabled()) return;
      if (spectralDrag.activePointerId == null || ev.pointerId !== spectralDrag.activePointerId) return;
      const target = eventToSpectrumTarget(ev);
      if (!target) return;
      enqueueSpectrumUpdate(target);
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }, true);

    window.addEventListener("pointerup", (ev) => {
      if (spectralDrag.activePointerId == null || ev.pointerId !== spectralDrag.activePointerId) return;
      stopSpectralDrag();
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }, true);

    window.addEventListener("pointercancel", (ev) => {
      if (spectralDrag.activePointerId == null || ev.pointerId !== spectralDrag.activePointerId) return;
      stopSpectralDrag();
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
      closeSpectrum();
    };
  }
  if (els.btnSpecCSV) {
    els.btnSpecCSV.onclick = (ev) => {
      ev.stopPropagation();
      exportSpectrumCSV();
    };
  }

  bindCoreEvents({
    els,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onWheel
    }
  });
  els.main.addEventListener("pointerleave", onPointerLeave);

  els.thumb.addEventListener("click", onThumbClick);

  els.btnFit.onclick = () => fitToScreen();
  els.btn100.onclick = () => {
    const ds = getActive();
    if (!ds) return;
    ds.view.scale = 1;
    clampView();
    els.zoom.value = String(scaleToSlider(ds.view.scale));
    updateZoomLabel();
    render();
  };
  els.btnZoomIn.onclick = () => zoomAt(1.25, els.cpuCanvas.width / 2, els.cpuCanvas.height / 2);
  els.btnZoomOut.onclick = () => zoomAt(0.8, els.cpuCanvas.width / 2, els.cpuCanvas.height / 2);

  els.zoom.oninput = () => {
    const ds = getActive();
    if (!ds) return;
    const s = sliderToScale(Number(els.zoom.value));
    const centerX = els.cpuCanvas.width / 2;
    const centerY = els.cpuCanvas.height / 2;
    const before = screenToImage(centerX, centerY);
    ds.view.scale = s;
    const minS = minScaleFor(ds);
    ds.view.scale = clamp(ds.view.scale, minS, 128);
    const after = screenToImage(centerX, centerY);
    ds.view.x += (before.x - after.x);
    ds.view.y += (before.y - after.y);
    clampView();
    els.zoom.value = String(scaleToSlider(ds.view.scale));
    updateZoomLabel();
    render();
  };

  els.chkGrid.oninput = () => render();
  els.chkScale.oninput = () => render();

  els.btnSelect.onclick = () => {
    const ds = getActive();
    if (!ds) return;
    state.selection.enabled = !state.selection.enabled;
    if (state.selection.enabled) {
      els.btnSelect.classList.add("primary");
      setStatus("select a region", "warn");
    } else {
      els.btnSelect.classList.remove("primary");
      clearSelection();
      setStatus("ready", "ok");
    }
  };

  els.btnExport.onclick = () => triggerSaveExport();

  els.expFormatPng.oninput = () => updateExportDialogUI();
  els.expFormatTiff.oninput = () => updateExportDialogUI();
  els.expModeRaw.oninput = () => updateExportDialogUI();
  els.expModeRendered.oninput = () => updateExportDialogUI();
  els.expRawScopeSel.oninput = () => updateExportEstimate();
  els.expRawScopeWhole.oninput = () => updateExportEstimate();
  els.expRenScopeSel.oninput = () => updateExportEstimate();
  els.expRenScopeView.oninput = () => updateExportEstimate();
  els.expRenScopeWhole.oninput = () => updateExportEstimate();
  if (els.expSelModeTogether) els.expSelModeTogether.oninput = () => updateExportEstimate();
  if (els.expSelModeSeparate) els.expSelModeSeparate.oninput = () => updateExportEstimate();

  els.btnExpCancel.onclick = () => {
    try { els.exportDlg.close(); } catch { els.exportDlg.open = false; }
  };
  els.btnExpGo.onclick = () => {
    runExportWithErrorHandling();
  };

  els.bandSearch.oninput = () => rebuildBandTree();
  els.btnExpandAll.onclick = () => {
    for (const ds of state.datasets) ds.treeExpanded = true;
    rebuildBandTree({ preserveScroll: true });
  };
  els.btnCollapseAll.onclick = () => {
    for (const ds of state.datasets) ds.treeExpanded = false;
    rebuildBandTree({ preserveScroll: true });
  };

  els.btnReset.onclick = () => {
    const ds = getActive();
    if (!ds) return;
    resetDisplay(ds);
  };
  els.btnAuto.onclick = () => {
    const ds = getActive();
    if (!ds) return;
    autoDisplay(ds);
  };

  els.slContrast.oninput = () => {
    const ds = getActive();
    if (!ds) return;
    const s = getBandSettings(ds, ds.activeBand);
    s.contrast = Number(els.slContrast.value);
    els.numContrast.value = Number(s.contrast).toFixed(2);
    drawHistogram(ds);
    render({ reuseRaster: true });
  };
  els.slBrightness.oninput = () => {
    const ds = getActive();
    if (!ds) return;
    const s = getBandSettings(ds, ds.activeBand);
    s.brightness = Number(els.slBrightness.value);
    els.numBrightness.value = Number(s.brightness).toFixed(2);
    drawHistogram(ds);
    render({ reuseRaster: true });
  };
  els.slGain.oninput = () => {
    const ds = getActive();
    if (!ds) return;
    const s = getBandSettings(ds, ds.activeBand);
    s.gain = Number(els.slGain.value);
    els.numGain.value = Number(s.gain).toFixed(2);
    drawHistogram(ds);
    render({ reuseRaster: true });
  };

  els.numContrast.onchange = () => {
    const ds = getActive();
    if (!ds) return;
    const s = getBandSettings(ds, ds.activeBand);
    const v = clamp(Number(els.numContrast.value), 0.1, 3);
    s.contrast = v;
    els.slContrast.value = String(v);
    els.numContrast.value = Number(v).toFixed(2);
    drawHistogram(ds);
    render({ reuseRaster: true });
  };
  els.numBrightness.onchange = () => {
    const ds = getActive();
    if (!ds) return;
    const s = getBandSettings(ds, ds.activeBand);
    const v = clamp(Number(els.numBrightness.value), -1, 1);
    s.brightness = v;
    els.slBrightness.value = String(v);
    els.numBrightness.value = Number(v).toFixed(2);
    drawHistogram(ds);
    render({ reuseRaster: true });
  };
  els.numGain.onchange = () => {
    const ds = getActive();
    if (!ds) return;
    const s = getBandSettings(ds, ds.activeBand);
    const v = clamp(Number(els.numGain.value), 0, 4);
    s.gain = v;
    els.slGain.value = String(v);
    els.numGain.value = Number(v).toFixed(2);
    drawHistogram(ds);
    render({ reuseRaster: true });
  };

  els.numMin.onchange = () => {
    const ds = getActive();
    if (!ds) return;
    applyRangeFromNumbers(ds);
    drawHistogram(ds);
    render({ reuseRaster: true });
  };
  els.numMax.onchange = () => {
    const ds = getActive();
    if (!ds) return;
    applyRangeFromNumbers(ds);
    drawHistogram(ds);
    render({ reuseRaster: true });
  };

  state.histMode = "whole";

  els.hist.addEventListener("pointerdown", (ev) => {
    const ds = getActive();
    if (!ds) return;
    const handle = histPickHandle(ds, ev.clientX, ev.clientY);
    if (!handle) return;
    state.histDrag.active = true;
    state.histDrag.handle = handle;
    els.hist.setPointerCapture(ev.pointerId);
    applyHistogramDrag(ds, handle, ev.clientX);
  });
  els.hist.addEventListener("pointermove", (ev) => {
    if (!state.histDrag.active) return;
    const ds = getActive();
    if (!ds) return;
    applyHistogramDrag(ds, state.histDrag.handle, ev.clientX);
  });
  els.hist.addEventListener("pointerup", (ev) => {
    state.histDrag.active = false;
    state.histDrag.handle = null;
    try { els.hist.releasePointerCapture(ev.pointerId); } catch (_err) {}
  });
  els.hist.addEventListener("pointercancel", () => {
    state.histDrag.active = false;
    state.histDrag.handle = null;
  });

  const triggerFilePicker = () => {
    try { els.filePicker.click(); } catch (_err) {}
  };
  const handleDroppedFiles = async (files) => {
    if (!files || !files.length) return;
    await addDatasetsFromFileList(files);
  };
  const setDropzoneActive = (active) => {
    if (!els.dropzone || !els.dropzone.classList) return;
    els.dropzone.classList[active ? "add" : "remove"]("dragover");
  };

  els.dropzone.addEventListener("click", (ev) => {
    const t = ev.target;
    if (t && t.closest && t.closest("a,button")) return;
    triggerFilePicker();
  });
  els.dropzone.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      triggerFilePicker();
    }
  });

  els.filePicker.onchange = async (ev) => {
    const files = ev.target.files;
    if (!files || !files.length) return;
    await handleDroppedFiles(files);
    els.filePicker.value = "";
  };

  els.dropzone.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    setDropzoneActive(true);
  });
  els.dropzone.addEventListener("dragleave", () => setDropzoneActive(false));
  els.dropzone.addEventListener("drop", async (ev) => {
    ev.preventDefault();
    setDropzoneActive(false);
    await handleDroppedFiles(ev.dataTransfer?.files);
  });

  els.main.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    setDropzoneActive(true);
  });
  els.main.addEventListener("dragleave", (ev) => {
    const rel = ev.relatedTarget;
    if (!rel || !els.main.contains(rel)) setDropzoneActive(false);
  });
  els.main.addEventListener("drop", async (ev) => {
    ev.preventDefault();
    setDropzoneActive(false);
    await handleDroppedFiles(ev.dataTransfer?.files);
  });

  resizeCanvases();
  setStatus("idle", "");
  updateMetaUI();
  updatePerf();
  updateZoomLabelBoot();
  setIOParallel(state.ioParallel);
  setGpuBadgeAvailable();
}
