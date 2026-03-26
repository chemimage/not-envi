import { describe, expect, test, vi } from "vitest";
import { createDatasetRuntime } from "../../src/app/dataset-runtime.js";

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
    onNeedWholeStats: vi.fn()
  };
}

describe("dataset runtime", () => {
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
});
