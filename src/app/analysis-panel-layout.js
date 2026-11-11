function overlap(a, b) {
  if (!a || !b) return 0;
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}

// Pack automatic windows together; manually positioned windows remain fixed obstacles.
export function chooseAnalysisPanelLayout({ bounds, panels, anchor = null }) {
  const margin = 8, gap = 8;
  const automatic = panels.filter((panel) => !panel.fixed);
  const fixed = panels.filter((panel) => panel.fixed);
  if (!automatic.length) return panels;
  const layouts = ["column", "row"];
  let best = null, bestScore = Infinity;
  for (const direction of layouts) {
    const width = direction === "column"
      ? Math.max(...automatic.map((p) => p.width))
      : automatic.reduce((sum, p) => sum + p.width, gap * (automatic.length - 1));
    const height = direction === "row"
      ? Math.max(...automatic.map((p) => p.height))
      : automatic.reduce((sum, p) => sum + p.height, gap * (automatic.length - 1));
    const references = [anchor, ...fixed].filter(Boolean);
    const candidates = references.flatMap((rect) => [
      { x: rect.x + rect.width + gap, y: rect.y },
      { x: rect.x - width - gap, y: rect.y },
      { x: rect.x, y: rect.y + rect.height + gap },
      { x: rect.x, y: rect.y - height - gap }
    ]);
    candidates.push({ x: bounds.width - width - margin, y: margin }, { x: margin, y: margin });
    for (const candidate of candidates) {
      const x = Math.max(margin, Math.min(candidate.x, bounds.width - width - margin));
      const y = Math.max(margin, Math.min(candidate.y, bounds.height - height - margin));
      const group = { x, y, width, height };
      const overflow = Math.max(0, x + width + margin - bounds.width)
        + Math.max(0, y + height + margin - bounds.height);
      let score = overflow * 1e6 + overlap(group, anchor) * 4;
      for (const obstacle of fixed) score += overlap(group, obstacle) * 1000;
      score += Math.hypot(x - candidate.x, y - candidate.y);
      if (score >= bestScore) continue;
      bestScore = score;
      let offset = 0;
      best = automatic.map((panel) => {
        const result = { ...panel, x: x + (direction === "row" ? offset : 0),
          y: y + (direction === "column" ? offset : 0) };
        offset += (direction === "row" ? panel.width : panel.height) + gap;
        return result;
      });
    }
  }
  return [...fixed, ...best];
}

export function createAnalysisPanelLayout({ els, getWindow }) {
  let arranging = false;
  function arrange() {
    const elements = [els.specPanel, els.analysisHistPanel]
      .filter((element) => element && element.style.display !== "none");
    if (arranging || !elements.length) return false;
    arranging = true;
    try {
      const main = els.main.getBoundingClientRect();
      const panels = elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { id: element.dataset.floatingWindow, x: rect.left - main.left, y: rect.top - main.top,
          width: rect.width, height: rect.height, fixed: element.dataset.floatingUserPlaced === "true" };
      });
      const button = els.selectionActions && !els.selectionActions.hidden
        ? els.selectionActions.getBoundingClientRect() : null;
      const anchor = button ? { x: button.left - main.left, y: button.top - main.top,
        width: button.width, height: button.height } : null;
      const layout = chooseAnalysisPanelLayout({ bounds: main, panels, anchor });
      for (const panel of layout) {
        if (panel.fixed) continue;
        getWindow(panel.id)?.place(panel);
      }
      return true;
    } finally {
      arranging = false;
    }
  }
  window.addEventListener("resize", arrange);
  return { arrange };
}
