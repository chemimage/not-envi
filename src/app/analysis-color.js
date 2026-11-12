// A grouped result uses the selected region's color, falling back to its newest
// region. Keep the stored annotation color independent of the current brush.
export function resolveAnalysisColor(items, selectedId) {
  const selected = items.find((item) => item.id === selectedId);
  return selected?.color || items.at(-1)?.color || null;
}
