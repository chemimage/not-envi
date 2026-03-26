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
    onNeedWholeStats
  } = deps;

  let nextDatasetId = 1;

  function getActive() {
    return state.datasets.find((d) => d.id === state.activeId) || null;
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

  function setActiveDataset(id, { fit = false, preserveBandTreeScroll = false } = {}) {
    state.activeId = id;
    closeSpectrum();
    onAfterDatasetUIUpdate({ preserveBandTreeScroll });
    const ds = getActive();
    updateZoomRange(ds);
    if (fit) fitToScreen();
    else render();
  }

  function makeDatasetFromLoadedFiles({ hdrFile, dataFile, meta, base, cached }) {
    const initialBand = (meta.defaultBands && meta.defaultBands.length) ? meta.defaultBands[0] : 0;
    const ds = {
      id: `ds${nextDatasetId++}`,
      name: guessDatasetName(hdrFile, dataFile),
      meta,
      ds: cached,
      baseDs: base,
      view: { x: 0, y: 0, scale: 1 },
      activeBand: clamp(initialBand, 0, meta.bands - 1),
      bandSettings: new Map(),
      bandStatsWhole: new Map(),
      bandStatsSelection: null,
      bandStatsView: null,
      drawings: [],
      selectedAreaId: null,
      thumb: { ready: false, _t: 0, scale: 1, x0: 0, y0: 0, w: 0, h: 0 },
      treeExpanded: true,
      displaySlot: 0,
      displayMode: "gray",
      displayAdjustColor: "red",
      pyramid: null,
      lastRaster: null,
      lastCompositeRaster: null
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
  }

  function attachDataset(ds) {
    const occupied = new Set(state.datasets.map((item) => Number(item.displaySlot || 0)));
    if (!occupied.has(1)) ds.displaySlot = 1;
    else if (!occupied.has(2)) ds.displaySlot = 2;
    else ds.displaySlot = 0;
    state.datasets.unshift(ds);
    recomputeCacheBudgets();
    setActiveDataset(ds.id, { fit: true });
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
    const idx = state.datasets.findIndex((d) => d.id === id);
    if (idx === -1) return;
    const ds = state.datasets[idx];

    invalidateAsyncState();
    releaseDatasetResources(ds);

    state.datasets.splice(idx, 1);
    if (state.activeId === id) {
      state.activeId = state.datasets[0]?.id || null;
    }

    recomputeCacheBudgets();
    onAfterDatasetUIUpdate();
    clearSelection();
    render();
  }

  function closeAllDatasets() {
    if (!state.datasets.length) {
      invalidateAsyncState();
      clearSelection();
      render();
      return;
    }

    invalidateAsyncState();
    closeSpectrum();
    const datasets = state.datasets.splice(0, state.datasets.length);
    for (const ds of datasets) releaseDatasetResources(ds);
    state.activeId = null;

    recomputeCacheBudgets();
    onAfterDatasetUIUpdate();
    clearSelection();
    render();
  }

  return {
    getActive,
    setActiveDataset,
    bandLabel,
    addDatasetsFromFileList,
    addDatasetFromFiles,
    closeDataset,
    closeAllDatasets
  };
}
