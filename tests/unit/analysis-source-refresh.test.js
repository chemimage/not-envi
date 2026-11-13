import { describe, expect, test, vi } from "vitest";
import { createAnalysisSourceRefresher } from "../../src/app/analysis-source-refresh.js";

function fixture() {
  const ds = { id: 1, ds: {} };
  const items = [1, 2, 3].map(id => ({ id, tool: "rect", color: id === 3 ? "blue" : "red",
    points: [{ x: id * 10, y: 0 }, { x: id * 10 + 5, y: 5 }] }));
  const panel = { datasetId: ds.id, annotations: { drawings: items } };
  const entry = { id: "histogram:red:7", kind: "histogram", band: 7,
    sourceDescriptor: { dsId: ds.id, slot: 2, items: [{ id: 1 }, { id: 2 }] } };
  let visible = true;
  const comparisons = { changedAreaSources: vi.fn(() => visible ? [entry] : []), isVisibleSource: () => visible };
  const work = { update: vi.fn(), done: vi.fn() }, beginAnnotationWork = vi.fn(() => work);
  const compute = vi.fn(async () => ({ bins: [2, 3] })), publish = vi.fn();
  const refresher = createAnalysisSourceRefresher({ comparisons, getDataset: () => ds, getPanel: () => panel,
    beginAnnotationWork, compute, publish });
  return { ds, items, panel, entry, comparisons, work, compute, publish, beginAnnotationWork, refresher,
    close: () => { visible = false; } };
}

describe("refreshing changed plot sources", () => {
  test("uses the displayed source's full group, original band and panel", async () => {
    const f = fixture();
    await expect(f.refresher.refresh(f.ds, 2, [1])).resolves.toEqual([true]);
    expect(f.comparisons.changedAreaSources).toHaveBeenCalledWith(1, 2, [1]);
    expect(f.compute).toHaveBeenCalledTimes(1);
    const [entry, ds, snapshot, options] = f.compute.mock.calls[0];
    expect(entry.band).toBe(7);
    expect(ds).toBe(f.ds);
    expect(snapshot.map(item => item.id)).toEqual([1, 2]);
    expect(snapshot[0]).not.toBe(f.items[0]);
    options.onProgress(2, 3);
    expect(f.work.update).toHaveBeenCalledWith(2, 3);
    expect(f.beginAnnotationWork.mock.calls[0][1].slot).toBe(2);
    expect(f.publish).toHaveBeenCalledWith(f.entry, f.ds, 2, snapshot, { bins: [2, 3] });
    expect(f.work.done).toHaveBeenCalledTimes(1);
  });

  test("a newer move supersedes the pending result", async () => {
    const f = fixture(), finish = [];
    f.compute.mockImplementation(() => new Promise(resolve => finish.push(resolve)));
    const old = f.refresher.refresh(f.ds, 2, [1]);
    f.items[0].points[0].x += 2;
    const latest = f.refresher.refresh(f.ds, 2, [1]);
    expect(f.compute.mock.calls[0][3].cancelled()).toBe(true);
    finish[1]({ bins: [8] });
    await latest;
    finish[0]({ bins: [1] });
    await old;
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.publish.mock.calls[0][3][0].points[0].x).toBe(12);
    expect(f.publish.mock.calls[0][4]).toEqual({ bins: [8] });
    expect(f.work.done).toHaveBeenCalledTimes(2);
  });

  test.each(["close", "move", "delete", "dataset"])("discards results after %s invalidates the source", async action => {
    const f = fixture();
    let finish;
    f.compute.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.refresher.refresh(f.ds, 2, [1]);
    if (action === "close") f.close();
    if (action === "move") f.items[1].points[0].x++;
    if (action === "delete") f.panel.annotations.drawings = f.items.slice(1);
    if (action === "dataset") f.panel.datasetId = 99;
    expect(f.compute.mock.calls[0][3].cancelled()).toBe(true);
    finish({ bins: [9] });
    await expect(pending).resolves.toEqual([false]);
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.work.done).toHaveBeenCalledTimes(1);
  });

  test("closed plots do not start new reads", async () => {
    const f = fixture();
    f.close();
    await expect(f.refresher.refresh(f.ds, 2, [1])).resolves.toEqual([]);
    expect(f.compute).not.toHaveBeenCalled();
  });
});
