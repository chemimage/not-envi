import { describe, expect, test, vi } from "vitest";
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
    expect(a).toEqual({ min: null, max: null, brightness: 0, gain: 1, contrast: 1, gamma: 1 });
    expect(a).toBe(b);
  });

  test("resolveStats uses whole-image stats for display histogram", () => {
    const deps = makeDeps();
    const ui = createUIPanels(deps);
    const whole = { min: 1, max: 2 };
    const view = { min: 3, max: 4 };
    const ds = { activeBand: 5, bandStatsWhole: new Map([[5, whole]]), bandStatsView: view };

    deps.state.histMode = "whole";
    expect(ui.resolveStats(ds)).toBe(whole);
    deps.state.histMode = "view";
    expect(ui.resolveStats(ds)).toBe(whole);
  });

  test("three-band datasets cycle list and color display modes from the tree button", () => {
    document.body.innerHTML = `
      <input id="bandSearch" value="" />
      <div id="bandTree"></div>
      <input id="slContrast" value="1" />
      <input id="slBrightness" value="0" />
      <input id="slGain" value="1" />
      <input id="numContrast" value="1" />
      <input id="numBrightness" value="0" />
      <input id="numGain" value="1" />
      <input id="numMin" value="0" />
      <input id="numMax" value="1" />
    `;

    const deps = makeDeps();
    const render = vi.fn();
    const onNeedWholeStats = vi.fn();
    const ds = {
      id: "ds1",
      meta: { bands: 3 },
      activeBand: 0,
      bandSettings: new Map([[0, { min: null, max: null, brightness: 0, gain: 1, contrast: 1, gamma: 1 }]]),
      bandStatsWhole: new Map([[0, { min: 0, max: 10, p1: 1, p99: 9 }]]),
      bandStatsView: null,
      treeExpanded: true,
      treeScrollTop: 0,
      displayMode: "gray",
      thumb: {}
    };
    deps.state.datasets = [ds];
    deps.state.activeId = ds.id;
    deps.getActive = () => ds;
    deps.render = render;
    deps.onNeedWholeStats = onNeedWholeStats;
    deps.els = {
      bandSearch: document.querySelector("#bandSearch"),
      bandTree: document.querySelector("#bandTree"),
      slContrast: document.querySelector("#slContrast"),
      slBrightness: document.querySelector("#slBrightness"),
      slGain: document.querySelector("#slGain"),
      numContrast: document.querySelector("#numContrast"),
      numBrightness: document.querySelector("#numBrightness"),
      numGain: document.querySelector("#numGain"),
      numMin: document.querySelector("#numMin"),
      numMax: document.querySelector("#numMax")
    };
    const ui = createUIPanels(deps);

    ui.rebuildBandTree();
    expect(document.querySelectorAll(".band-row")).toHaveLength(3);
    expect(document.querySelector(".display-mode-btn")?.classList.contains("mode-gray")).toBe(true);

    document.querySelector(".display-mode-btn")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(ds.displayMode).toBe("rgb");
    expect(document.querySelectorAll(".band-row")).toHaveLength(0);
    expect(document.querySelector(".display-mode-btn")?.classList.contains("mode-rgb")).toBe(true);

    document.querySelector(".display-mode-btn")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(ds.displayMode).toBe("bgr");
    expect(document.querySelector(".display-mode-btn")?.classList.contains("mode-bgr")).toBe(true);

    document.querySelector(".display-mode-btn")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(ds.displayMode).toBe("gray");
    expect(document.querySelectorAll(".band-row")).toHaveLength(3);
    expect(render).toHaveBeenCalledTimes(3);
    expect(onNeedWholeStats).toHaveBeenCalledTimes(9);
  });
});
