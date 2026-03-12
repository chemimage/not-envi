export function resolveRasterSampling(ds, canvasW, canvasH, effRaw) {
  const eff = Math.max(1e-9, Number(effRaw) || 0);
  const samples = Math.max(1, ds?.meta?.samples || 1);
  const lines = Math.max(1, ds?.meta?.lines || 1);
  const x0 = Number(ds?.view?.x) || 0;
  const y0 = Number(ds?.view?.y) || 0;

  let rasterW = 0;
  let rasterH = 0;
  let step = 1;
  if (eff >= 1) {
    rasterW = Math.max(1, Math.ceil(canvasW / eff));
    rasterH = Math.max(1, Math.ceil(canvasH / eff));
    step = 1;
  } else {
    step = Math.max(1, Math.ceil(1 / eff));
    const denom = Math.max(1e-9, eff * step);
    rasterW = Math.max(1, Math.ceil(canvasW / denom));
    rasterH = Math.max(1, Math.ceil(canvasH / denom));
  }

  const maxX = samples - 1;
  const maxY = lines - 1;
  const colStart = Math.max(0, Math.ceil((0 - x0) / step));
  const colEnd = Math.min(rasterW - 1, Math.floor((maxX - x0) / step));
  const rowStart = Math.max(0, Math.ceil((0 - y0) / step));
  const rowEnd = Math.min(rasterH - 1, Math.floor((maxY - y0) / step));
  const validW = Math.max(0, colEnd - colStart + 1);
  const validH = Math.max(0, rowEnd - rowStart + 1);

  const scaleX = canvasW / Math.max(1, rasterW);
  const scaleY = canvasH / Math.max(1, rasterH);

  return {
    eff,
    step,
    rasterW,
    rasterH,
    x0,
    y0,
    colStart,
    colEnd,
    rowStart,
    rowEnd,
    validW,
    validH,
    srcX0: x0 + (colStart * step),
    srcY0: y0 + (rowStart * step),
    displayRect: (validW > 0 && validH > 0)
      ? {
        x: colStart * scaleX,
        y: rowStart * scaleY,
        w: validW * scaleX,
        h: validH * scaleY
      }
      : null
  };
}
