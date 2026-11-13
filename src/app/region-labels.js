const isRegion = item => item?.tool === "rect" || item?.tool === "shape";
const colorKey = color => String(color || "").toLowerCase();
const validIndex = index => Number.isInteger(index) && index > 0;

// Display numbers belong to a color. Annotation IDs remain globally unique
// within the drawing store for selection, deletion, and cached provenance.
export function regionIndices(items) {
  const indices = new Map(), used = new Map();
  for (const item of items) {
    if (!isRegion(item) || !validIndex(item.regionIndex)) continue;
    const color = colorKey(item.color);
    if (!used.has(color)) used.set(color, new Set());
    used.get(color).add(item.regionIndex);
    indices.set(item.id, item.regionIndex);
  }
  for (const item of items) {
    if (!isRegion(item) || indices.has(item.id)) continue;
    const color = colorKey(item.color);
    if (!used.has(color)) used.set(color, new Set());
    let index = 1;
    while (used.get(color).has(index)) index++;
    used.get(color).add(index);
    indices.set(item.id, index);
  }
  return indices;
}

export function nextRegionIndex(items, color) {
  const indices = regionIndices(items);
  return Math.max(0, ...items.filter(item => isRegion(item) && colorKey(item.color) === colorKey(color))
    .map(item => indices.get(item.id))) + 1;
}

export function regionSourceLabel(items, drawings = items) {
  if (!items.length) return "Whole image";
  const indices = regionIndices(drawings);
  return `Region ${items.map(item => validIndex(item.regionIndex) ? item.regionIndex : indices.get(item.id) ?? item.id).join(" + ")}`;
}
