import {
  allocateDisplayLinkGroupId,
  clearDisplayPanel,
  createDisplayAnnotationState,
  cloneDisplayView,
  datasetsShareDisplaySize,
  DISPLAY_COMPOSITION_OVERLAY,
  DISPLAY_COMPOSITION_SPLIT,
  ensureDisplayPanels,
  getActiveDisplayPanel,
  getDatasetDisplayPanels,
  getDisplayPanel,
  resolveDisplayPanelBand,
  getVisibleDisplayPanels,
  panelHasLinkedPeers
} from "./display-panels.js";
import { remapAnnotationState } from "./linked-annotations.js";
import { APP_CONFIG } from "./config.js";

export function createDatasetRuntime(deps) {
  const {
    state,
    clamp,
    fmtNoGroup,
    addDatasetsFromFileListMod,
    addDatasetFromFilesMod,
    setStatus,
    alertFn,
    getIOConcurrency,
    recomputeCacheBudgets,
    closeSpectrum,
    onAfterDatasetUIUpdate,
    updateZoomRange,
    fitToScreen,
    render,
    disposePyramid,
    clearSelection,
    onNeedWholeStats,
    syncActiveDatasetView,
    captureDisplayViewState,
    reflowDisplayViews,
    syncLinkedPanelView
  } = deps;

  let nextDatasetId = 1;

  function findDatasetById(id) {
    const key = String(id || "");
    if (!key) return null;
    return state.datasets.find((dataset) => String(dataset?.id || "") === key) || null;
  }

  function getActivePanel() {
    return getActiveDisplayPanel(state);
  }

  function getActive() {
    const panel = getActivePanel();
    if (panel?.datasetId) return findDatasetById(panel.datasetId);
    return findDatasetById(state.activeId);
  }

  function guessDatasetName(hdrFile, dataFile) {
    const n = hdrFile?.name || dataFile?.name || "dataset";
    return n
      .replace(/\.hdr$/i, "")
      .replace(/\.(img|dat|raw|bin|bip|bil|bsq)$/i, "")
      .replace(/\.(tif|tiff)$/i, "");
  }

  function bandLabel(ds, b) {
    if (!ds || !ds.meta) return `Band ${b}`;
    const names = ds.meta.bandNames;
    if (Array.isArray(names) && names[b] != null && String(names[b]).trim()) {
      return String(names[b]).trim();
    }
    const wl = ds.meta.wavelengths ? ds.meta.wavelengths[b] : null;
    if (wl != null && wl !== undefined) return fmtNoGroup(wl);
    return `Band ${b}`;
  }

  function updateActiveDataset(fit = false, closeSpectrumOnChange = true) {
    const panel = getActivePanel();
    const nextId = panel?.datasetId || null;
    state.activeId = nextId;
    if (typeof syncActiveDatasetView === "function") syncActiveDatasetView();
    recomputeCacheBudgets();
    if (closeSpectrumOnChange) closeSpectrum();
    onAfterDatasetUIUpdate();
    const ds = getActive();
    updateZoomRange(ds);
    if (fit && ds) fitToScreen();
    else render();
  }

  function clonePanelSnapshot(panel) {
    return {
      slot: Number(panel?.slot) || 1,
      datasetId: panel?.datasetId || null,
      linkGroupId: Number.isFinite(Number(panel?.linkGroupId)) ? Number(panel.linkGroupId) : null,
      activeBand: Number.isFinite(Number(panel?.activeBand)) ? Number(panel.activeBand) : null,
      annotations: createDisplayAnnotationState(panel?.annotations),
      view: cloneDisplayView(panel?.view)
    };
  }

  function captureSplitSnapshot() {
    ensureDisplayPanels(state);
    return {
      panels: state.displayPanels.map((panel) => clonePanelSnapshot(panel)),
      activePanelSlot: Number(state.activePanelSlot) || 1,
      activeId: state.activeId || null
    };
  }

  function rememberSplitSnapshot() {
    if (state.displayCompositionMode === DISPLAY_COMPOSITION_OVERLAY) return;
    state.displaySplitSnapshot = captureSplitSnapshot();
  }

  function clearSplitSnapshot() {
    state.displaySplitSnapshot = null;
  }

  function restoreSplitSnapshot() {
    const snapshot = state.displaySplitSnapshot;
    if (!snapshot || !Array.isArray(snapshot.panels) || !snapshot.panels.length) return false;
    ensureDisplayPanels(state);

    for (const panel of state.displayPanels) {
      const saved = snapshot.panels.find((item) => Number(item?.slot) === Number(panel.slot)) || null;
      if (!saved?.datasetId || !findDatasetById(saved.datasetId)) {
        clearDisplayPanel(panel);
        continue;
      }
      panel.datasetId = saved.datasetId;
      panel.linkGroupId = Number.isFinite(Number(saved.linkGroupId)) ? Number(saved.linkGroupId) : null;
      panel.activeBand = Number.isFinite(Number(saved.activeBand)) ? Number(saved.activeBand) : null;
      panel.annotations = createDisplayAnnotationState(saved.annotations);
      panel.view = cloneDisplayView(saved.view);
    }

    const savedActiveSlot = Number(snapshot.activePanelSlot);
    const savedActivePanel = getDisplayPanel(state, savedActiveSlot);
    state.activePanelSlot = savedActivePanel?.datasetId ? savedActiveSlot : (getActiveDisplayPanel(state)?.slot || 1);
    state.activeId = savedActivePanel?.datasetId || snapshot.activeId || null;
    setDisplayCompositionMode(DISPLAY_COMPOSITION_SPLIT, { preserveSplitSnapshot: true });
    clearSplitSnapshot();
    updateActiveDataset(false, false);
    return true;
  }

  function setDisplayCompositionMode(mode = DISPLAY_COMPOSITION_SPLIT, opts = {}) {
    state.displayCompositionMode = (mode === DISPLAY_COMPOSITION_OVERLAY)
      ? DISPLAY_COMPOSITION_OVERLAY
      : DISPLAY_COMPOSITION_SPLIT;
    if (state.displayCompositionMode !== DISPLAY_COMPOSITION_OVERLAY && !opts?.preserveSplitSnapshot) {
      clearSplitSnapshot();
    }
  }

  function hideDatasetFromPanel(id, slot) {
    ensureDisplayPanels(state);
    const panel = getDisplayPanel(state, slot);
    if (!panel || String(panel.datasetId || "") !== String(id || "")) return false;
    const viewSnapshot = (typeof captureDisplayViewState === "function") ? captureDisplayViewState() : null;
    clearDisplayPanel(panel);
    if (getVisibleDisplayPanels(state).length < 2) setDisplayCompositionMode(DISPLAY_COMPOSITION_SPLIT);
    if (typeof reflowDisplayViews === "function") reflowDisplayViews(viewSnapshot);
    updateActiveDataset(false, false);
    return true;
  }

  function setActivePanel(slot, opts = {}) {
    ensureDisplayPanels(state);
    const panel = getDisplayPanel(state, slot);
    if (!panel?.datasetId) return false;
    if (Number(state.activePanelSlot) === Number(panel.slot) && String(state.activeId || "") === String(panel.datasetId || "")) {
      if (typeof syncActiveDatasetView === "function") syncActiveDatasetView();
      return true;
    }
    state.activePanelSlot = Number(panel.slot) || 1;
    updateActiveDataset(!!opts.fit, opts.closeSpectrumOnChange !== false);
    return true;
  }

  function findCompatibleLinkedPanel(targetDataset, excludeSlot = null) {
    if (!targetDataset) return null;
    const exclude = Number(excludeSlot);
    const ownPanels = getDatasetDisplayPanels(state, targetDataset.id)
      .filter((panel) => Number(panel.slot) !== exclude);
    if (ownPanels.length) return ownPanels[0];

    const activePanel = getActivePanel();
    if (
      activePanel
      && Number(activePanel.slot) !== exclude
      && activePanel.datasetId
    ) {
      return activePanel;
    }

    for (const panel of getVisibleDisplayPanels(state)) {
      if (Number(panel.slot) === exclude) continue;
      return panel;
    }
    return null;
  }

  function setPanelLinkToSource(panel, sourcePanel) {
    if (!panel || !sourcePanel) return;
    const panelDataset = findDatasetById(panel.datasetId);
    const sourceDataset = findDatasetById(sourcePanel.datasetId);
    panel.linkGroupId = Number(sourcePanel.linkGroupId) || allocateDisplayLinkGroupId(state);
    if (panelDataset && sourceDataset && datasetsShareDisplaySize(panelDataset, sourceDataset)) {
      panel.annotations = sourcePanel.annotations || createDisplayAnnotationState();
    } else if (panelDataset?.meta && sourceDataset?.meta) {
      panel.annotations = remapAnnotationState(sourcePanel.annotations, sourceDataset.meta, panelDataset.meta);
    } else {
      panel.annotations = createDisplayAnnotationState(sourcePanel.annotations);
    }
    panel.view = cloneDisplayView(sourcePanel.view);
  }

  function makePanelUnique(panel, sourceView = null, sourceAnnotations = null) {
    if (!panel) return;
    panel.linkGroupId = allocateDisplayLinkGroupId(state);
    panel.annotations = createDisplayAnnotationState(sourceAnnotations || panel.annotations);
    panel.view = cloneDisplayView(sourceView || panel.view);
  }

  function assignDatasetToPanel(dataset, slot, opts = {}) {
    ensureDisplayPanels(state);
    const panel = getDisplayPanel(state, slot);
    if (!dataset || !panel) return false;
    const viewSnapshot = (typeof captureDisplayViewState === "function") ? captureDisplayViewState() : null;
    let linkedViewSourceSlot = null;

    const sameDatasetPanels = getDatasetDisplayPanels(state, dataset.id)
      .filter((item) => Number(item.slot) !== Number(panel.slot));
    const bandSourcePanel = sameDatasetPanels.find((item) => Number(item.slot) === Number(state.activePanelSlot)) || sameDatasetPanels[0] || null;
    panel.datasetId = dataset.id;
    if (sameDatasetPanels.length) {
      setPanelLinkToSource(panel, sameDatasetPanels[0]);
      linkedViewSourceSlot = Number(sameDatasetPanels[0].slot) || null;
    } else {
      const compatible = findCompatibleLinkedPanel(dataset, panel.slot);
      if (compatible) {
        setPanelLinkToSource(panel, compatible);
        linkedViewSourceSlot = Number(compatible.slot) || null;
      }
      else makePanelUnique(panel, dataset.view, {
        drawings: dataset.drawings,
        selectedAreaId: dataset.selectedAreaId
      });
    }
    panel.activeBand = resolveDisplayPanelBand(bandSourcePanel, dataset);
    if (typeof reflowDisplayViews === "function") reflowDisplayViews(viewSnapshot);
    if (linkedViewSourceSlot != null) {
      const sourcePanel = getDisplayPanel(state, linkedViewSourceSlot);
      if (sourcePanel?.view && Number(sourcePanel.slot) !== Number(panel.slot)) {
        if (typeof syncLinkedPanelView === "function") syncLinkedPanelView(sourcePanel, panel);
        else panel.view = cloneDisplayView(sourcePanel.view);
      }
    }

    setDisplayCompositionMode(opts.compositionMode || DISPLAY_COMPOSITION_SPLIT);
    state.activePanelSlot = Number(panel.slot) || 1;
    updateActiveDataset(!!opts.fit, opts.closeSpectrumOnChange !== false);
    return true;
  }

  function assignDatasetToOverlay(dataset, opts = {}) {
    ensureDisplayPanels(state);
    const panel1 = getDisplayPanel(state, 1);
    const panel2 = getDisplayPanel(state, 2);
    if (!dataset || !panel1 || !panel2) return false;
    rememberSplitSnapshot();

    const viewSnapshot = (typeof captureDisplayViewState === "function") ? captureDisplayViewState() : null;
    const existing1 = String(panel1.datasetId || "") === String(dataset.id) ? panel1 : null;
    const existing2 = String(panel2.datasetId || "") === String(dataset.id) ? panel2 : null;
    const sourcePanel = [existing1, existing2]
      .filter(Boolean)
      .find((panel) => Number(panel.slot) === Number(state.activePanelSlot))
      || existing1
      || existing2
      || findCompatibleLinkedPanel(dataset, null);
    const sourceView = sourcePanel?.view || dataset.view;
    const sourceAnnotations = sourcePanel?.annotations || {
      drawings: dataset.drawings,
      selectedAreaId: dataset.selectedAreaId
    };

    panel1.datasetId = dataset.id;
    if (Number(sourcePanel?.slot) === 1) {
      if (!Number.isFinite(Number(panel1.linkGroupId))) panel1.linkGroupId = allocateDisplayLinkGroupId(state);
      panel1.annotations = panel1.annotations || createDisplayAnnotationState(sourceAnnotations);
      panel1.view = cloneDisplayView(panel1.view || sourceView);
    } else {
      makePanelUnique(panel1, sourceView, sourceAnnotations);
    }
    panel1.activeBand = existing1
      ? resolveDisplayPanelBand(existing1, dataset)
      : resolveDisplayPanelBand(sourcePanel, dataset);

    panel2.datasetId = dataset.id;
    setPanelLinkToSource(panel2, panel1);
    panel2.activeBand = existing2
      ? resolveDisplayPanelBand(panel2, dataset)
      : resolveDisplayPanelBand(sourcePanel || panel1, dataset);

    if (typeof reflowDisplayViews === "function") reflowDisplayViews(viewSnapshot);
    if (sourcePanel?.view && typeof syncLinkedPanelView === "function") {
      if (Number(sourcePanel.slot) !== Number(panel1.slot)) syncLinkedPanelView(sourcePanel, panel1);
      syncLinkedPanelView(panel1, panel2);
    }
    setDisplayCompositionMode(DISPLAY_COMPOSITION_OVERLAY);
    if (![1, 2].includes(Number(state.activePanelSlot)) || String(getDisplayPanel(state, state.activePanelSlot)?.datasetId || "") !== String(dataset.id)) {
      state.activePanelSlot = 1;
    }
    updateActiveDataset(!!opts.fit, opts.closeSpectrumOnChange !== false);
    return true;
  }

  function cycleDatasetPanel(id, slot, opts = {}) {
    const ds = findDatasetById(id);
    if (!ds) return false;

    if (slot === "both") {
      const assigned = getDatasetDisplayPanels(state, ds.id).filter((panel) => Number(panel.slot) === 1 || Number(panel.slot) === 2);
      if (assigned.length === 2 && state.displayCompositionMode === DISPLAY_COMPOSITION_OVERLAY) {
        if (restoreSplitSnapshot()) return true;
        setDisplayCompositionMode(DISPLAY_COMPOSITION_SPLIT);
        updateActiveDataset(false, false);
        return true;
      }
      return assignDatasetToOverlay(ds, {
        fit: !!opts.fit
      });
    }

    const panel = getDisplayPanel(state, slot);
    if (!panel) return false;

    const otherPanel = getDisplayPanel(state, Number(slot) === 1 ? 2 : 1);
    if (
      state.displayCompositionMode === DISPLAY_COMPOSITION_OVERLAY
      && String(panel.datasetId || "") === String(ds.id)
      && String(otherPanel?.datasetId || "") === String(ds.id)
    ) {
      return setActivePanel(panel.slot, {
        fit: false,
        closeSpectrumOnChange: false
      });
    }

    if (String(panel.datasetId || "") !== String(ds.id)) {
      return assignDatasetToPanel(ds, slot, {
        fit: !!opts.fit,
        compositionMode: DISPLAY_COMPOSITION_SPLIT
      });
    }

    if (panelHasLinkedPeers(state, slot)) {
      makePanelUnique(panel, panel.view);
    } else {
      return hideDatasetFromPanel(id, slot);
    }

    state.activePanelSlot = Number(panel.slot) || 1;
    setDisplayCompositionMode(DISPLAY_COMPOSITION_SPLIT);
    updateActiveDataset(false, false);
    return true;
  }

  function resolvePanelForDatasetSelection(dataset) {
    const assigned = getDatasetDisplayPanels(state, dataset?.id);
    if (assigned.length) return assigned[0];
    const empty = ensureDisplayPanels(state).find((panel) => !panel?.datasetId) || null;
    if (empty) return empty;
    return getDisplayPanel(state, state.activePanelSlot) || getDisplayPanel(state, 1);
  }

  function setActiveDataset(id, { fit = false, panelSlot = null } = {}) {
    const dataset = findDatasetById(id);
    if (!dataset) return;

    if (panelSlot != null) {
      assignDatasetToPanel(dataset, panelSlot, { fit });
      return;
    }

    const existing = getDatasetDisplayPanels(state, dataset.id);
    if (existing.length) {
      setActivePanel(existing[0].slot, { fit });
      return;
    }

    const panel = resolvePanelForDatasetSelection(dataset);
    if (!panel) return;
    assignDatasetToPanel(dataset, panel.slot, { fit });
  }

  function makeDatasetFromLoadedFiles({ hdrFile, dataFile, meta, base, cached }) {
    const initialBand = (meta.defaultBands && meta.defaultBands.length) ? meta.defaultBands[0] : 0;
    const ds = {
      id: `ds${nextDatasetId++}`,
      name: guessDatasetName(hdrFile, dataFile),
      dataFile,
      meta,
      ds: cached,
      baseDs: base,
      view: { x: 0, y: 0, scale: 1, minScale: 1 },
      activeBand: clamp(initialBand, 0, meta.bands - 1),
      bandSettings: new Map(),
      bandStatsWhole: new Map(),
      bandStatsSelection: null,
      bandStatsView: null,
      drawings: [],
      selectedAreaId: null,
      thumb: { ready: false, _t: 0, scale: 1, x0: 0, y0: 0, w: 0, h: 0 },
      previewOverview: { ready: false, scale: 1, x0: 0, y0: 0, w: 0, h: 0, base: null, baseW: 0, baseH: 0 },
      displayMode: meta.defaultDisplayMode || "gray",
      displayAdjustColor: meta.defaultAdjustColor || "red",
      pyramid: null,
      prefetchMotion: null,
      lastRaster: null,
      lastCompositeRaster: null,
      lastRastersByPanel: new Map(),
      lastCompositeRastersByPanel: new Map(),
      lastScreenFrame: null,
      lastScreenFrames: new Map()
    };
    ds.bandSettings.set(ds.activeBand, { min: null, max: null, brightness: 0, gain: 1, contrast: 1, gamma: 1 });
    return ds;
  }

  function invalidateAsyncState() {
    if (state.histViewDebounce) {
      clearTimeout(state.histViewDebounce);
      state.histViewDebounce = null;
    }
    state.renderSeq = (Number.isFinite(state.renderSeq) ? state.renderSeq : 0) + 1;
  }

  function releaseDatasetResources(ds) {
    if (!ds) return;
    if (ds.pyramid) {
      try { disposePyramid(ds.pyramid); } catch (_err) {}
      ds.pyramid = null;
    }
    if (ds.ds) {
      if (typeof ds.ds.close === "function") {
        try { ds.ds.close(); } catch (_err) {}
      } else if (typeof ds.ds.clear === "function") {
        try { ds.ds.clear(); } catch (_err) {}
      }
    }
    if (ds.baseDs && typeof ds.baseDs.close === "function") {
      try { ds.baseDs.close(); } catch (_err) {}
    }
    ds.lastRaster = null;
    ds.lastCompositeRaster = null;
    ds.previewOverview = { ready: false, scale: 1, x0: 0, y0: 0, w: 0, h: 0, base: null, baseW: 0, baseH: 0 };
    if (ds.lastRastersByPanel && typeof ds.lastRastersByPanel.clear === "function") ds.lastRastersByPanel.clear();
    if (ds.lastCompositeRastersByPanel && typeof ds.lastCompositeRastersByPanel.clear === "function") ds.lastCompositeRastersByPanel.clear();
    ds.lastScreenFrame = null;
    if (ds.lastScreenFrames && typeof ds.lastScreenFrames.clear === "function") ds.lastScreenFrames.clear();
  }

  function attachDataset(ds) {
    state.datasets.unshift(ds);
    recomputeCacheBudgets();
    ensureDisplayPanels(state);
    const empty = state.displayPanels.find((panel) => !panel?.datasetId) || getDisplayPanel(state, state.activePanelSlot) || getDisplayPanel(state, 1);
    if (empty) {
      assignDatasetToPanel(ds, empty.slot, { fit: true });
    } else {
      onAfterDatasetUIUpdate();
      render();
    }
  }

  async function addDatasetsFromFileList(files) {
    const list = Array.from(files || []);
    if (!list.length) return;

    let result;
    try {
      result = await addDatasetsFromFileListMod(list, {
        setStatus,
        ioConcurrency: getIOConcurrency(),
        chunkSize: APP_CONFIG.io.defaultChunkSizeBytes,
        cacheBytes: APP_CONFIG.io.defaultDatasetCacheBytes,
        fmapEnabled: true,
        fmapOptions: APP_CONFIG.fmap,
        createDataset: makeDatasetFromLoadedFiles
      });
    } catch (e) {
      console.error(e);
      alertFn((e && e.message) ? e.message : String(e));
      setStatus("error", "err");
      return;
    }

    const { datasets, missing, headersFound, directFound } = result;
    if (!headersFound && !directFound) {
      alertFn("No supported dataset file found. Select ENVI (.hdr + data) files or TIFF (.tif/.tiff).");
      return;
    }
    if (!datasets.length) {
      if (headersFound && missing.length) {
        alertFn(`No complete ENVI pairs found.\n\nMissing data file for:\n${missing.join("\n")}`);
        return;
      }
      alertFn("No supported datasets could be opened from the selected files.");
      return;
    }

    for (const ds of datasets) attachDataset(ds);
    if (missing.length) {
      alertFn(`Some headers had no matching data file in your selection:\n\n${missing.join("\n")}`);
    }
  }

  async function addDatasetFromFiles(hdrFile, dataFile) {
    const ds = await addDatasetFromFilesMod(hdrFile, dataFile, {
      setStatus,
      ioConcurrency: getIOConcurrency(),
      chunkSize: APP_CONFIG.io.defaultChunkSizeBytes,
      cacheBytes: APP_CONFIG.io.defaultDatasetCacheBytes,
      fmapEnabled: true,
      fmapOptions: APP_CONFIG.fmap,
      createDataset: makeDatasetFromLoadedFiles
    });
    attachDataset(ds);
  }

  function closeDataset(id) {
    const idx = state.datasets.findIndex((dataset) => String(dataset?.id || "") === String(id || ""));
    if (idx === -1) return;
    const ds = state.datasets[idx];
    const viewSnapshot = (typeof captureDisplayViewState === "function") ? captureDisplayViewState() : null;

    invalidateAsyncState();
    releaseDatasetResources(ds);

    for (const panel of getDatasetDisplayPanels(state, id)) clearDisplayPanel(panel);
    state.datasets.splice(idx, 1);
    if (typeof reflowDisplayViews === "function") reflowDisplayViews(viewSnapshot);
    if (getVisibleDisplayPanels(state).length < 2) setDisplayCompositionMode(DISPLAY_COMPOSITION_SPLIT);
    else if (state.displayCompositionMode !== DISPLAY_COMPOSITION_OVERLAY) clearSplitSnapshot();

    const nextPanel = getActiveDisplayPanel(state);
    if (nextPanel?.datasetId) {
      state.activePanelSlot = Number(nextPanel.slot) || 1;
      state.activeId = nextPanel.datasetId;
    } else {
      state.activeId = state.datasets[0]?.id || null;
    }
    if (typeof syncActiveDatasetView === "function") syncActiveDatasetView();

    recomputeCacheBudgets();
    onAfterDatasetUIUpdate();
    clearSelection();
    render();
  }

  function closeAllDatasets() {
    invalidateAsyncState();
    closeSpectrum();
    if (state.datasets.length) {
      const datasets = state.datasets.splice(0, state.datasets.length);
      for (const ds of datasets) releaseDatasetResources(ds);
    }

    ensureDisplayPanels(state);
    for (const panel of state.displayPanels) clearDisplayPanel(panel);
    state.activeId = null;
    state.activePanelSlot = 1;
    setDisplayCompositionMode(DISPLAY_COMPOSITION_SPLIT);
    if (typeof syncActiveDatasetView === "function") syncActiveDatasetView();

    recomputeCacheBudgets();
    onAfterDatasetUIUpdate();
    clearSelection();
    render();
  }

  return {
    getActive,
    getActivePanel,
    getVisibleDisplayPanels: () => getVisibleDisplayPanels(state),
    setActiveDataset,
    setActivePanel,
    cycleDatasetPanel,
    bandLabel,
    addDatasetsFromFileList,
    addDatasetFromFiles,
    closeDataset,
    closeAllDatasets
  };
}
