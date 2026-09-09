import { describe, expect, test, vi } from "vitest";
import { createExportDialogController } from "../../src/export/export-controller.js";

function makeEls() {
  return {
    expTitle: { textContent: "" },
    expInfo: { textContent: "" },
    expFormatHint: { textContent: "" },
    expFormatPng: { checked: false },
    expFormatTiff: { checked: true },
    expFormatEnvi: { checked: false },
    expModeWrap: { style: { display: "" } },
    expModeRaw: { checked: false },
    expModeRendered: { checked: false },
    expScaled8Wrap: { style: { display: "" } },
    expScaled8: { checked: false },
    expScopeSel: { disabled: false, checked: false },
    expScopeView: { checked: false },
    expLblScopeSel: { textContent: "" },
    expBandWrap: { style: { display: "" } },
    expBandCurrent: { checked: true },
    expBandAll: { checked: false },
    expIncludeAnnotationsWrap: { style: { display: "" } },
    expIncludeAnnotations: { checked: true },
    expShapeWarn: { style: { display: "" } },
    expEstimate: { textContent: "" },
    expNote: { textContent: "", innerHTML: "" },
    expWarning: { style: { display: "" } },
    exportDlg: { showModal: vi.fn() }
  };
}

describe("export dialog controller", () => {
  test("alerts when no active dataset", () => {
    const alertFn = vi.fn();
    const ctrl = createExportDialogController({
      state: { selection: { imgRect: null }, exportKind: null },
      els: makeEls(),
      getActive: () => null,
      bandLabel: () => "",
      humanBytes: () => "",
      resolveExportRect: () => ({ w: 1, h: 1 }),
      alertFn
    });
    ctrl.openExportDialog();
    expect(alertFn).toHaveBeenCalledTimes(1);
  });

  test("switches TIFF, scaled 8-bit, PNG, and ENVI modes with matching controls and estimates", () => {
    const state = { selection: { imgRect: null }, exportKind: null };
    const els = makeEls();
    const ds = {
      name: "a",
      activeBand: 3,
      meta: { bands: 10, dataTypeInfo: { bytes: 4, name: "float32" } }
    };
    const ctrl = createExportDialogController({
      state,
      els,
      getActive: () => ds,
      bandLabel: () => "b3",
      humanBytes: (n) => `${n} B`,
      resolveExportRect: () => ({ w: 20, h: 10 }),
      alertFn: () => {}
    });

    ctrl.openExportDialog();
    expect(state.exportKind).toBe("tiff");
    expect(els.expModeWrap.style.display).toBe("block");
    expect(els.expScaled8Wrap.style.display).toBe("block");
    expect(els.expEstimate.textContent).toContain("800 B");

    els.expScaled8.checked = true;
    ctrl.updateExportDialogUI();
    expect(els.expIncludeAnnotationsWrap.style.display).toBe("none");
    expect(els.expEstimate.textContent).toContain("200 B");
    expect(els.expNote.innerHTML).toContain("Scaled 8-bit TIFF export");

    els.expModeRaw.checked = false;
    els.expModeRendered.checked = true;
    ctrl.updateExportDialogUI();
    expect(els.expScaled8Wrap.style.display).toBe("none");
    expect(els.expScaled8.checked).toBe(false);
    expect(els.expIncludeAnnotationsWrap.style.display).toBe("block");

    els.expFormatPng.checked = true;
    els.expFormatTiff.checked = false;
    ctrl.updateExportDialogUI();
    expect(state.exportKind).toBe("png");
    expect(els.expModeWrap.style.display).toBe("none");
    expect(els.expModeRendered.checked).toBe(true);
    expect(els.expScaled8.checked).toBe(false);
    expect(els.expFormatHint.textContent).toContain("PNG can only export rendered result");
    expect(els.expEstimate.textContent).toContain("800 B");

    els.expFormatPng.checked = false;
    els.expFormatTiff.checked = false;
    els.expFormatEnvi.checked = true;
    ctrl.updateExportDialogUI();
    expect(state.exportKind).toBe("envi");
    expect(els.expModeRaw.checked).toBe(true);
    expect(els.expModeWrap.style.display).toBe("none");
    expect(els.expIncludeAnnotationsWrap.style.display).toBe("none");
  });

  test("scaled 8-bit mode is hidden for 8-bit TIFF datasets", () => {
    const els = makeEls();
    els.expModeRaw.checked = true;
    els.expScaled8.checked = true;
    const ds = {
      name: "byte",
      activeBand: 0,
      meta: { bands: 1, dataTypeInfo: { bytes: 1, name: "uint8" } }
    };
    const ctrl = createExportDialogController({
      state: { selection: { imgRect: null }, exportKind: null },
      els,
      getActive: () => ds,
      bandLabel: () => "b0",
      humanBytes: (n) => `${n} B`,
      resolveExportRect: () => ({ w: 5, h: 4 }),
      alertFn: () => {}
    });

    ctrl.updateExportDialogUI();
    expect(els.expScaled8Wrap.style.display).toBe("none");
    expect(els.expScaled8.checked).toBe(false);
    expect(els.expModeRaw.checked).toBe(true);
    expect(els.expEstimate.textContent).toContain("20 B");
  });
});
