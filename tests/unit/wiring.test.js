import { describe, expect, test, vi } from "vitest";
import { wireApp } from "../../src/app/wiring.js";

function noop() {}

function makeButton() {
  return { onclick: null, classList: { add: noop, remove: noop }, addEventListener: noop };
}

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
      btnExportPNG: makeButton(),
      btnExportTIFF: makeButton(),
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
});
