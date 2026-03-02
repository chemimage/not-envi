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
    const ds = { id: "ds2", ds: { close: vi.fn() }, pyramid: { cancelled: false } };
    const state = { datasets: [ds], activeId: "ds2" };
    const deps = makeDeps(state);
    const rt = createDatasetRuntime(deps);

    rt.closeDataset("ds2");
    expect(state.datasets.length).toBe(0);
    expect(state.activeId).toBe(null);
    expect(deps.disposePyramid).toHaveBeenCalled();
    expect(ds.ds.close).toHaveBeenCalled();
    expect(deps.clearSelection).toHaveBeenCalled();
  });
});
