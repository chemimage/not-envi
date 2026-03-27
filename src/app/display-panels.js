export const DISPLAY_PANEL_COUNT = 4;
export const DISPLAY_LINK_COLOR_NAMES = ["amber", "cyan", "emerald", "violet"];

export function createDisplayPanel(slot) {
  return {
    slot,
    datasetId: null,
    linkGroupId: null,
    activeBand: null,
    annotations: createDisplayAnnotationState(),
    view: cloneDisplayView()
  };
}

function cloneDisplayAnnotationPoint(point) {
  return {
    x: Number.isFinite(Number(point?.x)) ? Number(point.x) : 0,
    y: Number.isFinite(Number(point?.y)) ? Number(point.y) : 0
  };
}

function cloneDisplayAnnotationItem(item) {
  return {
    ...item,
    points: Array.isArray(item?.points) ? item.points.map(cloneDisplayAnnotationPoint) : []
  };
}

export function createDisplayAnnotationState(source = null) {
  return {
    drawings: Array.isArray(source?.drawings) ? source.drawings.map(cloneDisplayAnnotationItem) : [],
    selectedAreaId: Number.isFinite(Number(source?.selectedAreaId)) ? Number(source.selectedAreaId) : null
  };
}

export function cloneDisplayView(view = null) {
  const scale = Number(view?.scale);
  const minScale = Number(view?.minScale);
  return {
    x: Number.isFinite(Number(view?.x)) ? Number(view.x) : 0,
    y: Number.isFinite(Number(view?.y)) ? Number(view.y) : 0,
    scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
    minScale: Number.isFinite(minScale) && minScale > 0 ? minScale : 1
  };
}

export function createDisplayPanels(count = DISPLAY_PANEL_COUNT) {
  return Array.from({ length: count }, (_unused, index) => createDisplayPanel(index + 1));
}

export function ensureDisplayPanels(state) {
  if (!state) return [];
  if (!Array.isArray(state.displayPanels) || state.displayPanels.length !== DISPLAY_PANEL_COUNT) {
    const next = createDisplayPanels();
    const prev = Array.isArray(state.displayPanels) ? state.displayPanels : [];
    for (const panel of prev) {
      const slot = Number(panel?.slot);
      if (!Number.isFinite(slot) || slot < 1 || slot > DISPLAY_PANEL_COUNT) continue;
      next[slot - 1] = {
        slot,
        datasetId: panel?.datasetId || null,
        linkGroupId: Number.isFinite(Number(panel?.linkGroupId)) ? Number(panel.linkGroupId) : null,
        activeBand: Number.isFinite(Number(panel?.activeBand)) ? Number(panel.activeBand) : null,
        annotations: createDisplayAnnotationState(panel?.annotations),
        view: cloneDisplayView(panel?.view)
      };
    }
    state.displayPanels = next;
  }
  if (!Number.isFinite(Number(state.activePanelSlot)) || state.activePanelSlot < 1 || state.activePanelSlot > DISPLAY_PANEL_COUNT) {
    state.activePanelSlot = 1;
  }
  if (!Number.isFinite(Number(state.nextLinkGroupId)) || state.nextLinkGroupId < 1) {
    state.nextLinkGroupId = 1;
  }
  return state.displayPanels;
}

export function allocateDisplayLinkGroupId(state) {
  ensureDisplayPanels(state);
  const next = Math.max(1, Number(state.nextLinkGroupId) || 1);
  state.nextLinkGroupId = next + 1;
  return next;
}

export function getDisplayPanel(state, slot) {
  if (!state) return null;
  ensureDisplayPanels(state);
  const wanted = Number(slot);
  if (!Number.isFinite(wanted)) return null;
  return state.displayPanels.find((panel) => Number(panel?.slot) === wanted) || null;
}

export function getVisibleDisplayPanels(state) {
  ensureDisplayPanels(state);
  return state.displayPanels
    .filter((panel) => !!panel?.datasetId)
    .sort((a, b) => Number(a.slot) - Number(b.slot));
}

export function getDatasetDisplayPanels(state, datasetId) {
  const key = String(datasetId || "");
  if (!key) return [];
  return getVisibleDisplayPanels(state).filter((panel) => String(panel.datasetId || "") === key);
}

export function getActiveDisplayPanel(state) {
  const active = getDisplayPanel(state, state?.activePanelSlot);
  if (active?.datasetId) return active;
  return getVisibleDisplayPanels(state)[0] || null;
}

export function clearDisplayPanel(panel) {
  if (!panel) return;
  panel.datasetId = null;
  panel.linkGroupId = null;
  panel.activeBand = null;
  panel.annotations = createDisplayAnnotationState();
  panel.view = cloneDisplayView();
}

export function resolveDisplayPanelBand(panel, dataset) {
  const bands = Number(dataset?.meta?.bands);
  if (!Number.isFinite(bands) || bands < 1) return null;
  const maxBand = Math.max(0, Math.floor(bands) - 1);
  const candidates = [panel?.activeBand, dataset?.activeBand, 0];
  for (const candidate of candidates) {
    const band = Number(candidate);
    if (!Number.isFinite(band)) continue;
    return Math.min(maxBand, Math.max(0, Math.floor(band)));
  }
  return 0;
}

export function datasetsShareDisplaySize(a, b) {
  if (!a || !b || !a.meta || !b.meta) return false;
  return Number(a.meta.samples || 0) === Number(b.meta.samples || 0)
    && Number(a.meta.lines || 0) === Number(b.meta.lines || 0);
}

export function panelHasLinkedPeers(state, slot) {
  return getLinkedDisplayPanels(state, slot).some((other) => Number(other.slot) !== Number(slot));
}

export function getLinkedDisplayPanels(state, slot) {
  const panel = getDisplayPanel(state, slot);
  if (!panel?.datasetId) return [];
  const groupId = Number(panel.linkGroupId);
  if (!Number.isFinite(groupId)) return [panel];
  const linked = getVisibleDisplayPanels(state).filter((other) => Number(other.linkGroupId) === groupId);
  return linked.length ? linked : [panel];
}

export function resolveDisplayLinkColorName(state, slot) {
  const panel = getDisplayPanel(state, slot);
  if (!panel?.datasetId || !Number.isFinite(Number(panel.linkGroupId))) return "";
  const peers = getVisibleDisplayPanels(state).filter((item) => Number(item.linkGroupId) === Number(panel.linkGroupId));
  if (peers.length < 2) return "";
  const seen = [];
  for (const item of getVisibleDisplayPanels(state)) {
    const groupId = Number(item.linkGroupId);
    if (!Number.isFinite(groupId) || seen.includes(groupId)) continue;
    seen.push(groupId);
  }
  const index = Math.max(0, seen.indexOf(Number(panel.linkGroupId)));
  return DISPLAY_LINK_COLOR_NAMES[index % DISPLAY_LINK_COLOR_NAMES.length] || DISPLAY_LINK_COLOR_NAMES[0];
}

export function computeDisplayPanelLayout(panels, width, height) {
  const list = Array.isArray(panels)
    ? panels
      .filter((panel) => !!panel?.datasetId)
      .sort((a, b) => Number(a.slot) - Number(b.slot))
    : [];
  if (!list.length) return [];

  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const shape = chooseDisplayPanelShape(list.length, w, h);
  return buildDisplayGridLayout(list, w, h, shape.rows, shape.cols);
}

function chooseDisplayPanelShape(count, width, height) {
  const aspect = Math.max(1e-9, Number(width) || 1) / Math.max(1e-9, Number(height) || 1);
  const candidates = {
    1: [{ rows: 1, cols: 1 }],
    2: [{ rows: 1, cols: 2 }, { rows: 2, cols: 1 }],
    3: [{ rows: 1, cols: 3 }, { rows: 2, cols: 2 }, { rows: 3, cols: 1 }],
    4: [{ rows: 2, cols: 2 }]
  }[Math.max(1, Math.min(DISPLAY_PANEL_COUNT, count))] || [{ rows: 1, cols: 1 }];

  let best = candidates[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const gridAspect = candidate.cols / candidate.rows;
    const score = Math.abs(Math.log(gridAspect) - Math.log(aspect));
    if (score < bestScore - 1e-9) {
      best = candidate;
      bestScore = score;
      continue;
    }
    if (Math.abs(score - bestScore) <= 1e-9) {
      const preferWider = aspect >= 1;
      if (preferWider && candidate.cols > best.cols) best = candidate;
      else if (!preferWider && candidate.rows > best.rows) best = candidate;
    }
  }
  return best;
}

function buildDisplayGridLayout(list, width, height, rows, cols) {
  const xStops = [0];
  const yStops = [0];
  for (let col = 1; col <= cols; col += 1) xStops.push((width * col) / cols);
  for (let row = 1; row <= rows; row += 1) yStops.push((height * row) / rows);
  return list.map((panel, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    return {
      slot: panel.slot,
      x: xStops[col],
      y: yStops[row],
      w: xStops[col + 1] - xStops[col],
      h: yStops[row + 1] - yStops[row]
    };
  });
}

export function getDisplayPanelRect(layout, slot) {
  if (!Array.isArray(layout)) return null;
  const wanted = Number(slot);
  return layout.find((rect) => Number(rect?.slot) === wanted) || null;
}

export function resolveDisplayPanelAtPoint(layout, x, y) {
  if (!Array.isArray(layout)) return null;
  const px = Number(x);
  const py = Number(y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  for (const rect of layout) {
    if (!rect) continue;
    const x0 = Number(rect.x) || 0;
    const y0 = Number(rect.y) || 0;
    const x1 = x0 + Math.max(0, Number(rect.w) || 0);
    const y1 = y0 + Math.max(0, Number(rect.h) || 0);
    if (px >= x0 && px <= x1 && py >= y0 && py <= y1) return rect;
  }
  return null;
}
