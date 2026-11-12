import { describe, expect, test, vi } from "vitest";
import { createDatasetRuntime } from "../../src/app/dataset-runtime.js";
import { DISPLAY_COMPOSITION_OVERLAY, getDisplayPanel } from "../../src/app/display-panels.js";

function makeDeps(state) {
  return {
    state,
    clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
    fmtNoGroup: (n) => String(n),
    addDatasetsFromFileListMod: async () => ({ datasets: [], missing: [], headersFound: false }),
    addDatasetFromFilesMod: async () => null,
    setStatus: () => {},
    alertFn: () => {},
    getIOConcurrency: () => 2,
    recomputeCacheBudgets: vi.fn(),
    closeSpectrum: vi.fn(),
    onAfterDatasetUIUpdate: vi.fn(),
    updateZoomRange: vi.fn(),
    fitToScreen: vi.fn(),
    render: vi.fn(),
    disposePyramid: vi.fn(),
    clearSelection: vi.fn(),
    onNeedWholeStats: vi.fn(),
    syncActiveDatasetView: vi.fn(),
    captureDisplayViewState: vi.fn(() => new Map()),
    reflowDisplayViews: vi.fn(),
    syncLinkedPanelView: vi.fn()
  };
}

describe("dataset runtime", () => {
  test("passes the built-in fmap backend to dataset importers", async () => {
    const deps = makeDeps({ datasets: [] });
    deps.addDatasetsFromFileListMod = vi.fn(async () => ({ datasets: [], missing: [], headersFound: false }));
    const stopBeforeAttach = new Error("stop before attaching dataset");
    deps.addDatasetFromFilesMod = vi.fn(async () => { throw stopBeforeAttach; });
    const rt = createDatasetRuntime(deps);
    const file = new File(["data"], "example.dat");
    const header = new File(["header"], "example.hdr");

    await rt.addDatasetsFromFileList([file]);
    expect(deps.addDatasetsFromFileListMod).toHaveBeenCalledWith([file], expect.objectContaining({ fmapEnabled: true }));
    await expect(rt.addDatasetFromFiles(header, file)).rejects.toBe(stopBeforeAttach);
    expect(deps.addDatasetFromFilesMod).toHaveBeenCalledWith(header, file, expect.objectContaining({ fmapEnabled: true }));
  });

  test("setActiveDataset updates active id and triggers fit/render", () => {
    const state = { datasets: [{ id: "ds1", meta: {} }], activeId: null };
    const deps = makeDeps(state);
    const rt = createDatasetRuntime(deps);

    rt.setActiveDataset("ds1", { fit: true });
    expect(state.activeId).toBe("ds1");
    expect(deps.closeSpectrum).toHaveBeenCalled();
    expect(deps.fitToScreen).toHaveBeenCalled();
  });

  test("closeDataset removes dataset and cleans resources", () => {
    const ds = { id: "ds2", ds: { close: vi.fn() }, baseDs: { close: vi.fn() }, pyramid: { cancelled: false } };
    const state = { datasets: [ds], activeId: "ds2", renderSeq: 4, histViewDebounce: setTimeout(() => {}, 1000) };
    const deps = makeDeps(state);
    const rt = createDatasetRuntime(deps);

    rt.closeDataset("ds2");
    expect(state.datasets.length).toBe(0);
    expect(state.activeId).toBe(null);
    expect(state.renderSeq).toBe(5);
    expect(state.histViewDebounce).toBe(null);
    expect(deps.disposePyramid).toHaveBeenCalled();
    expect(ds.ds.close).toHaveBeenCalled();
    expect(ds.baseDs.close).toHaveBeenCalled();
    expect(deps.clearSelection).toHaveBeenCalled();
  });

  test("closeAllDatasets releases every dataset and resets active state", () => {
    const ds1 = { id: "ds1", ds: { close: vi.fn() }, pyramid: { id: 1 } };
    const ds2 = { id: "ds2", ds: { clear: vi.fn() }, pyramid: { id: 2 } };
    const state = { datasets: [ds1, ds2], activeId: "ds2", renderSeq: 9, histViewDebounce: setTimeout(() => {}, 1000) };
    const deps = makeDeps(state);
    const rt = createDatasetRuntime(deps);

    rt.closeAllDatasets();

    expect(state.datasets).toEqual([]);
    expect(state.activeId).toBe(null);
    expect(state.renderSeq).toBe(10);
    expect(state.histViewDebounce).toBe(null);
    expect(ds1.ds.close).toHaveBeenCalled();
    expect(ds2.ds.clear).toHaveBeenCalled();
    expect(deps.closeSpectrum).toHaveBeenCalled();
    expect(deps.disposePyramid).toHaveBeenCalledTimes(2);
    expect(deps.recomputeCacheBudgets).toHaveBeenCalled();
    expect(deps.onAfterDatasetUIUpdate).toHaveBeenCalled();
    expect(deps.clearSelection).toHaveBeenCalled();
    expect(deps.render).toHaveBeenCalled();
  });

  test("cycleDatasetPanel cycles linked, independent, and hidden states", () => {
    const ds1 = { id: "ds1", meta: { samples: 64, lines: 32 }, view: { x: 0, y: 0, scale: 1 }, drawings: [{ id: 1, tool: "rect", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }], selectedAreaId: 1 };
    const ds2 = { id: "ds2", meta: { samples: 64, lines: 32 }, view: { x: 0, y: 0, scale: 1 } };
    const state = { datasets: [ds1, ds2], activeId: null, activePanelSlot: 1, nextLinkGroupId: 1 };
    const deps = makeDeps(state);
    const rt = createDatasetRuntime(deps);

    rt.setActiveDataset("ds1", { panelSlot: 1 });
    rt.setActiveDataset("ds2", { panelSlot: 2 });
    expect(state.activeId).toBe("ds2");

    const panel1 = getDisplayPanel(state, 1);
    const panel2 = getDisplayPanel(state, 2);
    expect(panel1?.datasetId).toBe("ds1");
    expect(panel2?.datasetId).toBe("ds2");
    expect(panel2?.linkGroupId).toBe(panel1?.linkGroupId);
    expect(panel2?.annotations).toBe(panel1?.annotations);
    expect(panel2?.view).not.toBe(panel1?.view);
    expect(panel2?.view).toEqual(panel1?.view);

    rt.cycleDatasetPanel("ds2", 2);
    expect(panel2?.datasetId).toBe("ds2");
    expect(panel2?.linkGroupId).not.toBe(panel1?.linkGroupId);
    expect(panel2?.annotations).not.toBe(panel1?.annotations);
    expect(panel2?.annotations?.drawings).toEqual(panel1?.annotations?.drawings);

    rt.cycleDatasetPanel("ds2", 2);
    expect(panel2?.datasetId).toBe(null);
    expect(panel2?.linkGroupId).toBe(null);

    rt.cycleDatasetPanel("ds2", 2);
    expect(panel2?.datasetId).toBe("ds2");
    expect(panel2?.linkGroupId).toBe(panel1?.linkGroupId);
    expect(panel2?.annotations).toBe(panel1?.annotations);
    expect(panel2?.view).not.toBe(panel1?.view);
    expect(panel2?.view).toEqual(panel1?.view);
  });

  test("datasets with different display sizes still auto-link across panels", () => {
    const ds1 = { id: "ds1", meta: { samples: 64, lines: 32 }, view: { x: 0, y: 0, scale: 1 }, drawings: [{ id: 1, tool: "rect", points: [{ x: 0, y: 0 }, { x: 63, y: 31 }] }], selectedAreaId: 1 };
    const ds2 = { id: "ds2", meta: { samples: 96, lines: 48 }, view: { x: 0, y: 0, scale: 1 } };
    const state = { datasets: [ds1, ds2], activeId: null, activePanelSlot: 1, nextLinkGroupId: 1 };
    const deps = makeDeps(state);
    const rt = createDatasetRuntime(deps);

    rt.setActiveDataset("ds1", { panelSlot: 1 });
    rt.setActiveDataset("ds2", { panelSlot: 2 });

    const panel1 = getDisplayPanel(state, 1);
    const panel2 = getDisplayPanel(state, 2);
    expect(panel1?.datasetId).toBe("ds1");
    expect(panel2?.datasetId).toBe("ds2");
    expect(panel2?.linkGroupId).toBe(panel1?.linkGroupId);
    expect(panel2?.annotations).not.toBe(panel1?.annotations);
    expect(panel2?.annotations?.drawings?.[0]?.points).toEqual([{ x: 0, y: 0 }, { x: 95, y: 47 }]);
    expect(deps.syncLinkedPanelView).toHaveBeenCalledWith(panel1, panel2);
  });

  test("overlay button assigns a dataset to both panels and links them", () => {
    const ds1 = { id: "ds1", meta: { samples: 64, lines: 32, bands: 3 }, view: { x: 5, y: 7, scale: 2 }, drawings: [{ id: 1, tool: "rect", points: [{ x: 1, y: 1 }, { x: 3, y: 3 }] }], selectedAreaId: 1 };
    const state = { datasets: [ds1], activeId: null, activePanelSlot: 1, nextLinkGroupId: 1 };
    const deps = makeDeps(state);
    const rt = createDatasetRuntime(deps);

    rt.cycleDatasetPanel("ds1", "both");

    const panel1 = getDisplayPanel(state, 1);
    const panel2 = getDisplayPanel(state, 2);
    expect(state.displayCompositionMode).toBe(DISPLAY_COMPOSITION_OVERLAY);
    expect(panel1?.datasetId).toBe("ds1");
    expect(panel2?.datasetId).toBe("ds1");
    expect(panel2?.linkGroupId).toBe(panel1?.linkGroupId);
    expect(panel2?.annotations).toBe(panel1?.annotations);
    expect(panel2?.view).not.toBe(panel1?.view);
    expect(panel2?.view).toEqual(panel1?.view);
  });

  test("overlay mode keeps both layers linked and only changes the active panel", () => {
    const ds1 = { id: "ds1", meta: { samples: 64, lines: 32, bands: 3 }, view: { x: 0, y: 0, scale: 1 }, drawings: [], selectedAreaId: null };
    const state = {
      datasets: [ds1],
      activeId: "ds1",
      activePanelSlot: 1,
      nextLinkGroupId: 2,
      displayCompositionMode: DISPLAY_COMPOSITION_OVERLAY,
      displayPanels: [
        { slot: 1, datasetId: "ds1", linkGroupId: 1, activeBand: 0, annotations: { drawings: [], selectedAreaId: null }, view: { x: 1, y: 2, scale: 3 } },
        { slot: 2, datasetId: "ds1", linkGroupId: 1, activeBand: 1, annotations: { drawings: [], selectedAreaId: null }, view: { x: 1, y: 2, scale: 3 } }
      ]
    };
    const deps = makeDeps(state);
    const rt = createDatasetRuntime(deps);

    rt.cycleDatasetPanel("ds1", 2);

    const panel1 = getDisplayPanel(state, 1);
    const panel2 = getDisplayPanel(state, 2);
    expect(state.displayCompositionMode).toBe(DISPLAY_COMPOSITION_OVERLAY);
    expect(state.activePanelSlot).toBe(2);
    expect(panel1?.datasetId).toBe("ds1");
    expect(panel2?.datasetId).toBe("ds1");
    expect(panel1?.linkGroupId).toBe(panel2?.linkGroupId);
    expect(deps.closeSpectrum).not.toHaveBeenCalled();
  });

  test("overlay relinks independent panels and restores their split state when disabled", () => {
    const ds1 = { id: "ds1", meta: { samples: 64, lines: 32, bands: 3 }, view: { x: 0, y: 0, scale: 1 }, drawings: [], selectedAreaId: null };
    const state = {
      datasets: [ds1],
      activeId: "ds1",
      activePanelSlot: 2,
      nextLinkGroupId: 4,
      displayPanels: [
        { slot: 1, datasetId: "ds1", linkGroupId: 1, activeBand: 0, annotations: { drawings: [{ id: 10 }], selectedAreaId: 10 }, view: { x: 1, y: 2, scale: 1.25 } },
        { slot: 2, datasetId: "ds1", linkGroupId: 2, activeBand: 1, annotations: { drawings: [{ id: 20 }], selectedAreaId: 20 }, view: { x: 9, y: 8, scale: 2.5 } }
      ]
    };
    const deps = makeDeps(state);
    const rt = createDatasetRuntime(deps);

    rt.cycleDatasetPanel("ds1", "both");
    expect(state.displayCompositionMode).toBe(DISPLAY_COMPOSITION_OVERLAY);
    const linked1 = getDisplayPanel(state, 1);
    const linked2 = getDisplayPanel(state, 2);
    expect(linked1.linkGroupId).toBe(linked2.linkGroupId);
    expect(linked1.annotations).toBe(linked2.annotations);
    expect(linked2.view).toEqual(linked1.view);
    expect(linked1.activeBand).toBe(0);
    expect(linked2.activeBand).toBe(1);

    rt.cycleDatasetPanel("ds1", "both");

    const panel1 = getDisplayPanel(state, 1);
    const panel2 = getDisplayPanel(state, 2);
    expect(state.displayCompositionMode).toBe("split");
    expect(panel1?.datasetId).toBe("ds1");
    expect(panel2?.datasetId).toBe("ds1");
    expect(panel1?.linkGroupId).toBe(1);
    expect(panel2?.linkGroupId).toBe(2);
    expect(panel1?.activeBand).toBe(0);
    expect(panel2?.activeBand).toBe(1);
    expect(panel1?.annotations?.selectedAreaId).toBe(10);
    expect(panel2?.annotations?.selectedAreaId).toBe(20);
    expect(panel1?.view).toEqual({ x: 1, y: 2, scale: 1.25, minScale: 1 });
    expect(panel2?.view).toEqual({ x: 9, y: 8, scale: 2.5, minScale: 1 });
    expect(state.activePanelSlot).toBe(2);
  });

  test("turning off overlay without a saved split snapshot keeps both panels visible", () => {
    const ds1 = { id: "ds1", meta: { samples: 64, lines: 32, bands: 3 }, view: { x: 0, y: 0, scale: 1 }, drawings: [], selectedAreaId: null };
    const state = {
      datasets: [ds1],
      activeId: "ds1",
      activePanelSlot: 1,
      displayCompositionMode: DISPLAY_COMPOSITION_OVERLAY,
      displaySplitSnapshot: null,
      displayPanels: [
        { slot: 1, datasetId: "ds1", linkGroupId: 1, activeBand: 0, annotations: { drawings: [], selectedAreaId: null }, view: { x: 1, y: 2, scale: 3 } },
        { slot: 2, datasetId: "ds1", linkGroupId: 1, activeBand: 1, annotations: { drawings: [], selectedAreaId: null }, view: { x: 1, y: 2, scale: 3 } }
      ]
    };
    const deps = makeDeps(state);
    const rt = createDatasetRuntime(deps);

    rt.cycleDatasetPanel("ds1", "both");

    const panel1 = getDisplayPanel(state, 1);
    const panel2 = getDisplayPanel(state, 2);
    expect(state.displayCompositionMode).toBe("split");
    expect(panel1?.datasetId).toBe("ds1");
    expect(panel2?.datasetId).toBe("ds1");
    expect(panel1?.linkGroupId).toBe(1);
    expect(panel2?.linkGroupId).toBe(1);
  });
});
