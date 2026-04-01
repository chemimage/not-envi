import { APP_CONFIG } from "./config.js";
import { createDisplayPanels, DISPLAY_COMPOSITION_SPLIT } from "./display-panels.js";

export function createAppState() {
  return {
    datasets: [],
    activeId: null,
    displayPanels: createDisplayPanels(),
    activePanelSlot: 1,
    displayCompositionMode: DISPLAY_COMPOSITION_SPLIT,
    displaySplitSnapshot: null,
    nextLinkGroupId: 1,
    ioParallel: APP_CONFIG.io.parallelEnabledByDefault,
    zoomExpMin: -6,
    zoomExpMax: 4,
    renderSeq: 0,
    lastRenderMs: 0,
    _rafPending: false,
    mouse: { in: false, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 },
    selection: { enabled: false, drawing: false, x0: 0, y0: 0, x1: 0, y1: 0, imgRect: null },
    histDrag: { active: false, handle: null },
    histMode: "whole",
    histViewDebounce: null,
    draw: {
      tool: "none",
      color: "#ff2d2d",
      shapeMode: "rect",
      activePointerId: null,
      draft: null,
      rulerDrag: null,
      rulerMove: null,
      rulerProfileDrag: null,
      rulerProfileHover: null,
      rulerHover: null,
      areaMove: null,
      nextItemId: 1
    },
    exportKind: null
  };
}

export function getActiveDataset(state) {
  return state.datasets.find((d) => d.id === state.activeId) || null;
}

export function setActiveDatasetId(state, id) {
  state.activeId = id;
}
