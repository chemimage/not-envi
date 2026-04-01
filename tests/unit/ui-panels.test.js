import { describe, expect, test, vi } from "vitest";
import { createUIPanels } from "../../src/app/ui-panels.js";

function makeDeps() {
  const state = { histMode: "whole", datasets: [], activeId: null };
  const els = {};
  return {
    state,
    els,
    getActive: () => null,
    getActivePanel: () => null,
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

  test("display panel channel button cycles RGB adjustments in color mode", () => {
    document.body.innerHTML = `
      <input id="slContrast" value="1" />
      <input id="slBrightness" value="0" />
      <input id="slGain" value="1" />
      <input id="numContrast" value="1" />
      <input id="numBrightness" value="0" />
      <input id="numGain" value="1" />
      <input id="numMin" value="0" />
      <input id="numMax" value="1" />
      <button id="btnHistChannel" style="display:none;"></button>
      <canvas id="hist"></canvas>
    `;

    const deps = makeDeps();
    const ds = {
      id: "ds1",
      meta: { bands: 3 },
      activeBand: 0,
      displayMode: "rgb",
      displayAdjustColor: "red",
      bandSettings: new Map([
        [0, { min: 1, max: 10, brightness: 0.1, gain: 1.1, contrast: 1.2, gamma: 1 }],
        [1, { min: 2, max: 20, brightness: 0.2, gain: 1.2, contrast: 1.3, gamma: 1 }],
        [2, { min: 3, max: 30, brightness: 0.3, gain: 1.3, contrast: 1.4, gamma: 1 }]
      ]),
      bandStatsWhole: new Map([
        [0, { min: 0, max: 10, p1: 1, p99: 9 }],
        [1, { min: 0, max: 20, p1: 2, p99: 18 }],
        [2, { min: 0, max: 30, p1: 3, p99: 27 }]
      ]),
      bandStatsView: null
    };
    deps.getActive = () => ds;
    deps.els = {
      slContrast: document.querySelector("#slContrast"),
      slBrightness: document.querySelector("#slBrightness"),
      slGain: document.querySelector("#slGain"),
      numContrast: document.querySelector("#numContrast"),
      numBrightness: document.querySelector("#numBrightness"),
      numGain: document.querySelector("#numGain"),
      numMin: document.querySelector("#numMin"),
      numMax: document.querySelector("#numMax"),
      btnHistChannel: document.querySelector("#btnHistChannel"),
      hist: document.querySelector("#hist")
    };
    const ui = createUIPanels(deps);

    ui.updateDisplayUI(true);
    expect(deps.els.btnHistChannel.style.display).toBe("inline-flex");
    expect(deps.els.btnHistChannel.textContent).toBe("R");
    expect(deps.els.btnHistChannel.className).toContain("channel-red");
    expect(deps.els.slContrast.value).toBe("1.2");
    expect(deps.els.numMin.value).toBe("1");

    ui.cycleDisplayAdjustColor(ds);
    expect(deps.els.btnHistChannel.textContent).toBe("G");
    expect(deps.els.btnHistChannel.className).toContain("channel-green");
    expect(deps.els.slContrast.value).toBe("1.3");
    expect(deps.els.numMin.value).toBe("2");

    ui.cycleDisplayAdjustColor(ds);
    expect(deps.els.btnHistChannel.textContent).toBe("B");
    expect(deps.els.btnHistChannel.className).toContain("channel-blue");
    expect(deps.els.slContrast.value).toBe("1.4");
    expect(deps.els.numMin.value).toBe("3");
  });

  test("band tree and band changes follow the selected panel band", () => {
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
    const activePanel = { slot: 2, datasetId: "ds1", activeBand: 1 };
    const otherPanel = { slot: 1, datasetId: "ds1", activeBand: 0 };
    const ds = {
      id: "ds1",
      meta: { bands: 3 },
      activeBand: 0,
      bandSettings: new Map([[0, { min: null, max: null, brightness: 0, gain: 1, contrast: 1, gamma: 1 }]]),
      bandStatsWhole: new Map([[1, { min: 0, max: 10, p1: 1, p99: 9 }]]),
      bandStatsView: null,
      treeExpanded: true,
      treeScrollTop: 0
    };
    deps.state.datasets = [ds];
    deps.state.activeId = ds.id;
    deps.getActive = () => ds;
    deps.getActivePanel = () => activePanel;
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
    expect(document.querySelectorAll(".band-row.active")).toHaveLength(1);
    expect(document.querySelectorAll(".band-row")[1]?.classList.contains("active")).toBe(true);

    ui.setActiveBand(ds, 2);
    expect(activePanel.activeBand).toBe(2);
    expect(otherPanel.activeBand).toBe(0);
    expect(ds.activeBand).toBe(2);
  });

  test("dataset panel buttons render L, R, and L|R states", () => {
    document.body.innerHTML = `
      <div id="datasetList"></div>
      <div id="datasetCount"></div>
    `;

    const deps = makeDeps();
    const ds1 = { id: "ds1", name: "A", meta: { samples: 64, lines: 32, bands: 3, interleave: "bsq", dataType: 4, dataTypeInfo: { name: "f32" }, littleEndian: true }, treeExpanded: true };
    const ds2 = { id: "ds2", name: "B", meta: { samples: 64, lines: 32, bands: 3, interleave: "bsq", dataType: 4, dataTypeInfo: { name: "f32" }, littleEndian: true }, treeExpanded: true };
    deps.state.datasets = [ds1, ds2];
    deps.state.activeId = "ds1";
    deps.state.activePanelSlot = 1;
    deps.state.displayCompositionMode = "overlay";
    deps.state.displayPanels = [
      { slot: 1, datasetId: "ds1", linkGroupId: 1, activeBand: 0, view: {} },
      { slot: 2, datasetId: "ds1", linkGroupId: 1, activeBand: 1, view: {} }
    ];
    deps.els = {
      datasetList: document.querySelector("#datasetList"),
      datasetCount: document.querySelector("#datasetCount")
    };

    const ui = createUIPanels(deps);
    ui.rebuildDatasetList();

    const ds1Row = document.querySelector('.ds-item[data-dsid="ds1"]');
    const buttons = ds1Row?.querySelectorAll(".slot-btn");
    expect(buttons?.[0]?.textContent).toBe("L");
    expect(buttons?.[0]?.className).toContain("slot-link-amber");
    expect(buttons?.[1]?.textContent).toBe("R");
    expect(buttons?.[1]?.className).toContain("slot-link-amber");
    expect(buttons?.[2]?.textContent).toBe("L|R");
    expect(buttons?.[2]?.className).toContain("overlay-active");
  });
});
