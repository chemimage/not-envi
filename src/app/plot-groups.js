// Plot membership is independent of annotations and calculated data. Moving a
// trace never merges regions, averages values, or initiates a source read.
export function createPlotGroups({ maxEntries = 48, maxGroups = 12, maxTraces = 8 } = {}) {
  const entries = new Map();
  const groups = new Map();
  const creationOrder = new Map();
  let nextGroup = 0, nextEntry = 0;

  function remove(id) {
    entries.delete(id);
    creationOrder.delete(id);
    for (const [key, group] of groups) {
      group.ids = group.ids.filter((item) => item !== id);
      if (!group.ids.length) groups.delete(key);
    }
  }

  function upsert(entry) {
    if (!entries.has(entry.id) && entries.size >= maxEntries) {
      const used = new Set([...groups.values()].flatMap((group) => group.ids));
      const oldest = [...entries.keys()].find((key) => !used.has(key));
      if (oldest === undefined) return false;
      remove(oldest);
    }
    entries.delete(entry.id);
    entries.set(entry.id, entry);
    if (!creationOrder.has(entry.id)) creationOrder.set(entry.id, nextEntry++);
    return true;
  }

  function arrange(kind, stacked, nativeSplit = false) {
    const plots = [...entries.values()].filter((entry) => entry.kind === kind)
      .sort((a, b) => creationOrder.get(a.id) - creationOrder.get(b.id));
    const buckets = new Map();
    if (stacked || !nativeSplit) for (const entry of plots) {
      const key = `${kind}:${stacked ? entry.compatibility : entry.id}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(entry.id);
    }
    if ([...buckets.values()].some((ids) => ids.length > maxTraces)) throw new Error(`Compare up to ${maxTraces} traces in one chart.`);
    const owned = [...groups.values()].filter((group) => entries.get(group.ids[0])?.kind === kind);
    if (groups.size - owned.length + buckets.size > maxGroups) throw new Error("Close a chart before opening another.");
    const old = new Map(owned.map((group) => [group.layoutKey, group.id]));
    for (const group of owned) groups.delete(group.id);
    for (const [layoutKey, ids] of buckets) {
      const id = old.get(layoutKey) || `plot-comparison-${++nextGroup}`;
      groups.set(id, { id, ids, layoutKey });
    }
  }

  // Histograms/spectra retain one presentation identity across selection and
  // stack changes. Incompatible spectral units follow the selected source.
  function present(kind, selectedId, stacked) {
    const id = `plot-${kind}`, previous = groups.get(id);
    const plots = [...entries.values()].filter(entry => entry.kind === kind)
      .sort((a, b) => creationOrder.get(a.id) - creationOrder.get(b.id));
    const anchor = entries.get(selectedId) || entries.get(previous?.anchorId) || plots.at(-1);
    if (!anchor) { groups.delete(id); return; }
    if (!previous && groups.size >= maxGroups) throw new Error("Close a chart before opening another.");
    const ids = plots.filter(entry => entry.compatibility === anchor.compatibility).map(entry => entry.id);
    if (ids.length > maxTraces) throw new Error(`Compare up to ${maxTraces} traces in one chart.`);
    groups.set(id, { id, ids, anchorId: anchor.id, selectedId: ids.includes(selectedId) ? selectedId : null, stacked, focused: true });
  }

  return { entries, groups, upsert, remove, arrange, present,
    close: (id) => groups.delete(id), clear: () => { entries.clear(); groups.clear(); creationOrder.clear(); } };
}
