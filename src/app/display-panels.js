export const DISPLAY_PANEL_COUNT = 4;
export const DISPLAY_LINK_COLOR_NAMES = ["amber", "cyan", "emerald", "violet"];

export function createDisplayPanel(slot) {
  return {
    slot,
    datasetId: null,
    linkGroupId: null,
    view: cloneDisplayView()
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
  panel.view = cloneDisplayView();
}

export function datasetsShareDisplaySize(a, b) {
  if (!a || !b || !a.meta || !b.meta) return false;
  return Number(a.meta.samples || 0) === Number(b.meta.samples || 0)
    && Number(a.meta.lines || 0) === Number(b.meta.lines || 0);
}

export function panelHasLinkedPeers(state, slot) {
  const panel = getDisplayPanel(state, slot);
  if (!panel?.datasetId || !Number.isFinite(Number(panel.linkGroupId))) return false;
  return getVisibleDisplayPanels(state).some((other) => (
    Number(other.slot) !== Number(panel.slot) && Number(other.linkGroupId) === Number(panel.linkGroupId)
  ));
}

export function resolveDisplayLinkColorName(state, slot) {
  const panel = getDisplayPanel(state, slot);
  if (!panel?.datasetId || !Number.isFinite(Number(panel.linkGroupId))) return "";
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
  if (list.length === 1) {
    return [{ slot: list[0].slot, x: 0, y: 0, w, h }];
  }
  if (list.length === 2) {
    const halfW = w * 0.5;
    return [
      { slot: list[0].slot, x: 0, y: 0, w: halfW, h },
      { slot: list[1].slot, x: halfW, y: 0, w: w - halfW, h }
    ];
  }

  const halfW = w * 0.5;
  const halfH = h * 0.5;
  return list.slice(0, DISPLAY_PANEL_COUNT).map((panel, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x = col === 0 ? 0 : halfW;
    const y = row === 0 ? 0 : halfH;
    return {
      slot: panel.slot,
      x,
      y,
      w: col === 0 ? halfW : (w - halfW),
      h: row === 0 ? halfH : (h - halfH)
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
