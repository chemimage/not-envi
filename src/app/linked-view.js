function viewportWidth(viewport) {
  return Math.max(1, Number(viewport?.w ?? viewport?.width) || 1);
}

function viewportHeight(viewport) {
  return Math.max(1, Number(viewport?.h ?? viewport?.height) || 1);
}

export function linkedDatasetsShareDisplaySize(entries) {
  if (!Array.isArray(entries) || entries.length < 2) return true;
  const baseSamples = Number(entries[0]?.dataset?.meta?.samples || 0);
  const baseLines = Number(entries[0]?.dataset?.meta?.lines || 0);
  return entries.every((entry) => (
    Number(entry?.dataset?.meta?.samples || 0) === baseSamples
    && Number(entry?.dataset?.meta?.lines || 0) === baseLines
  ));
}

export function scaleViewAboutCurrentCenter(view, viewport, targetScale, dpr = 1) {
  const currentScale = Math.max(1e-9, Number(view?.scale) || 1);
  const nextScale = Math.max(1e-9, Number(targetScale) || currentScale);
  const effBefore = currentScale * Math.max(1e-9, Number(dpr) || 1);
  const effAfter = nextScale * Math.max(1e-9, Number(dpr) || 1);
  const width = viewportWidth(viewport);
  const height = viewportHeight(viewport);
  const centerX = (Number(view?.x) || 0) + (width / effBefore) * 0.5;
  const centerY = (Number(view?.y) || 0) + (height / effBefore) * 0.5;
  return {
    x: centerX - (width / effAfter) * 0.5,
    y: centerY - (height / effAfter) * 0.5,
    scale: nextScale
  };
}
