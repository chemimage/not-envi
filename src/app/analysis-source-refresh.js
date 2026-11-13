// Refresh only visible results whose source geometry changed. Keep each
// result's original region membership, panel, and band during recalculation.
export function createAnalysisSourceRefresher({ comparisons, getDataset, getPanel, beginAnnotationWork, compute, publish }) {
  const pending = new Map();

  async function refreshSource(entry, ds, slot) {
    const panel = getPanel(slot);
    if (panel?.datasetId !== ds.id) return false;
    const drawings = panel.annotations?.drawings || [];
    const items = entry.sourceDescriptor.items.map(source => drawings.find(item => item.id === source.id));
    if (items.some(item => !item)) return false;
    const snapshot = items.map(item => ({ ...item, points: item.points.map(point => ({ ...point })) }));
    const geometry = snapshot.map(item => JSON.stringify(item.points));
    const token = {};
    pending.set(entry.id, token);
    const cancelled = () => pending.get(entry.id) !== token || getDataset(ds.id) !== ds || ds.ds?.closed
      || getPanel(slot) !== panel || panel.datasetId !== ds.id || !comparisons.isVisibleSource(entry)
      || snapshot.some((item, i) => {
        const current = panel.annotations?.drawings?.find(drawing => drawing.id === item.id);
        return !current || JSON.stringify(current.points) !== geometry[i];
      });
    const work = beginAnnotationWork?.(ds, { items: snapshot, slot, label: `Recalculating ${entry.kind}` });
    try {
      const result = await compute(entry, ds, snapshot, { cancelled,
        onProgress: (completed, total) => work?.update(completed, total) });
      if (!result || cancelled()) return false;
      publish(entry, ds, slot, snapshot, result);
      return true;
    } catch (error) {
      if (error?.name !== "AbortError" && !cancelled()) console.warn("Analysis source refresh failed", error);
      return false;
    } finally {
      work?.done();
      if (pending.get(entry.id) === token) pending.delete(entry.id);
    }
  }

  async function refresh(ds, slot, itemIds) {
    const entries = comparisons.changedAreaSources(ds.id, slot, itemIds);
    return Promise.all(entries.map(entry => refreshSource(entry, ds, slot)));
  }

  return { refresh };
}
