function rectOverlapArea(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x1 <= x0 || y1 <= y0) return 0;
  return (x1 - x0) * (y1 - y0);
}

function imageBoundsToScreenRect(ds, bounds) {
  if (!ds || !bounds) return null;
  const scale = Math.max(1e-9, Number(ds?.view?.scale) || 1);
  const sx0 = (bounds.x0 - ds.view.x) * scale;
  const sy0 = (bounds.y0 - ds.view.y) * scale;
  const sx1 = (bounds.x1 + 1 - ds.view.x) * scale;
  const sy1 = (bounds.y1 + 1 - ds.view.y) * scale;
  return {
    x: Math.min(sx0, sx1),
    y: Math.min(sy0, sy1),
    w: Math.max(1, Math.abs(sx1 - sx0)),
    h: Math.max(1, Math.abs(sy1 - sy0))
  };
}

export function choosePanelPlacementNearSelection({
  ds,
  mainRect,
  panelWidth,
  panelHeight,
  targetBounds,
  avoidBounds = [],
  pointerType = "mouse"
}) {
  if (!ds || !targetBounds || !mainRect) return null;
  const panelW = Math.max(220, panelWidth || 380);
  const panelH = Math.max(120, panelHeight || 230);
  const gap = pointerType === "touch" ? 56 : 28;
  const margin = 8;
  const targetRect = imageBoundsToScreenRect(ds, targetBounds);
  if (!targetRect) return null;
  const avoidRects = Array.isArray(avoidBounds)
    ? avoidBounds.map((b) => imageBoundsToScreenRect(ds, b)).filter(Boolean)
    : [];

  const cx = targetRect.x + (targetRect.w / 2);
  const cy = targetRect.y + (targetRect.h / 2);
  const candidates = [
    { x: targetRect.x + targetRect.w + gap, y: cy - (panelH / 2) },
    { x: targetRect.x - panelW - gap, y: cy - (panelH / 2) },
    { x: cx - (panelW / 2), y: targetRect.y + targetRect.h + gap },
    { x: cx - (panelW / 2), y: targetRect.y - panelH - gap },
    { x: targetRect.x + targetRect.w + gap, y: targetRect.y + targetRect.h + gap },
    { x: targetRect.x - panelW - gap, y: targetRect.y - panelH - gap },
    { x: targetRect.x + targetRect.w + gap, y: targetRect.y - panelH - gap },
    { x: targetRect.x - panelW - gap, y: targetRect.y + targetRect.h + gap }
  ];

  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestAvoidOverlap = Number.POSITIVE_INFINITY;
  for (const cand of candidates) {
    const x = Math.max(margin, Math.min(cand.x, mainRect.width - panelW - margin));
    const y = Math.max(margin, Math.min(cand.y, mainRect.height - panelH - margin));
    const panel = { x, y, w: panelW, h: panelH };
    const targetOverlap = rectOverlapArea(panel, targetRect);
    let avoidOverlap = 0;
    for (const avoidRect of avoidRects) avoidOverlap += rectOverlapArea(panel, avoidRect);
    const dx = x - cand.x;
    const dy = y - cand.y;
    const dist = Math.hypot(dx, dy);
    const score = (avoidOverlap * 40) + (targetOverlap * 6) + dist;
    if (avoidOverlap < bestAvoidOverlap || (avoidOverlap === bestAvoidOverlap && score < bestScore)) {
      bestAvoidOverlap = avoidOverlap;
      bestScore = score;
      best = { x, y };
    }
  }
  return best;
}
