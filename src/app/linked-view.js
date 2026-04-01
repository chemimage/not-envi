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

export function captureNormalizedViewBox(view, meta, viewport, dpr = 1) {
  const width = viewportWidth(viewport);
  const height = viewportHeight(viewport);
  const samples = imageSamples(meta);
  const lines = imageLines(meta);
  const eff = Math.max(1e-9, (Number(view?.scale) || 1) * Math.max(1e-9, Number(dpr) || 1));
  const viewW = width / eff;
  const viewH = height / eff;
  return {
    centerX: ((Number(view?.x) || 0) + (viewW * 0.5)) / samples,
    centerY: ((Number(view?.y) || 0) + (viewH * 0.5)) / lines,
    widthFrac: viewW / samples,
    heightFrac: viewH / lines
  };
}

export function applyNormalizedViewBox(box, meta, viewport, dpr = 1, { minScale = 1e-9, maxScale = 128 } = {}) {
  const width = viewportWidth(viewport);
  const height = viewportHeight(viewport);
  const samples = imageSamples(meta);
  const lines = imageLines(meta);
  const widthFrac = Math.max(1e-9, Number(box?.widthFrac) || 1);
  const heightFrac = Math.max(1e-9, Number(box?.heightFrac) || 1);
  const desiredViewW = widthFrac * samples;
  const desiredViewH = heightFrac * lines;
  const effX = width / Math.max(1e-9, desiredViewW);
  const effY = height / Math.max(1e-9, desiredViewH);
  const relDiff = Math.abs(effX - effY) / Math.max(effX, effY, 1e-9);
  const eff = relDiff <= 1e-6 ? ((effX + effY) * 0.5) : Math.min(effX, effY);
  const scale = Math.min(
    Math.max(Number(minScale) || 1e-9, eff / Math.max(1e-9, Number(dpr) || 1)),
    Number(maxScale) || 128
  );
  const actualEff = Math.max(1e-9, scale * Math.max(1e-9, Number(dpr) || 1));
  const actualViewW = width / actualEff;
  const actualViewH = height / actualEff;
  const centerX = (Number(box?.centerX) || 0.5) * samples;
  const centerY = (Number(box?.centerY) || 0.5) * lines;
  return {
    x: centerX - (actualViewW * 0.5),
    y: centerY - (actualViewH * 0.5),
    scale
  };
}

export function withNormalizedCenter(box, centerX, centerY) {
  return {
    centerX: Number(centerX),
    centerY: Number(centerY),
    widthFrac: Math.max(1e-9, Number(box?.widthFrac) || 1),
    heightFrac: Math.max(1e-9, Number(box?.heightFrac) || 1)
  };
}
