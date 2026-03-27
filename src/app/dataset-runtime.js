import {
  allocateDisplayLinkGroupId,
  clearDisplayPanel,
  cloneDisplayView,
  datasetsShareDisplaySize,
  ensureDisplayPanels,
  getActiveDisplayPanel,
  getDatasetDisplayPanels,
  getDisplayPanel,
  getVisibleDisplayPanels,
  panelHasLinkedPeers
} from "./display-panels.js";

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
    syncActiveDatasetView
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
    return n.replace(/\.hdr$/i, "").replace(/\.(img|dat|raw|bin|bip|bil|bsq)$/i, "");
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

  function updateActiveDataset(fit = false, preserveBandTreeScroll = false, closeSpectrumOnChange = true) {
    const panel = getActivePanel();
    const nextId = panel?.datasetId || null;
    state.activeId = nextId;
    if (typeof syncActiveDatasetView === "function") syncActiveDatasetView();
    if (closeSpectrumOnChange) closeSpectrum();
    onAfterDatasetUIUpdate({ preserveBandTreeScroll });
    const ds = getActive();
    updateZoomRange(ds);
    if (fit && ds) fitToScreen();
    else render();
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
    updateActiveDataset(!!opts.fit, !!opts.preserveBandTreeScroll, opts.closeSpectrumOnChange !== false);
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
      const activeDataset = findDatasetById(activePanel.datasetId);
      if (datasetsShareDisplaySize(targetDataset, activeDataset)) return activePanel;
    }

    for (const panel of getVisibleDisplayPanels(state)) {
      if (Number(panel.slot) === exclude) continue;
      const dataset = findDatasetById(panel.datasetId);
      if (datasetsShareDisplaySize(targetDataset, dataset)) return panel;
    }
    return null;
  }

  function setPanelLinkToSource(panel, sourcePanel) {
    if (!panel || !sourcePanel) return;
    panel.linkGroupId = Number(sourcePanel.linkGroupId) || allocateDisplayLinkGroupId(state);
    panel.view = sourcePanel.view || cloneDisplayView();
  }

  function makePanelUnique(panel, sourceView = null) {
    if (!panel) return;
    panel.linkGroupId = allocateDisplayLinkGroupId(state);
    panel.view = cloneDisplayView(sourceView || panel.view);
  }

  function assignDatasetToPanel(dataset, slot, opts = {}) {
    ensureDisplayPanels(state);
    const panel = getDisplayPanel(state, slot);
    if (!dataset || !panel) return false;

    const sameDatasetPanels = getDatasetDisplayPanels(state, dataset.id)
      .filter((item) => Number(item.slot) !== Number(panel.slot));
    panel.datasetId = dataset.id;
    if (sameDatasetPanels.length) {
      setPanelLinkToSource(panel, sameDatasetPanels[0]);
    } else {
      const compatible = findCompatibleLinkedPanel(dataset, panel.slot);
      if (compatible) setPanelLinkToSource(panel, compatible);
      else makePanelUnique(panel, dataset.view);
    }

    state.activePanelSlot = Number(panel.slot) || 1;
    updateActiveDataset(!!opts.fit, !!opts.preserveBandTreeScroll, opts.closeSpectrumOnChange !== false);
    return true;
  }

  function cycleDatasetPanel(id, slot, opts = {}) {
    const ds = findDatasetById(id);
    const panel = getDisplayPanel(state, slot);
    if (!ds || !panel) return false;

    if (String(panel.datasetId || "") !== String(ds.id)) {
      return assignDatasetToPanel(ds, slot, {
        fit: !!opts.fit,
        preserveBandTreeScroll: !!opts.preserveBandTreeScroll
      });
    }

    if (panelHasLinkedPeers(state, slot)) {
      makePanelUnique(panel, panel.view);
    } else {
      const compatible = findCompatibleLinkedPanel(ds, slot);
      if (!compatible) {
        state.activePanelSlot = Number(panel.slot) || state.activePanelSlot;
        updateActiveDataset(false, !!opts.preserveBandTreeScroll, false);
        return false;
      }
      setPanelLinkToSource(panel, compatible);
    }

    state.activePanelSlot = Number(panel.slot) || 1;
    updateActiveDataset(false, !!opts.preserveBandTreeScroll, false);
    return true;
  }

  function resolvePanelForDatasetSelection(dataset) {
    const assigned = getDatasetDisplayPanels(state, dataset?.id);
    if (assigned.length) return assigned[0];
    const empty = ensureDisplayPanels(state).find((panel) => !panel?.datasetId) || null;
    if (empty) return empty;
    return getDisplayPanel(state, state.activePanelSlot) || getDisplayPanel(state, 1);
  }

  function setActiveDataset(id, { fit = false, preserveBandTreeScroll = false, panelSlot = null } = {}) {
    const dataset = findDatasetById(id);
    if (!dataset) return;

    if (panelSlot != null) {
      assignDatasetToPanel(dataset, panelSlot, { fit, preserveBandTreeScroll });
      return;
    }

    const existing = getDatasetDisplayPanels(state, dataset.id);
    if (existing.length) {
      setActivePanel(existing[0].slot, { fit, preserveBandTreeScroll });
      return;
    }

    const panel = resolvePanelForDatasetSelection(dataset);
    if (!panel) return;
    assignDatasetToPanel(dataset, panel.slot, { fit, preserveBandTreeScroll });
  }

  function makeDatasetFromLoadedFiles({ hdrFile, dataFile, meta, base, cached }) {
    const initialBand = (meta.defaultBands && meta.defaultBands.length) ? meta.defaultBands[0] : 0;
    const ds = {
      id: `ds${nextDatasetId++}`,
      name: guessDatasetName(hdrFile, dataFile),
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
      treeExpanded: true,
      displayMode: "gray",
      displayAdjustColor: "red",
      pyramid: null,
      lastRaster: null,
      lastCompositeRaster: null,
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
    onNeedWholeStats(ds, ds.activeBand);
  }

  async function addDatasetsFromFileList(files) {
    const list = Array.from(files || []);
    if (!list.length) return;

    let result;
    try {
      result = await addDatasetsFromFileListMod(list, {
        setStatus,
        ioConcurrency: getIOConcurrency(),
        chunkSize: 1 << 20,
        cacheBytes: 128 * 1024 * 1024,
        createDataset: makeDatasetFromLoadedFiles
      });
    } catch (e) {
      console.error(e);
      alertFn((e && e.message) ? e.message : String(e));
      setStatus("error", "err");
      return;
    }

    const { datasets, missing, headersFound } = result;
    if (!headersFound) {
      alertFn("No .hdr file found. Please select/drop the ENVI header (.hdr) and its matching binary file.");
      return;
    }
    if (!datasets.length) {
      alertFn(`No complete ENVI pairs found.\n\nMissing data file for:\n${missing.join("\n")}`);
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
      chunkSize: 1 << 20,
      cacheBytes: 128 * 1024 * 1024,
      createDataset: makeDatasetFromLoadedFiles
    });
    attachDataset(ds);
  }

  function closeDataset(id) {
    const idx = state.datasets.findIndex((dataset) => String(dataset?.id || "") === String(id || ""));
    if (idx === -1) return;
    const ds = state.datasets[idx];

    invalidateAsyncState();
    releaseDatasetResources(ds);

    for (const panel of getDatasetDisplayPanels(state, id)) clearDisplayPanel(panel);
    state.datasets.splice(idx, 1);

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
