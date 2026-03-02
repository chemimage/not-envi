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
    ensureViewHistogram,
    syncRangeInputsFromSettings,
    histPickHandle,
    applyHistogramDrag,
    addDatasetsFromFileList,
    resizeCanvases,
    redrawSpectrum,
    disposePyramid,
    updateMetaUI,
    updatePerf,
    updateZoomLabelBoot,
    setGpuBadgeAvailable
  } = deps;

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
  });

  els.main.addEventListener("dblclick", (ev) => {
    const ds = getActive();
    if (!ds) return;
    if (els.specPanel && els.specPanel.contains(ev.target)) return;
    const rect = els.main.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const sx = (ev.clientX - rect.left) * dpr;
    const sy = (ev.clientY - rect.top) * dpr;
    const img = screenToImage(sx, sy);
    const ix = clamp(Math.floor(img.x), 0, ds.meta.samples - 1);
    const iy = clamp(Math.floor(img.y), 0, ds.meta.lines - 1);
    openSpectrumAt(ds, ix, iy);
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

  els.btnExport.onclick = () => openExportDialog();

  els.expFormatPng.oninput = () => updateExportDialogUI();
  els.expFormatTiff.oninput = () => updateExportDialogUI();
  els.expModeRaw.oninput = () => updateExportDialogUI();
  els.expModeRendered.oninput = () => updateExportDialogUI();
  els.expRawScopeSel.oninput = () => updateExportEstimate();
  els.expRawScopeWhole.oninput = () => updateExportEstimate();
  els.expRenScopeSel.oninput = () => updateExportEstimate();
  els.expRenScopeView.oninput = () => updateExportEstimate();
  els.expRenScopeWhole.oninput = () => updateExportEstimate();

  els.btnExpCancel.onclick = () => {
    try { els.exportDlg.close(); } catch { els.exportDlg.open = false; }
  };
  els.btnExpGo.onclick = () => {
    runExportFromDialog().catch((err) => {
      console.error(err);
      alert("Export failed. See console for details.");
      setStatus("ready", "ok");
    });
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

  els.chkHistView.oninput = () => {
    const ds = getActive();
    state.histMode = els.chkHistView.checked ? "view" : "whole";
    if (!ds) return;
    if (state.histMode === "view") {
      ensureViewHistogram(ds);
    } else {
      ds.bandStatsView = null;
      syncRangeInputsFromSettings(ds, { force: true });
      drawHistogram(ds);
    }
  };

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

  els.dropzone.addEventListener("click", (ev) => {
    const t = ev.target;
    if (t && t.closest && t.closest("a,button")) return;
    try { els.filePicker.click(); } catch (_err) {}
  });
  els.dropzone.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      els.filePicker.click();
    }
  });

  els.filePicker.onchange = async (ev) => {
    const files = ev.target.files;
    if (!files || !files.length) return;
    await addDatasetsFromFileList(files);
    els.filePicker.value = "";
  };

  els.dropzone.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    els.dropzone.classList.add("dragover");
  });
  els.dropzone.addEventListener("dragleave", () => els.dropzone.classList.remove("dragover"));
  els.dropzone.addEventListener("drop", async (ev) => {
    ev.preventDefault();
    els.dropzone.classList.remove("dragover");
    const files = ev.dataTransfer?.files;
    if (!files || !files.length) return;
    await addDatasetsFromFileList(files);
  });

  resizeCanvases();
  setStatus("idle", "");
  updateMetaUI();
  updatePerf();
  updateZoomLabelBoot();
  setIOParallel(state.ioParallel);
  setGpuBadgeAvailable();
}
