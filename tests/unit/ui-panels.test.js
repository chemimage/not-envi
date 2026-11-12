import { afterEach, describe, expect, test, vi } from "vitest";
import { createUIPanels } from "../../src/app/ui-panels.js";

const originalHardwareConcurrency = navigator.hardwareConcurrency;
const originalDeviceMemory = navigator.deviceMemory;

afterEach(() => {
  Object.defineProperty(navigator, "hardwareConcurrency", {
    configurable: true,
    value: originalHardwareConcurrency
  });
  Object.defineProperty(navigator, "deviceMemory", {
    configurable: true,
    value: originalDeviceMemory
  });
});

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

  test("three-band datasets cycle color modes from the band dock", () => {
    document.body.innerHTML = `
      <div id="bandDock"><div id="bandSelector"><div id="bandDockTrack"></div></div><button id="bandColorMode"></button></div>
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
      displayMode: "gray",
      thumb: {}
    };
    deps.state.datasets = [ds];
    deps.state.activeId = ds.id;
    deps.getActive = () => ds;
    deps.render = render;
    deps.onNeedWholeStats = onNeedWholeStats;
    deps.els = {
      bandDock: document.querySelector("#bandDock"),
      bandSelector: document.querySelector("#bandSelector"),
      bandDockTrack: document.querySelector("#bandDockTrack"),
      bandColorMode: document.querySelector("#bandColorMode"),
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

    ui.updateDisplayUI(true);
    expect(deps.els.bandColorMode.textContent).toBe("Gray");

    deps.els.bandColorMode.click();
    expect(ds.displayMode).toBe("rgb");
    expect(deps.els.bandColorMode.textContent).toBe("RGB");

    const composite = { rasterByBand: new Map() };
    ds.lastCompositeRaster = composite;
    const statsRequests = onNeedWholeStats.mock.calls.length;
    deps.els.bandColorMode.click();
    expect(ds.displayMode).toBe("bgr");
    expect(deps.els.bandColorMode.textContent).toBe("BGR");
    expect(ds.lastCompositeRaster).toBe(composite);
    expect(render).toHaveBeenLastCalledWith({ reuseRaster: true });
    expect(onNeedWholeStats).toHaveBeenCalledTimes(statsRequests);

    deps.els.bandColorMode.click();
    expect(ds.displayMode).toBe("gray");
    expect(deps.els.bandColorMode.textContent).toBe("Gray");
    expect(render).toHaveBeenCalledTimes(3);
    expect(ds.lastCompositeRaster).toBeNull();
    expect(onNeedWholeStats).toHaveBeenCalledTimes(4);
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

  test("shared display range keeps min and max across bands", () => {
    document.body.innerHTML = `
      <input id="slContrast" value="1" />
      <input id="slBrightness" value="0" />
      <input id="slGain" value="1" />
      <input id="numContrast" value="1" />
      <input id="numBrightness" value="0" />
      <input id="numGain" value="1" />
      <input id="numMin" value="0" />
      <input id="numMax" value="0.5" />
      <button id="btnHistRangeLock" type="button" aria-pressed="false"><i></i></button>
      <canvas id="hist"></canvas>
    `;

    const deps = makeDeps();
    const render = vi.fn();
    const drawHistogram = vi.fn();
    const ds = {
      id: "ds1",
      meta: { bands: 2 },
      activeBand: 0,
      bandSettings: new Map([
        [0, { min: null, max: null, brightness: 0, gain: 1, contrast: 1, gamma: 1 }],
        [1, { min: null, max: null, brightness: 0.2, gain: 1.2, contrast: 1.4, gamma: 1 }]
      ]),
      bandStatsWhole: new Map([
        [0, { min: 0, max: 2, p1: 0.1, p99: 1.9 }],
        [1, { min: 0, max: 2, p1: 0.2, p99: 1.8 }]
      ]),
      bandStatsView: null
    };
    deps.getActive = () => ds;
    deps.render = render;
    deps.drawHistogram = drawHistogram;
    deps.els = {
      slContrast: document.querySelector("#slContrast"),
      slBrightness: document.querySelector("#slBrightness"),
      slGain: document.querySelector("#slGain"),
      numContrast: document.querySelector("#numContrast"),
      numBrightness: document.querySelector("#numBrightness"),
      numGain: document.querySelector("#numGain"),
      numMin: document.querySelector("#numMin"),
      numMax: document.querySelector("#numMax"),
      btnHistRangeLock: document.querySelector("#btnHistRangeLock"),
      hist: document.querySelector("#hist")
    };

    const ui = createUIPanels(deps);
    ui.toggleSharedDisplayRange(ds);
    expect(ds.sharedDisplayRange).toMatchObject({ enabled: true, min: 0, max: 0.5 });
    expect(deps.els.btnHistRangeLock.getAttribute("aria-pressed")).toBe("true");

    deps.els.numMin.value = "0.25";
    deps.els.numMax.value = "0.75";
    ui.applyRangeFromNumbers(ds);
    expect(ds.sharedDisplayRange).toMatchObject({ enabled: true, min: 0.25, max: 0.75 });

    ds.activeBand = 1;
    ui.updateDisplayUI(true);
    expect(deps.els.numMin.value).toBe("0.25");
    expect(deps.els.numMax.value).toBe("0.75");
    expect(ui.getBandSettings(ds, 1).min).toBe(0.25);
    expect(ui.getBandSettings(ds, 1).max).toBe(0.75);
    expect(ui.getBandSettings(ds, 1).contrast).toBe(1.4);
  });

  test("numeric display range inputs keep user values outside current histogram stats", () => {
    document.body.innerHTML = `
      <input id="slContrast" value="1" />
      <input id="slBrightness" value="0" />
      <input id="slGain" value="1" />
      <input id="numContrast" value="1" />
      <input id="numBrightness" value="0" />
      <input id="numGain" value="1" />
      <input id="numMin" value="0" />
      <input id="numMax" value="1" />
      <button id="btnHistRangeLock" type="button" aria-pressed="false"><i></i></button>
      <canvas id="hist"></canvas>
    `;

    const deps = makeDeps();
    const ds = {
      id: "ds1",
      meta: { bands: 1 },
      activeBand: 0,
      bandSettings: new Map([[0, { min: null, max: null, brightness: 0, gain: 1, contrast: 1, gamma: 1 }]]),
      bandStatsWhole: new Map([[0, { min: 10, max: 20, p1: 11, p99: 19 }]]),
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
      btnHistRangeLock: document.querySelector("#btnHistRangeLock"),
      hist: document.querySelector("#hist")
    };

    const ui = createUIPanels(deps);
    deps.els.numMin.value = "5.123456";
    deps.els.numMax.value = "25.654321";
    ui.applyRangeFromNumbers(ds);

    expect(ui.getBandSettings(ds, 0).min).toBe(5.123456);
    expect(ui.getBandSettings(ds, 0).max).toBe(25.654321);
    ui.updateDisplayUI(true);
    expect(deps.els.numMin.value).toBe("5.12346");
    expect(deps.els.numMax.value).toBe("25.6543");
  });

  test("numeric display range inputs apply before histogram stats are ready", () => {
    document.body.innerHTML = `
      <input id="slContrast" value="1" />
      <input id="slBrightness" value="0" />
      <input id="slGain" value="1" />
      <input id="numContrast" value="1" />
      <input id="numBrightness" value="0" />
      <input id="numGain" value="1" />
      <input id="numMin" value="0" />
      <input id="numMax" value="1" />
      <button id="btnHistRangeLock" type="button" aria-pressed="false"><i></i></button>
      <canvas id="hist"></canvas>
    `;

    const deps = makeDeps();
    const ds = {
      id: "ds1",
      meta: { bands: 1 },
      activeBand: 0,
      bandSettings: new Map([[0, { min: null, max: null, brightness: 0, gain: 1, contrast: 1, gamma: 1 }]]),
      bandStatsWhole: new Map(),
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
      btnHistRangeLock: document.querySelector("#btnHistRangeLock"),
      hist: document.querySelector("#hist")
    };

    const ui = createUIPanels(deps);
    deps.els.numMin.value = "30";
    deps.els.numMax.value = "10";
    ui.applyRangeFromNumbers(ds);

    expect(ui.getBandSettings(ds, 0).min).toBe(10);
    expect(ui.getBandSettings(ds, 0).max).toBe(30);
    expect(deps.els.numMin.value).toBe("10");
    expect(deps.els.numMax.value).toBe("30");
  });

  test("band changes follow the selected panel", () => {
    document.body.innerHTML = `
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
    };
    deps.state.datasets = [ds];
    deps.state.activeId = ds.id;
    deps.getActive = () => ds;
    deps.getActivePanel = () => activePanel;
    deps.els = {
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
    const ds1 = { id: "ds1", name: "A", meta: { samples: 64, lines: 32, bands: 3, interleave: "bsq", dataType: 4, dataTypeInfo: { name: "f32" }, littleEndian: true } };
    const ds2 = { id: "ds2", name: "B", meta: { samples: 64, lines: 32, bands: 3, interleave: "bsq", dataType: 4, dataTypeInfo: { name: "f32" }, littleEndian: true } };
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
    expect(ds1Row?.querySelector(".body")).not.toBeNull();
    expect(ds1Row?.querySelector(".title")?.textContent).toBe("A");
    const buttons = ds1Row?.querySelectorAll(".slot-btn");
    expect(buttons?.[0]?.textContent).toBe("L");
    expect(buttons?.[0]?.className).toContain("slot-link-amber");
    expect(buttons?.[1]?.textContent).toBe("R");
    expect(buttons?.[1]?.className).toContain("slot-link-amber");
    expect(buttons?.[2]?.textContent).toBe("L|R");
    expect(buttons?.[2]?.className).toContain("overlay-active");
  });

  test("dataset title enables marquee styling on focus when overflowed", () => {
    document.body.innerHTML = `
      <div id="datasetList"></div>
      <div id="datasetCount"></div>
    `;

    const deps = makeDeps();
    const ds1 = {
      id: "ds1",
      name: "Extremely long dataset name that should scroll when focused on touch or keyboard",
      meta: { samples: 64, lines: 32, bands: 3, interleave: "bsq", dataType: 4, dataTypeInfo: { name: "f32" }, littleEndian: true },
    };
    deps.state.datasets = [ds1];
    deps.state.activeId = "ds1";
    deps.els = {
      datasetList: document.querySelector("#datasetList"),
      datasetCount: document.querySelector("#datasetCount")
    };

    const ui = createUIPanels(deps);
    ui.rebuildDatasetList();

    const ds1Row = document.querySelector('.ds-item[data-dsid="ds1"]');
    const title = ds1Row?.querySelector(".title");
    const titleText = ds1Row?.querySelector(".title-text");
    expect(ds1Row?.tabIndex).toBe(0);
    expect(titleText?.textContent).toContain("Extremely long dataset name");

    Object.defineProperty(title, "clientWidth", {
      configurable: true,
      value: 80
    });
    Object.defineProperty(titleText, "scrollWidth", {
      configurable: true,
      value: 180
    });

    ds1Row?.onfocus?.();

    expect(title?.classList.contains("overflowing")).toBe(true);
    expect(title?.style.getPropertyValue("--title-marquee-distance")).toBe("124px");
  });

  test("perf tooltip includes detected hardware and chosen budgets", () => {
    Object.defineProperty(navigator, "hardwareConcurrency", {
      configurable: true,
      value: 8
    });
    Object.defineProperty(navigator, "deviceMemory", {
      configurable: true,
      value: 16
    });

    document.body.innerHTML = `
      <div id="perfBarCacheText"></div>
      <div id="perfBarCacheFill"></div>
    `;

    const deps = makeDeps();
    const ds = {
      meta: { sourceFormat: "tiff" },
      ds: {
        cacheBytes: () => 48,
        maxBytes: 96,
        profileName: "standard",
        rawCacheLimitBytes: 32,
        decodedCacheLimitBytes: 64,
        workerPoolSize: 3,
        taskConcurrency: 4,
        stats: {
          bytesRead: 12,
          readCalls: 2,
          readIntoCalls: 3,
          cacheHits: 5,
          cacheMisses: 1,
          cacheEvictions: 0,
          raster: {
            windowCalls: 7,
            slabWindowCalls: 4,
            rowWindowCalls: 3,
            windowReadMs: 8.5
          }
        }
      },
      pyramid: {
        totalBytes: 24,
        limitBytes: 48,
        stats: {
          tileReads: 9,
          tilesComposed: 6,
          composeMs: 4.2
        }
      },
      renderStats: {
        pyramidHits: 2,
        pyramidMisses: 1,
        directReadMs: 1.5
      },
      chunkBudgetBytes: 96,
      pyramidBudgetBytes: 48
    };
    deps.getActive = () => ds;
    deps.cacheBudget = {
      totalBytes: 512,
      detectedBudgetBasisBytes: 1024
    };
    deps.els = {
      perfBarCacheText: document.querySelector("#perfBarCacheText"),
      perfBarCacheFill: document.querySelector("#perfBarCacheFill")
    };

    const ui = createUIPanels(deps);
    ui.updatePerf();

    expect(deps.els.perfBarCacheText.title).toContain("Browser: 8 cores, 16 GiB deviceMemory");
    expect(deps.els.perfBarCacheText.title).toContain("Budgets: 512 total from 1024 basis, dataset 96 chunk + 48 pyramid");
    expect(deps.els.perfBarCacheText.title).toContain("TIFF: standard profile, 32 raw + 64 decoded, 3 workers, 4 tasks");
  });
});
