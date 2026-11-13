// A grouped result uses the selected region's color, falling back to its newest
// region. Keep the stored annotation color independent of the current brush.
export function resolveAnalysisColor(items, selectedId) {
  const selected = items.find((item) => item.id === selectedId);
  return selected?.color || items.at(-1)?.color || null;
}

export function groupAnalysisRegions(items, selectedId, mode = "group") {
  const groups = new Map();
  for (const item of items) {
    const key = item.color?.toLowerCase() || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()].map(group => (mode === "single"
    ? [group.find(item => item.id === selectedId) || group.at(-1)] : group)
    .map(item => ({ ...item, points: item.points?.map(point => ({ ...point })) })));
}
