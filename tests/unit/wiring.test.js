import { afterEach, describe, expect, test, vi } from "vitest";
import { wireApp } from "../../src/app/wiring.js";

function noop() {}

function makeButton() {
  return { onclick: null, classList: { add: noop, remove: noop }, addEventListener: noop };
}

function setupEraserHarness() {
  const windowAdd = vi.spyOn(window, "addEventListener").mockImplementation(noop);

  document.body.innerHTML = `
    <div id="drawTools"></div>
    <button id="toolEraser" type="button"></button>
    <div id="main"></div>
    <aside id="right" data-open="false" data-pinned="false">
      <div id="rightHeader"><h2>Bands</h2><button id="btnRightPin" type="button"><i></i></button></div>
    </aside>
    <aside id="displayPanel" data-open="false" data-pinned="false">
      <div id="displayHeader"><h2>Display</h2><button id="btnDisplayPin" type="button"><i></i></button></div>
    </aside>
    <canvas id="thumb"></canvas>
    <input id="zoom" />
    <input id="chkGrid" type="checkbox" />
    <button id="btnExpCancel" type="button"></button>
    <button id="btnExpGo" type="button"></button>
    <input id="bandSearch" />
    <button id="btnExpandAll" type="button"></button>
    <button id="btnCollapseAll" type="button"></button>
    <button id="btnReset" type="button"></button>
    <button id="btnAuto" type="button"></button>
    <input id="slContrast" />
    <input id="slBrightness" />
    <input id="slGain" />
    <input id="numContrast" />
    <input id="numBrightness" />
    <input id="numGain" />
    <input id="numMin" />
    <input id="numMax" />
    <canvas id="hist"></canvas>
    <div id="dropzone"></div>
    <input id="filePicker" type="file" />
    <input id="expFormatPng" type="radio" />
    <input id="expFormatTiff" type="radio" />
    <input id="expModeRaw" type="radio" />
    <input id="expModeRendered" type="radio" />
    <input id="expRawScopeSel" type="radio" />
    <input id="expRawScopeWhole" type="radio" />
    <input id="expRenScopeSel" type="radio" />
    <input id="expRenScopeView" type="radio" />
    <input id="expRenScopeWhole" type="radio" />
    <dialog id="exportDlg"></dialog>
    <canvas id="cpuCanvas"></canvas>
  `;

  const els = {
    drawTools: document.querySelector("#drawTools"),
    toolEraser: document.querySelector("#toolEraser"),
    main: document.querySelector("#main"),
    right: document.querySelector("#right"),
    rightHeader: document.querySelector("#rightHeader"),
    btnRightPin: document.querySelector("#btnRightPin"),
    displayPanel: document.querySelector("#displayPanel"),
    displayHeader: document.querySelector("#displayHeader"),
    btnDisplayPin: document.querySelector("#btnDisplayPin"),
    thumb: document.querySelector("#thumb"),
    zoom: document.querySelector("#zoom"),
    chkGrid: document.querySelector("#chkGrid"),
    btnExpCancel: document.querySelector("#btnExpCancel"),
    btnExpGo: document.querySelector("#btnExpGo"),
    bandSearch: document.querySelector("#bandSearch"),
    btnExpandAll: document.querySelector("#btnExpandAll"),
    btnCollapseAll: document.querySelector("#btnCollapseAll"),
    btnReset: document.querySelector("#btnReset"),
    btnAuto: document.querySelector("#btnAuto"),
    slContrast: document.querySelector("#slContrast"),
    slBrightness: document.querySelector("#slBrightness"),
    slGain: document.querySelector("#slGain"),
    numContrast: document.querySelector("#numContrast"),
    numBrightness: document.querySelector("#numBrightness"),
    numGain: document.querySelector("#numGain"),
    numMin: document.querySelector("#numMin"),
    numMax: document.querySelector("#numMax"),
    hist: document.querySelector("#hist"),
    dropzone: document.querySelector("#dropzone"),
    filePicker: document.querySelector("#filePicker"),
    expFormatPng: document.querySelector("#expFormatPng"),
    expFormatTiff: document.querySelector("#expFormatTiff"),
    expModeRaw: document.querySelector("#expModeRaw"),
    expModeRendered: document.querySelector("#expModeRendered"),
    expRawScopeSel: document.querySelector("#expRawScopeSel"),
    expRawScopeWhole: document.querySelector("#expRawScopeWhole"),
    expRenScopeSel: document.querySelector("#expRenScopeSel"),
    expRenScopeView: document.querySelector("#expRenScopeView"),
    expRenScopeWhole: document.querySelector("#expRenScopeWhole"),
    exportDlg: document.querySelector("#exportDlg"),
    cpuCanvas: document.querySelector("#cpuCanvas")
  };

  els.hist.setPointerCapture = noop;
  els.hist.releasePointerCapture = noop;

  const state = {
    datasets: [],
    histDrag: { active: false, handle: null },
    selection: { enabled: false },
    ioParallel: true
  };
  let activeTool = "none";
  const setDrawTool = vi.fn((tool) => {
    const next = tool === "eraser" ? "eraser" : "none";
    activeTool = activeTool === next ? "none" : next;
  });
  const clearAllAnnotations = vi.fn();

  wireApp({
    state,
    els,
    clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
    getActive: () => ({ drawings: [] }),
    closeSpectrum: noop,
    exportSpectrumCSV: noop,
    screenToImage: () => ({ x: 0, y: 0 }),
    openSpectrumAt: noop,
    onPointerDown: noop,
    onPointerMove: noop,
    onPointerUp: noop,
    onPointerCancel: noop,
    onPointerLeave: noop,
    onWheel: noop,
    onThumbClick: noop,
    fitToScreen: noop,
    clampView: noop,
    scaleToSlider: () => 50,
    updateZoomLabel: noop,
    render: noop,
    zoomAt: noop,
    sliderToScale: () => 1,
    minScaleFor: () => 1,
    setIOParallel: noop,
    clearSelection: noop,
    setStatus: noop,
    openExportDialog: noop,
    updateExportDialogUI: noop,
    updateExportEstimate: noop,
    runExportFromDialog: async () => {},
    rebuildBandTree: noop,
    resetDisplay: noop,
    autoDisplay: noop,
    resolveDisplayControlBand: () => 0,
    getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
    drawHistogram: noop,
    applyRangeFromNumbers: noop,
    histPickHandle: () => null,
    applyHistogramDrag: noop,
    addDatasetsFromFileList: async () => {},
    resizeCanvases: noop,
    redrawSpectrum: noop,
    disposePyramid: noop,
    updateMetaUI: noop,
    updatePerf: noop,
    getDrawTool: () => activeTool,
    getSpectrumPickEnabled: () => false,
    getEffectiveAreaSelectionCount: () => 0,
    getEffectiveAreaSelectionKey: () => "",
    getAreaSelectionMode: () => "single",
    getDrawColor: () => "#ff2d2d",
    setDrawTool,
    setSpectrumPickEnabled: noop,
    setAreaSelectionMode: noop,
    setDrawColor: noop,
    selectAreaAtPointer: () => false,
    isAreaMovePointer: () => false,
    beginAreaMoveAtPointer: () => false,
    updateAreaMoveAtPointer: noop,
    finishAreaMoveAtPointer: noop,
    cancelAreaMove: noop,
    resolvePointerCursor: () => "",
    isDrawingPointer: () => false,
    beginDrawingAtPointer: () => false,
    updateDrawingAtPointer: noop,
    finishDrawingAtPointer: noop,
    cancelDrawing: noop,
    eraseDrawingAtPointer: noop,
    clearAllAnnotations,
    updateRulerHoverAtPointer: noop,
    clearRulerHover: noop,
    toggleAnalysisHistogramPanel: noop,
    getAnalysisHistogramOpen: () => false,
    setAnalysisHistogramOpen: noop,
    closeAnalysisHistogramPanel: noop,
    refreshAnalysisHistogram: async () => {},
    positionAnalysisHistogramPanel: noop,
    onAnalysisHistogramPointerMove: noop,
    onAnalysisHistogramPointerLeave: noop,
    openSpectrumForEffectiveArea: async () => {},
    updateZoomLabelBoot: noop,
    setGpuBadgeAvailable: noop
  });

  return {
    els,
    clearAllAnnotations,
    getActiveTool: () => activeTool,
    windowAdd
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("app wiring", () => {
  test("boot wiring initializes status/meta/perf and gpu badge", () => {
    const addEventListener = vi.fn();
    const windowAdd = vi.spyOn(window, "addEventListener").mockImplementation(noop);
    const els = {
      main: { addEventListener, getBoundingClientRect: () => ({ left: 0, top: 0 }) },
      specPanel: null,
      btnSpecClose: null,
      btnSpecCSV: null,
      thumb: { addEventListener, width: 100, height: 100 },
      btnFit: makeButton(),
      btn100: makeButton(),
      btnZoomIn: makeButton(),
      btnZoomOut: makeButton(),
      zoom: { oninput: null, value: "50" },
      chkGrid: { oninput: null },
      chkScale: { oninput: null },
      btnSelect: makeButton(),
      btnExport: makeButton(),
      expFormatPng: { oninput: null, checked: false },
      expFormatTiff: { oninput: null, checked: true },
      expModeRaw: { oninput: null },
      expModeRendered: { oninput: null },
      expRawScopeSel: { oninput: null },
      expRawScopeWhole: { oninput: null },
      expRenScopeSel: { oninput: null },
      expRenScopeView: { oninput: null },
      expRenScopeWhole: { oninput: null },
      btnExpCancel: makeButton(),
      btnExpGo: makeButton(),
      exportDlg: { close: noop, open: false },
      bandSearch: { oninput: null, value: "" },
      btnExpandAll: makeButton(),
      btnCollapseAll: makeButton(),
      btnReset: makeButton(),
      btnAuto: makeButton(),
      slContrast: { oninput: null, value: "1" },
      slBrightness: { oninput: null, value: "0" },
      slGain: { oninput: null, value: "1" },
      numContrast: { onchange: null, value: "1" },
      numBrightness: { onchange: null, value: "0" },
      numGain: { onchange: null, value: "1" },
      numMin: { onchange: null, value: "0" },
      numMax: { onchange: null, value: "1" },
      chkHistView: { oninput: null, checked: false },
      hist: { addEventListener, setPointerCapture: noop, releasePointerCapture: noop },
      dropzone: { addEventListener, classList: { add: noop, remove: noop } },
      filePicker: { onchange: null, click: noop, value: "" },
      cpuCanvas: { width: 100, height: 100 },
      gpuBadge: { textContent: "" }
    };

    const state = { datasets: [], histDrag: { active: false, handle: null }, selection: { enabled: false }, ioParallel: true };
    const setStatus = vi.fn();
    const updateMetaUI = vi.fn();
    const updatePerf = vi.fn();
    const updateZoomLabelBoot = vi.fn();

    const setIOParallel = vi.fn();
    wireApp({
      state,
      els,
      clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
      getActive: () => null,
      closeSpectrum: noop,
      exportSpectrumCSV: noop,
      screenToImage: () => ({ x: 0, y: 0 }),
      openSpectrumAt: noop,
      onPointerDown: noop,
      onPointerMove: noop,
      onPointerUp: noop,
      onPointerLeave: noop,
      onWheel: noop,
      onThumbClick: noop,
      fitToScreen: noop,
      clampView: noop,
      scaleToSlider: () => 50,
      updateZoomLabel: noop,
      render: noop,
      zoomAt: noop,
      sliderToScale: () => 1,
      minScaleFor: () => 1,
      setIOParallel,
      clearSelection: noop,
      setStatus,
      openExportDialog: noop,
      updateExportDialogUI: noop,
      updateExportEstimate: noop,
      runExportFromDialog: async () => {},
      rebuildBandTree: noop,
      resetDisplay: noop,
      autoDisplay: noop,
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      drawHistogram: noop,
      applyRangeFromNumbers: noop,
      ensureViewHistogram: noop,
      syncRangeInputsFromSettings: noop,
      histPickHandle: () => null,
      applyHistogramDrag: noop,
      addDatasetsFromFileList: async () => {},
      resizeCanvases: noop,
      redrawSpectrum: noop,
      disposePyramid: noop,
      updateMetaUI,
      updatePerf,
      updateZoomLabelBoot,
      setGpuBadgeAvailable: () => { els.gpuBadge.textContent = "ok"; }
    });

    expect(setStatus).toHaveBeenCalledWith("idle", "");
    expect(updateMetaUI).toHaveBeenCalled();
    expect(updatePerf).toHaveBeenCalled();
    expect(updateZoomLabelBoot).toHaveBeenCalled();
    expect(setIOParallel).toHaveBeenCalledWith(true);
    expect(els.gpuBadge.textContent).toBe("ok");
    windowAdd.mockRestore();
  });

  test("touch double-tap on eraser clears all annotations and keeps eraser active", () => {
    vi.useFakeTimers();
    const { els, clearAllAnnotations, getActiveTool, windowAdd } = setupEraserHarness();

    const dispatchTouchPointerUp = (timeStamp) => {
      const ev = new Event("pointerup", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "pointerType", { value: "touch" });
      Object.defineProperty(ev, "timeStamp", { value: timeStamp });
      els.toolEraser.dispatchEvent(ev);
    };

    dispatchTouchPointerUp(100);
    els.toolEraser.click();
    expect(getActiveTool()).toBe("eraser");
    expect(clearAllAnnotations).not.toHaveBeenCalled();

    dispatchTouchPointerUp(320);
    els.toolEraser.click();
    expect(clearAllAnnotations).toHaveBeenCalledTimes(1);
    expect(getActiveTool()).toBe("eraser");

    windowAdd.mockRestore();
  });

  test("desktop double-click on eraser clears all annotations and keeps eraser active", () => {
    const { els, clearAllAnnotations, getActiveTool, windowAdd } = setupEraserHarness();

    els.toolEraser.click();
    expect(getActiveTool()).toBe("eraser");

    els.toolEraser.click();
    expect(getActiveTool()).toBe("none");

    els.toolEraser.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(clearAllAnnotations).toHaveBeenCalledTimes(1);
    expect(getActiveTool()).toBe("eraser");

    windowAdd.mockRestore();
  });

  test("boot wiring attaches flyout behavior to bands and display panels", () => {
    const { els, windowAdd } = setupEraserHarness();

    expect(els.right.dataset.open).toBe("false");
    expect(els.displayPanel.dataset.open).toBe("false");

    els.rightHeader.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    els.displayHeader.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(els.right.dataset.open).toBe("true");
    expect(els.displayPanel.dataset.open).toBe("true");

    windowAdd.mockRestore();
  });

  test("dropping files on dropzone imports once instead of bubbling to main", async () => {
    const windowAdd = vi.spyOn(window, "addEventListener").mockImplementation(noop);

    document.body.innerHTML = `
      <div id="drawTools"></div>
      <div id="main">
        <div id="dropzone"></div>
      </div>
      <canvas id="thumb"></canvas>
      <input id="zoom" />
      <input id="chkGrid" type="checkbox" />
      <button id="btnExpCancel" type="button"></button>
      <button id="btnExpGo" type="button"></button>
      <input id="bandSearch" />
      <button id="btnExpandAll" type="button"></button>
      <button id="btnCollapseAll" type="button"></button>
      <button id="btnReset" type="button"></button>
      <button id="btnAuto" type="button"></button>
      <input id="slContrast" />
      <input id="slBrightness" />
      <input id="slGain" />
      <input id="numContrast" />
      <input id="numBrightness" />
      <input id="numGain" />
      <input id="numMin" />
      <input id="numMax" />
      <canvas id="hist"></canvas>
      <input id="filePicker" type="file" />
      <input id="expFormatPng" type="radio" />
      <input id="expFormatTiff" type="radio" />
      <input id="expModeRaw" type="radio" />
      <input id="expModeRendered" type="radio" />
      <input id="expRawScopeSel" type="radio" />
      <input id="expRawScopeWhole" type="radio" />
      <input id="expRenScopeSel" type="radio" />
      <input id="expRenScopeView" type="radio" />
      <input id="expRenScopeWhole" type="radio" />
      <dialog id="exportDlg"></dialog>
      <canvas id="cpuCanvas"></canvas>
    `;

    const addDatasetsFromFileList = vi.fn(async () => {});
    const els = {
      drawTools: document.querySelector("#drawTools"),
      main: document.querySelector("#main"),
      thumb: document.querySelector("#thumb"),
      zoom: document.querySelector("#zoom"),
      chkGrid: document.querySelector("#chkGrid"),
      btnExpCancel: document.querySelector("#btnExpCancel"),
      btnExpGo: document.querySelector("#btnExpGo"),
      bandSearch: document.querySelector("#bandSearch"),
      btnExpandAll: document.querySelector("#btnExpandAll"),
      btnCollapseAll: document.querySelector("#btnCollapseAll"),
      btnReset: document.querySelector("#btnReset"),
      btnAuto: document.querySelector("#btnAuto"),
      slContrast: document.querySelector("#slContrast"),
      slBrightness: document.querySelector("#slBrightness"),
      slGain: document.querySelector("#slGain"),
      numContrast: document.querySelector("#numContrast"),
      numBrightness: document.querySelector("#numBrightness"),
      numGain: document.querySelector("#numGain"),
      numMin: document.querySelector("#numMin"),
      numMax: document.querySelector("#numMax"),
      hist: document.querySelector("#hist"),
      dropzone: document.querySelector("#dropzone"),
      filePicker: document.querySelector("#filePicker"),
      expFormatPng: document.querySelector("#expFormatPng"),
      expFormatTiff: document.querySelector("#expFormatTiff"),
      expModeRaw: document.querySelector("#expModeRaw"),
      expModeRendered: document.querySelector("#expModeRendered"),
      expRawScopeSel: document.querySelector("#expRawScopeSel"),
      expRawScopeWhole: document.querySelector("#expRawScopeWhole"),
      expRenScopeSel: document.querySelector("#expRenScopeSel"),
      expRenScopeView: document.querySelector("#expRenScopeView"),
      expRenScopeWhole: document.querySelector("#expRenScopeWhole"),
      exportDlg: document.querySelector("#exportDlg"),
      cpuCanvas: document.querySelector("#cpuCanvas")
    };

    els.hist.setPointerCapture = noop;
    els.hist.releasePointerCapture = noop;

    wireApp({
      state: { datasets: [], histDrag: { active: false, handle: null }, selection: { enabled: false }, ioParallel: true },
      els,
      clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
      getActive: () => null,
      closeSpectrum: noop,
      exportSpectrumCSV: noop,
      screenToImage: () => ({ x: 0, y: 0 }),
      openSpectrumAt: noop,
      onPointerDown: noop,
      onPointerMove: noop,
      onPointerUp: noop,
      onPointerCancel: noop,
      onPointerLeave: noop,
      onWheel: noop,
      onThumbClick: noop,
      fitToScreen: noop,
      clampView: noop,
      scaleToSlider: () => 50,
      updateZoomLabel: noop,
      render: noop,
      zoomAt: noop,
      sliderToScale: () => 1,
      minScaleFor: () => 1,
      setIOParallel: noop,
      clearSelection: noop,
      setStatus: noop,
      openExportDialog: noop,
      updateExportDialogUI: noop,
      updateExportEstimate: noop,
      runExportFromDialog: async () => {},
      rebuildBandTree: noop,
      resetDisplay: noop,
      autoDisplay: noop,
      resolveDisplayControlBand: () => 0,
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      drawHistogram: noop,
      applyRangeFromNumbers: noop,
      histPickHandle: () => null,
      applyHistogramDrag: noop,
      addDatasetsFromFileList,
      resizeCanvases: noop,
      redrawSpectrum: noop,
      disposePyramid: noop,
      updateMetaUI: noop,
      updatePerf: noop,
      getDrawTool: () => "none",
      getSpectrumPickEnabled: () => false,
      getEffectiveAreaSelectionCount: () => 0,
      getEffectiveAreaSelectionKey: () => "",
      getAreaSelectionMode: () => "single",
      getDrawColor: () => "#ff2d2d",
      setDrawTool: noop,
      setSpectrumPickEnabled: noop,
      setAreaSelectionMode: noop,
      setDrawColor: noop,
      selectAreaAtPointer: () => false,
      isAreaMovePointer: () => false,
      beginAreaMoveAtPointer: () => false,
      updateAreaMoveAtPointer: noop,
      finishAreaMoveAtPointer: noop,
      cancelAreaMove: noop,
      resolvePointerCursor: () => "",
      isDrawingPointer: () => false,
      beginDrawingAtPointer: () => false,
      updateDrawingAtPointer: noop,
      finishDrawingAtPointer: noop,
      cancelDrawing: noop,
      eraseDrawingAtPointer: noop,
      clearAllAnnotations: noop,
      updateRulerHoverAtPointer: noop,
      clearRulerHover: noop,
      toggleAnalysisHistogramPanel: noop,
      getAnalysisHistogramOpen: () => false,
      setAnalysisHistogramOpen: noop,
      closeAnalysisHistogramPanel: noop,
      refreshAnalysisHistogram: async () => {},
      positionAnalysisHistogramPanel: noop,
      onAnalysisHistogramPointerMove: noop,
      onAnalysisHistogramPointerLeave: noop,
      openSpectrumForEffectiveArea: async () => {},
      updateZoomLabelBoot: noop,
      setGpuBadgeAvailable: noop
    });

    const files = [{ name: "demo.hdr" }, { name: "demo.dat" }];
    const ev = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: { files } });
    els.dropzone.dispatchEvent(ev);

    expect(addDatasetsFromFileList).toHaveBeenCalledTimes(1);
    expect(addDatasetsFromFileList).toHaveBeenCalledWith(files);
    windowAdd.mockRestore();
  });

  test("zoom slider delegates linked scaling when provided", () => {
    const addEventListener = vi.fn();
    const windowAdd = vi.spyOn(window, "addEventListener").mockImplementation(noop);
    const screenToImage = vi.fn(() => ({ x: 0, y: 0 }));
    const clampView = vi.fn();
    const render = vi.fn();
    const updateZoomLabel = vi.fn();
    const setScaleAt = vi.fn(() => 2.5);
    const ds = { view: { scale: 1, x: 0, y: 0 }, meta: { samples: 1000, lines: 500 } };
    const els = {
      main: { addEventListener, getBoundingClientRect: () => ({ left: 0, top: 0 }) },
      specPanel: null,
      btnSpecClose: null,
      btnSpecCSV: null,
      thumb: { addEventListener, width: 100, height: 100 },
      btnFit: makeButton(),
      btn100: makeButton(),
      btnZoomIn: makeButton(),
      btnZoomOut: makeButton(),
      zoom: { oninput: null, value: "50" },
      chkGrid: { oninput: null },
      chkScale: { oninput: null },
      btnSelect: makeButton(),
      btnExport: makeButton(),
      expFormatPng: { oninput: null, checked: false },
      expFormatTiff: { oninput: null, checked: true },
      expModeRaw: { oninput: null },
      expModeRendered: { oninput: null },
      expRawScopeSel: { oninput: null },
      expRawScopeWhole: { oninput: null },
      expRenScopeSel: { oninput: null },
      expRenScopeView: { oninput: null },
      expRenScopeWhole: { oninput: null },
      btnExpCancel: makeButton(),
      btnExpGo: makeButton(),
      exportDlg: { close: noop, open: false },
      bandSearch: { oninput: null, value: "" },
      btnExpandAll: makeButton(),
      btnCollapseAll: makeButton(),
      btnReset: makeButton(),
      btnAuto: makeButton(),
      slContrast: { oninput: null, value: "1" },
      slBrightness: { oninput: null, value: "0" },
      slGain: { oninput: null, value: "1" },
      numContrast: { onchange: null, value: "1" },
      numBrightness: { onchange: null, value: "0" },
      numGain: { onchange: null, value: "1" },
      numMin: { onchange: null, value: "0" },
      numMax: { onchange: null, value: "1" },
      chkHistView: { oninput: null, checked: false },
      hist: { addEventListener, setPointerCapture: noop, releasePointerCapture: noop },
      dropzone: { addEventListener, classList: { add: noop, remove: noop } },
      filePicker: { onchange: null, click: noop, value: "" },
      cpuCanvas: { width: 100, height: 80 },
      gpuBadge: { textContent: "" }
    };

    wireApp({
      state: { datasets: [], histDrag: { active: false, handle: null }, selection: { enabled: false }, ioParallel: true },
      els,
      clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
      getActive: () => ds,
      getActiveViewportDevice: () => ({ x: 10, y: 20, width: 100, height: 80 }),
      closeSpectrum: noop,
      exportSpectrumCSV: noop,
      screenToImage,
      openSpectrumAt: noop,
      onPointerDown: noop,
      onPointerMove: noop,
      onPointerUp: noop,
      onPointerCancel: noop,
      onPointerLeave: noop,
      onWheel: noop,
      onThumbClick: noop,
      fitToScreen: noop,
      clampView,
      scaleToSlider: (s) => s * 10,
      updateZoomLabel,
      render,
      zoomAt: noop,
      setScaleAt,
      sliderToScale: () => 1.5,
      minScaleFor: () => 1,
      setIOParallel: noop,
      clearSelection: noop,
      setStatus: noop,
      openExportDialog: noop,
      updateExportDialogUI: noop,
      updateExportEstimate: noop,
      runExportFromDialog: async () => {},
      rebuildBandTree: noop,
      resetDisplay: noop,
      autoDisplay: noop,
      resolveDisplayControlBand: () => 0,
      cycleDisplayAdjustColor: noop,
      getBandSettings: () => ({ brightness: 0, gain: 1, contrast: 1 }),
      drawHistogram: noop,
      applyRangeFromNumbers: noop,
      histPickHandle: () => null,
      applyHistogramDrag: noop,
      addDatasetsFromFileList: async () => {},
      resizeCanvases: noop,
      redrawSpectrum: noop,
      disposePyramid: noop,
      updateMetaUI: noop,
      updatePerf: noop,
      getDrawTool: () => "none",
      getDrawShapeMode: () => "rect",
      getSpectrumPickEnabled: () => false,
      getEffectiveAreaSelectionCount: () => 0,
      getEffectiveAreaSelectionKey: () => "",
      getAreaSelectionMode: () => "single",
      getDrawColor: () => "#ff2d2d",
      setDrawTool: noop,
      setDrawShapeMode: noop,
      setSpectrumPickEnabled: noop,
      setAreaSelectionMode: noop,
      setDrawColor: noop,
      selectAreaAtPointer: () => false,
      isAreaMovePointer: () => false,
      beginAreaMoveAtPointer: () => false,
      updateAreaMoveAtPointer: noop,
      finishAreaMoveAtPointer: noop,
      cancelAreaMove: noop,
      resolvePointerCursor: () => "",
      isDrawingPointer: () => false,
      beginDrawingAtPointer: () => false,
      updateDrawingAtPointer: noop,
      finishDrawingAtPointer: noop,
      cancelDrawing: noop,
      eraseDrawingAtPointer: noop,
      clearAllAnnotations: noop,
      updateRulerHoverAtPointer: noop,
      clearRulerHover: noop,
      toggleAnalysisHistogramPanel: noop,
      getAnalysisHistogramOpen: () => false,
      setAnalysisHistogramOpen: noop,
      closeAnalysisHistogramPanel: noop,
      refreshAnalysisHistogram: async () => {},
      positionAnalysisHistogramPanel: noop,
      onAnalysisHistogramPointerMove: noop,
      onAnalysisHistogramPointerLeave: noop,
      openSpectrumForEffectiveArea: async () => {},
      updateZoomLabelBoot: noop,
      setGpuBadgeAvailable: noop
    });

    els.zoom.oninput();

    expect(setScaleAt).toHaveBeenCalledWith(1.5, 60, 60);
    expect(screenToImage).not.toHaveBeenCalled();
    expect(clampView).not.toHaveBeenCalled();
    expect(els.zoom.value).toBe("25");
    expect(updateZoomLabel).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(1);
    windowAdd.mockRestore();
  });
});
