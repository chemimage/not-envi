export function createSelectionSyncController(deps) {
  const {
    state,
    getActive,
    getHistogramSelectionItems,
    clearSelectionHistogram,
    refreshAnalysisHistogram,
    updateSelectionHistogram,
    getSpectrumOpenForDatasetId,
    openSpectrumForEffectiveArea,
    refreshAreaSpectrumIfOpen,
    drawOverlays,
    shouldAnimateMarquee
  } = deps;

  let marqueeTimer = null;

  function ensureMarqueeTicker() {
    const active = getActive();
    const hasSelections = getHistogramSelectionItems(active).length > 0;
    const shouldRun = hasSelections && (
      typeof shouldAnimateMarquee === "function"
        ? !!shouldAnimateMarquee(active)
        : true
    );
    if (shouldRun && marqueeTimer == null) {
      marqueeTimer = window.setInterval(() => {
        const ds = getActive();
        const stillHasSelections = getHistogramSelectionItems(ds).length > 0;
        const canAnimate = typeof shouldAnimateMarquee === "function"
          ? !!shouldAnimateMarquee(ds)
          : true;
        if (!stillHasSelections || !canAnimate) {
          clearInterval(marqueeTimer);
          marqueeTimer = null;
          return;
        }
        drawOverlays(ds);
      }, 90);
      return;
    }
    if (!shouldRun && marqueeTimer != null) {
      clearInterval(marqueeTimer);
      marqueeTimer = null;
    }
  }

  function updateSelectionHistogramForDataset(ds) {
    if (!ds) return;
    const selections = getHistogramSelectionItems(ds);
    if (!selections.length) {
      clearSelectionHistogram(ds);
      ensureMarqueeTicker();
      if (state.analysisHist.open && ds.id === state.activeId) refreshAnalysisHistogram().catch(() => {});
      return;
    }
    updateSelectionHistogram(ds, selections).then(() => {
      if (state.analysisHist.open && ds.id === state.activeId) refreshAnalysisHistogram().catch(() => {});
    }).catch(() => {});
    if (state.spectrumPickEnabled && ds.id === state.activeId && !getSpectrumOpenForDatasetId(ds.id)) {
      openSpectrumForEffectiveArea(ds, null, false).catch(() => {});
    } else {
      refreshAreaSpectrumIfOpen(ds, null, false);
    }
    ensureMarqueeTicker();
  }

  return {
    ensureMarqueeTicker,
    updateSelectionHistogramForDataset
  };
}
