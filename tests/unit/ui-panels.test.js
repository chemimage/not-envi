import { describe, expect, test } from "vitest";
import { createUIPanels } from "../../src/app/ui-panels.js";

function makeDeps() {
  const state = { histMode: "whole", datasets: [], activeId: null };
  const els = {};
  return {
    state,
    els,
    getActive: () => null,
    clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
    fmt: (n) => String(n),
    fmtNoGroup: (n) => String(n),
    humanBytes: (n) => String(n),
    bandLabel: (_ds, b) => `B${b}`,
    setActiveDataset: () => {},
    closeDataset: () => {},
    drawHistogram: () => {},
    render: () => {},
    quickStatsFromArray: () => ({ min: 0, max: 1 }),
    onNeedWholeStats: () => {}
  };
}

describe("ui-panels", () => {
  test("getBandSettings initializes defaults once", () => {
    const deps = makeDeps();
    const ui = createUIPanels(deps);
    const ds = { bandSettings: new Map(), activeBand: 2 };
    const a = ui.getBandSettings(ds, 2);
    const b = ui.getBandSettings(ds, 2);
    expect(a).toEqual({ min: null, max: null, gamma: 1, gain: 1, contrast: 1 });
    expect(a).toBe(b);
  });

  test("resolveStats switches between whole and view modes", () => {
    const deps = makeDeps();
    const ui = createUIPanels(deps);
    const whole = { min: 1, max: 2 };
    const view = { min: 3, max: 4 };
    const ds = { activeBand: 5, bandStatsWhole: new Map([[5, whole]]), bandStatsView: view };

    deps.state.histMode = "whole";
    expect(ui.resolveStats(ds)).toBe(whole);
    deps.state.histMode = "view";
    expect(ui.resolveStats(ds)).toBe(view);
  });
});
