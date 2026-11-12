// Plot membership is independent of annotations and calculated data. Moving a
// trace never merges regions, averages values, or initiates a source read.
export function createPlotGroups({ maxEntries = 48, maxGroups = 12, maxTraces = 8 } = {}) {
  const entries = new Map();
  const groups = new Map();
  let nextGroup = 0;

  function remove(id) {
    entries.delete(id);
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
    return true;
  }

  function combine(ids, targetId = null) {
    const unique = [...new Set(ids)];
    const plots = unique.map((id) => entries.get(id));
    if (!plots.length || plots.some((plot) => !plot || plot.status !== "ready")) {
      throw new Error("Calculate the selected plots before combining them.");
    }
    if (plots.some((plot) => plot.compatibility !== plots[0].compatibility)) {
      throw new Error("Choose plots of the same type with matching axis units.");
    }
    if (unique.length > maxTraces) throw new Error(`Compare up to ${maxTraces} traces in one chart.`);
    if (targetId && !groups.has(targetId)) throw new Error("This comparison has been closed.");
    const remaining = [...groups.values()].filter((group) => group.id !== targetId
      && group.ids.some((id) => !unique.includes(id)));
    if (remaining.length >= maxGroups) throw new Error("Close a chart before opening another.");
    const id = targetId || `plot-comparison-${++nextGroup}`;
    for (const [key, group] of groups) {
      group.ids = group.ids.filter((item) => !unique.includes(item));
      if (!group.ids.length) groups.delete(key);
    }
    groups.set(id, { id, ids: unique });
    return id;
  }

  function split(groupId, entryId) {
    const group = groups.get(groupId);
    if (!group?.ids.includes(entryId) || group.ids.length < 2) return null;
    if (groups.size >= maxGroups) throw new Error("Close a chart before opening another.");
    group.ids = group.ids.filter((id) => id !== entryId);
    const id = `plot-comparison-${++nextGroup}`;
    groups.set(id, { id, ids: [entryId] });
    return id;
  }

  function detach(groupId, entryId) {
    const group = groups.get(groupId);
    if (!group) return;
    group.ids = group.ids.filter((id) => id !== entryId);
    if (!group.ids.length) groups.delete(groupId);
  }

  return { entries, groups, upsert, combine, split, detach, remove,
    close: (id) => groups.delete(id), clear: () => { entries.clear(); groups.clear(); } };
}
