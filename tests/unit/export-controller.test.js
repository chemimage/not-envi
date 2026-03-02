import { describe, expect, test, vi } from "vitest";
import { createExportDialogController } from "../../src/export/export-controller.js";

function makeEls() {
  return {
    expTitle: { textContent: "" },
    expInfo: { textContent: "" },
    expFormatPng: { checked: false },
    expFormatTiff: { checked: true },
    expModeRaw: { disabled: false, checked: false },
    expModeRendered: { checked: false },
    expLblRawSel: { textContent: "" },
    expLblRenSel: { textContent: "" },
    expRenScopeSel: { disabled: false, checked: false },
    expRenScopeView: { checked: false },
    expRenScopeWhole: { checked: false },
    expRawScopeWhole: { checked: false },
    expRawScopeSel: { checked: true },
    expRawOptions: { style: { display: "" } },
    expRenderedOptions: { style: { display: "" } },
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

  test("png mode forces rendered and computes estimate", () => {
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
    expect(els.expModeRaw.disabled).toBe(false);
    expect(els.expEstimate.textContent).toContain("8000 B");

    els.expFormatPng.checked = true;
    els.expFormatTiff.checked = false;
    ctrl.updateExportDialogUI();
    expect(state.exportKind).toBe("png");
    expect(els.expModeRaw.disabled).toBe(true);
    expect(els.expModeRendered.checked).toBe(true);
    expect(els.expEstimate.textContent).toContain("800 B");
  });
});
