function viewportWidth(viewport) {
  return Math.max(1, Number(viewport?.w ?? viewport?.width) || 1);
}

function viewportHeight(viewport) {
  return Math.max(1, Number(viewport?.h ?? viewport?.height) || 1);
}

function imageSamples(meta) {
  return Math.max(1, Number(meta?.samples) || 1);
}

function imageLines(meta) {
  return Math.max(1, Number(meta?.lines) || 1);
}

function clampScale(value, minValue, maxValue) {
  return Math.min(maxValue, Math.max(minValue, value));
}

export function resolveSourceScaleForLinkedEntry(
  sourceMeta,
  sourceViewport,
  targetMeta,
  targetViewport,
  targetMinScale,
  fallback = 1e-9
) {
  const base = Math.max(1e-9, Number(fallback) || 1e-9);
  const targetMin = Number(targetMinScale);
  if (!Number.isFinite(targetMin) || targetMin <= 0) return base;

  const sourceW = viewportWidth(sourceViewport);
  const sourceH = viewportHeight(sourceViewport);
  const targetW = viewportWidth(targetViewport);
  const targetH = viewportHeight(targetViewport);
  const sourceSamples = imageSamples(sourceMeta);
  const sourceLines = imageLines(sourceMeta);
  const targetSamples = imageSamples(targetMeta);
  const targetLines = imageLines(targetMeta);

  const factorX = (targetW * sourceSamples) / Math.max(1e-9, sourceW * targetSamples);
  const factorY = (targetH * sourceLines) / Math.max(1e-9, sourceH * targetLines);
  const factor = Math.max(1e-9, Math.min(factorX, factorY));
  return Math.max(base, targetMin / factor);
}

export function resolveLinkedSourceMinScale(
  sourceEntry,
  entries,
  minScaleFor,
  getViewport,
  fallback = 1e-9
) {
  const base = Math.max(1e-9, Number(fallback) || 1e-9);
  if (!sourceEntry?.dataset || !sourceEntry?.panel || typeof minScaleFor !== "function" || typeof getViewport !== "function") {
    return base;
  }

  const sourceViewport = getViewport(Number(sourceEntry.panel.slot) || 1);
  let linkedMinScale = base;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const ds = entry?.dataset || null;
    const panel = entry?.panel || null;
    if (!ds || !panel) continue;
    const targetViewport = getViewport(Number(panel.slot) || 1);
    const targetMinScale = minScaleFor(ds, Number(panel.slot) || 1);
    const requiredSourceScale = resolveSourceScaleForLinkedEntry(
      sourceEntry.dataset.meta,
      sourceViewport,
      ds.meta,
      targetViewport,
      targetMinScale,
      base
    );
    linkedMinScale = Math.max(linkedMinScale, requiredSourceScale);
  }
  return linkedMinScale;
}

export function clampLinkedSourceScale(
  targetScale,
  sourceEntry,
  entries,
  minScaleFor,
  getViewport,
  maxScale = 128,
  fallback = 1e-9
) {
  const minScale = resolveLinkedSourceMinScale(sourceEntry, entries, minScaleFor, getViewport, fallback);
  const upperBound = Math.max(minScale, Number(maxScale) || 128);
  return {
    minScale,
    scale: clampScale(Number(targetScale) || minScale, minScale, upperBound)
  };
}
