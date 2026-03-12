export function resolveSelectionBoundsForSpectrum(ds, selection) {
  if (!ds || !selection || !Array.isArray(selection.points) || !selection.points.length) return null;
  const maxX = Math.max(0, ds.meta.samples - 1);
  const maxY = Math.max(0, ds.meta.lines - 1);

  if (selection.tool === "rect" && selection.points.length >= 2) {
    const a = selection.points[0];
    const b = selection.points[selection.points.length - 1];
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x)));
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y)));
    const x1 = Math.min(maxX, Math.ceil(Math.max(a.x, b.x)));
    const y1 = Math.min(maxY, Math.ceil(Math.max(a.y, b.y)));
    if (x1 < x0 || y1 < y0) return null;
    return { x0, y0, x1, y1, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  }

  if (selection.tool === "shape" && selection.points.length >= 3) {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxXv = Number.NEGATIVE_INFINITY;
    let maxYv = Number.NEGATIVE_INFINITY;
    for (const p of selection.points) {
      if (!p) continue;
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxXv) maxXv = p.x;
      if (p.y > maxYv) maxYv = p.y;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxXv) || !Number.isFinite(maxYv)) return null;
    const x0 = Math.max(0, Math.floor(minX));
    const y0 = Math.max(0, Math.floor(minY));
    const x1 = Math.min(maxX, Math.ceil(maxXv));
    const y1 = Math.min(maxY, Math.ceil(maxYv));
    if (x1 < x0 || y1 < y0) return null;
    return { x0, y0, x1, y1, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  }

  return null;
}

export function resolveSelectionBoundsUnion(ds, selections = []) {
  if (!ds) return null;
  const list = Array.isArray(selections) ? selections : [];
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const selection of list) {
    const bounds = resolveSelectionBoundsForSpectrum(ds, selection);
    if (!bounds) continue;
    if (bounds.x0 < x0) x0 = bounds.x0;
    if (bounds.y0 < y0) y0 = bounds.y0;
    if (bounds.x1 > x1) x1 = bounds.x1;
    if (bounds.y1 > y1) y1 = bounds.y1;
  }
  if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) return null;
  return { x0, y0, x1, y1 };
}

export function resolveSelectionBoundsList(ds, selections = []) {
  if (!ds) return [];
  const list = Array.isArray(selections) ? selections : [];
  const out = [];
  for (const selection of list) {
    const bounds = resolveSelectionBoundsForSpectrum(ds, selection);
    if (!bounds) continue;
    out.push({
      id: Number.isFinite(selection?.id) ? selection.id : null,
      x0: bounds.x0,
      y0: bounds.y0,
      x1: bounds.x1,
      y1: bounds.y1
    });
  }
  return out;
}
