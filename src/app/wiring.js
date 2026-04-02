import { bindCoreEvents } from "../ui/events.js";
import { wireFlyoutPanel } from "./wiring/flyout-panel.js";
import { wireDrawToolInteractions } from "./wiring/draw-tools.js";
import { createSpectralDragController } from "./wiring/spectral-drag.js";

export function wireApp(deps) {
  const {
    state,
    els,
    clamp,
    getActive,
    activatePanelAtClientPoint,
    getActiveViewportDevice,
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
    setScaleAt,
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
    resolveDisplayControlBand,
    cycleDisplayAdjustColor,
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
    getDrawShapeMode,
    getSpectrumPickEnabled,
    getEffectiveAreaSelectionCount,
    getEffectiveAreaSelectionKey,
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
    updateZoomLabelBoot,
    setGpuBadgeAvailable
  } = deps;

  const resolveCurrentDisplayBand = resolveDisplayControlBand;

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

  const spectralDrag = createSpectralDragController({
    els,
    clamp,
    getActive,
    screenToImage,
    getEffectiveAreaSelectionKey,
    getSpectrumPickEnabled,
    openSpectrumAt
  });

  const { resolveActiveViewportCenter } = wireDrawToolInteractions({
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
    onAnalysisHistogramPointerMove,
    onAnalysisHistogramPointerLeave,
    openSpectrumForEffectiveArea,
    cycleDisplayAdjustColor,
    triggerSaveExport,
    render,
    spectralDrag
  });

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

  const setGridEnabled = (enabled) => {
    const on = !!enabled;
    if (els.chkGrid) els.chkGrid.checked = on;
    if (els.btnGrid) {
      els.btnGrid.classList.toggle("active", on);
      els.btnGrid.setAttribute("aria-pressed", on ? "true" : "false");
    }
  };
  const getGridEnabled = () => !!(els.chkGrid && els.chkGrid.checked);
  setGridEnabled(getGridEnabled());

  if (els.btnFit) {
    els.btnFit.onclick = () => fitToScreen();
  }
  if (els.btnGrid) {
    els.btnGrid.onclick = () => {
      setGridEnabled(!getGridEnabled());
      render();
    };
  }
  if (els.btnZoomIn) {
    els.btnZoomIn.onclick = () => {
      const center = resolveActiveViewportCenter();
      zoomAt(1.25, center.x, center.y);
    };
  }
  if (els.btnZoomOut) {
    els.btnZoomOut.onclick = () => {
      const center = resolveActiveViewportCenter();
      zoomAt(0.8, center.x, center.y);
    };
  }

  if (els.zoom) {
    els.zoom.oninput = () => {
      const ds = getActive();
      if (!ds) return;
      const s = sliderToScale(Number(els.zoom.value));
      const center = resolveActiveViewportCenter();
      const centerX = center.x;
      const centerY = center.y;
      let nextScale = (typeof setScaleAt === "function")
        ? setScaleAt(s, centerX, centerY)
        : null;
      if (nextScale == null) {
        const before = screenToImage(centerX, centerY);
        ds.view.scale = s;
        const minS = minScaleFor(ds);
        ds.view.scale = clamp(ds.view.scale, minS, 128);
        const after = screenToImage(centerX, centerY);
        ds.view.x += (before.x - after.x);
        ds.view.y += (before.y - after.y);
        clampView();
        nextScale = ds.view.scale;
      }
      els.zoom.value = String(scaleToSlider(nextScale || ds.view.scale));
      updateZoomLabel();
      render();
    };
  }

  if (els.chkGrid) {
    els.chkGrid.oninput = () => {
      setGridEnabled(!!els.chkGrid.checked);
      render();
    };
  }

  if (els.btnSelect) {
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
  }

  if (els.btnExport) {
    els.btnExport.onclick = () => triggerSaveExport();
  }

  els.expFormatPng.oninput = () => updateExportDialogUI();
  els.expFormatTiff.oninput = () => updateExportDialogUI();
  if (els.expFormatEnvi) els.expFormatEnvi.oninput = () => updateExportDialogUI();
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
    const band = resolveCurrentDisplayBand(ds);
    if (band == null) return;
    const s = getBandSettings(ds, band);
    s.contrast = Number(els.slContrast.value);
    els.numContrast.value = Number(s.contrast).toFixed(2);
    drawHistogram(ds);
    render({ reuseRaster: true });
  };
  els.slBrightness.oninput = () => {
    const ds = getActive();
    if (!ds) return;
    const band = resolveCurrentDisplayBand(ds);
    if (band == null) return;
    const s = getBandSettings(ds, band);
    s.brightness = Number(els.slBrightness.value);
    els.numBrightness.value = Number(s.brightness).toFixed(2);
    drawHistogram(ds);
    render({ reuseRaster: true });
  };
  els.slGain.oninput = () => {
    const ds = getActive();
    if (!ds) return;
    const band = resolveCurrentDisplayBand(ds);
    if (band == null) return;
    const s = getBandSettings(ds, band);
    s.gain = Number(els.slGain.value);
    els.numGain.value = Number(s.gain).toFixed(2);
    drawHistogram(ds);
    render({ reuseRaster: true });
  };

  els.numContrast.onchange = () => {
    const ds = getActive();
    if (!ds) return;
    const band = resolveCurrentDisplayBand(ds);
    if (band == null) return;
    const s = getBandSettings(ds, band);
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
    const band = resolveCurrentDisplayBand(ds);
    if (band == null) return;
    const s = getBandSettings(ds, band);
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
    const band = resolveCurrentDisplayBand(ds);
    if (band == null) return;
    const s = getBandSettings(ds, band);
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
    if (ev.stopPropagation) ev.stopPropagation();
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
  wireFlyoutPanel({
    panel: els.right,
    header: els.rightHeader,
    btnPin: els.btnRightPin
  });
  wireFlyoutPanel({
    panel: els.displayPanel,
    header: els.displayHeader,
    btnPin: els.btnDisplayPin
  });
}

