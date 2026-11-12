export function createSelectionSyncController(deps) {
  const {
    getActive,
    getHistogramSelectionItems,
    clearSelectionHistogram,
    invalidateAnalysis,
    prioritizeSelection,
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
    clearSelectionHistogram(ds);
    invalidateAnalysis?.(ds);
    prioritizeSelection?.(ds, selections);
    ensureMarqueeTicker();
  }

  return {
    ensureMarqueeTicker,
    updateSelectionHistogramForDataset
  };
}
