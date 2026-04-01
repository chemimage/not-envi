function imageMaxIndex(value) {
  return Math.max(1, (Math.max(1, Number(value) || 1)) - 1);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export function annotationsShareImageSpace(sourceMeta, targetMeta) {
  return Number(sourceMeta?.samples || 0) === Number(targetMeta?.samples || 0)
    && Number(sourceMeta?.lines || 0) === Number(targetMeta?.lines || 0);
}

export function remapAnnotationPoint(point, sourceMeta, targetMeta) {
  const sourceX = imageMaxIndex(sourceMeta?.samples);
  const sourceY = imageMaxIndex(sourceMeta?.lines);
  const targetX = imageMaxIndex(targetMeta?.samples);
  const targetY = imageMaxIndex(targetMeta?.lines);
  return {
    x: clamp01((Number(point?.x) || 0) / sourceX) * targetX,
    y: clamp01((Number(point?.y) || 0) / sourceY) * targetY
  };
}

export function remapAnnotationItem(item, sourceMeta, targetMeta) {
  return {
    ...item,
    points: Array.isArray(item?.points)
      ? item.points.map((point) => remapAnnotationPoint(point, sourceMeta, targetMeta))
      : []
  };
}

export function remapAnnotationState(state, sourceMeta, targetMeta) {
  return {
    drawings: Array.isArray(state?.drawings)
      ? state.drawings.map((item) => remapAnnotationItem(item, sourceMeta, targetMeta))
      : [],
    selectedAreaId: Number.isFinite(Number(state?.selectedAreaId)) ? Number(state.selectedAreaId) : null
  };
}
