export { createExportService } from "./export-service.js";

export function createExportDialogController(deps) {
  const {
    state,
    els,
    getActive,
    bandLabel,
    humanBytes,
    resolveExportRect,
    resolveRenderedExportTarget,
    alertFn
  } = deps;

  function selectedKind() {
    if (deps.els.expFormatPng.checked) return "png";
    if (deps.els.expFormatEnvi && deps.els.expFormatEnvi.checked) return "envi";
    return "tiff";
  }

  function getAreaSelections(ds) {
    if (!ds || !deps.collectAreaSelections) return [];
    return deps.collectAreaSelections(ds);
  }

  function hasNonRect(selections) {
    if (!Array.isArray(selections) || !selections.length) return false;
    if (deps.hasNonRectSelections) return deps.hasNonRectSelections(selections);
    return selections.some((s) => s && s.tool === "shape");
  }

  function useSeparateMulti(selections) {
    return !!(
      Array.isArray(selections)
      && selections.length > 1
      && deps.els.expSelModeSeparate
      && deps.els.expSelModeSeparate.checked
    );
  }

  function resolveSelectionPlan(ds, selections) {
    if (!ds || !Array.isArray(selections) || !selections.length) return { jobs: [], hasNonRect: false };
    if (deps.resolveSelectionExportPlan) {
      return deps.resolveSelectionExportPlan(ds, selections, useSeparateMulti(selections));
    }
    const rect = resolveExportRect(ds, "sel");
    return { jobs: [{ w: rect.w, h: rect.h }], hasNonRect: false };
  }

  function openExportDialog() {
    const ds = getActive();
    if (!ds || ds.activeBand == null) {
      alertFn("Please select a dataset and band first.");
      return;
    }
    if (!els.expFormatPng.checked && !els.expFormatTiff.checked && !(els.expFormatEnvi && els.expFormatEnvi.checked)) {
      els.expFormatTiff.checked = true;
    }
    state.exportKind = selectedKind();

    const selections = getAreaSelections(ds);
    const selectionCount = selections.length;
    const hasSel = selectionCount > 0;
    if (selectionCount > 1) els.expTitle.textContent = "Export Multiple Selections";
    else if (selectionCount === 1) els.expTitle.textContent = "Export Selection";
    else els.expTitle.textContent = "Export";

    const b = ds.activeBand;
    els.expInfo.textContent = `${ds.name} • ${bandLabel(ds, b)} (band ${b})`;
    if (state.exportKind === "png") {
      els.expModeRendered.checked = true;
    } else {
      els.expModeRaw.checked = true;
    }

    if (selectionCount > 1) {
      els.expLblRawSel.textContent = "Selected regions stack (all bands)";
      els.expLblRenSel.textContent = "Selected regions";
    } else {
      els.expLblRawSel.textContent = hasSel ? "Selected stack (all bands)" : "Current view stack (all bands)";
      els.expLblRenSel.textContent = hasSel ? "Selection" : "Selection (none)";
    }
    els.expRenScopeSel.disabled = !hasSel;
    if (hasSel) els.expRenScopeSel.checked = true;
    else els.expRenScopeView.checked = true;
    if (els.expSelModeWrap) {
      els.expSelModeWrap.style.display = (selectionCount > 1) ? "block" : "none";
    }
    if (els.expSelModeTogether && selectionCount <= 1) {
      els.expSelModeTogether.checked = true;
    }
    if (els.expShapeWarn) {
      els.expShapeWarn.style.display = hasNonRect(selections) ? "block" : "none";
    }

    updateExportDialogUI();
    try { els.exportDlg.showModal(); } catch { els.exportDlg.open = true; }
  }

  function updateExportDialogUI() {
    const kind = selectedKind();
    state.exportKind = kind;
    if (kind === "png" && els.expModeRaw.checked) {
      els.expModeRendered.checked = true;
    }
    els.expModeRaw.disabled = (kind === "png");
    const mode = (els.expModeRaw.checked && kind !== "png") ? "raw" : "rendered";
    els.expRawOptions.style.display = (mode === "raw") ? "block" : "none";
    els.expRenderedOptions.style.display = (mode === "rendered") ? "block" : "none";
    updateExportEstimate();
  }

  function updateExportEstimate() {
    const ds = getActive();
    if (!ds) {
      els.expEstimate.textContent = "Estimated output: —";
      els.expNote.textContent = "—";
      els.expWarning.style.display = "none";
      return;
    }

    const kind = selectedKind();
    state.exportKind = kind;
    const mode = (els.expModeRaw.checked && kind !== "png") ? "raw" : "rendered";
    const selections = getAreaSelections(ds);
    const selectionCount = selections.length;
    const hasSel = selectionCount > 0;
    const nonRect = hasNonRect(selections);
    if (els.expSelModeWrap) els.expSelModeWrap.style.display = (selectionCount > 1) ? "block" : "none";
    if (els.expShapeWarn) els.expShapeWarn.style.display = nonRect ? "block" : "none";

    let rect;
    let estBytes = 0;
    let warnByPixels = false;

    if (mode === "raw") {
      const scope = els.expRawScopeWhole.checked ? "whole" : "sel";
      if (scope === "sel" && hasSel) {
        const plan = resolveSelectionPlan(ds, selections);
        const bpp = ds.meta.dataTypeInfo.bytes;
        estBytes = plan.jobs.reduce((sum, job) => sum + (job.w * job.h * ds.meta.bands * bpp), 0);
        warnByPixels = plan.jobs.some((job) => (job.w * job.h > 20_000_000));
        const rawFormatLabel = (kind === "envi") ? "ENVI (.hdr + .dat)" : "TIFF";
        if (plan.jobs.length > 1) {
          els.expNote.innerHTML = `Raw stacks (${rawFormatLabel}): <b>${plan.jobs.length}</b> files, each with <b>${ds.meta.bands}</b> bands (${ds.meta.dataTypeInfo.name}).`;
        } else {
          const one = plan.jobs[0];
          els.expNote.innerHTML = `Raw stack (all bands): <b>${one.w}×${one.h}</b> × <b>${ds.meta.bands}</b> (${ds.meta.dataTypeInfo.name}), ${rawFormatLabel}.`;
        }
      } else {
        rect = resolveExportRect(ds, scope);
        const bpp = ds.meta.dataTypeInfo.bytes;
        estBytes = rect.w * rect.h * ds.meta.bands * bpp;
        warnByPixels = (rect.w * rect.h > 20_000_000);
        const rawFormatLabel = (kind === "envi") ? "ENVI (.hdr + .dat)" : "TIFF";
        els.expNote.innerHTML = `Raw stack (all bands): <b>${rect.w}×${rect.h}</b> × <b>${ds.meta.bands}</b> (${ds.meta.dataTypeInfo.name}), ${rawFormatLabel}.`;
      }
    } else {
      const scope = els.expRenScopeWhole.checked ? "whole" : (els.expRenScopeSel.checked ? "sel" : "view");
      if (scope === "sel" && hasSel) {
        const plan = resolveSelectionPlan(ds, selections);
        estBytes = plan.jobs.reduce((sum, job) => sum + (job.w * job.h * 4), 0);
        warnByPixels = plan.jobs.some((job) => (job.w * job.h > 20_000_000));
        if (plan.jobs.length > 1) {
          els.expNote.innerHTML = `Rendered export: <b>${plan.jobs.length}</b> files from selected regions on the current band.`;
        } else {
          const one = plan.jobs[0];
          els.expNote.innerHTML = `Rendered view: <b>${one.w}×${one.h}</b> pixels from the current band.`;
        }
      } else {
        const fallbackRect = resolveExportRect(ds, scope);
        const target = (typeof resolveRenderedExportTarget === "function")
          ? resolveRenderedExportTarget(ds, scope)
          : { rect: fallbackRect, outputW: fallbackRect.w, outputH: fallbackRect.h, mode: "window" };
        rect = target.rect;
        estBytes = target.outputW * target.outputH * 4;
        warnByPixels = ((target.outputW * target.outputH) > 20_000_000);
        els.expNote.innerHTML = target.mode === "viewport"
          ? `Rendered viewport: <b>${target.outputW}×${target.outputH}</b> pixels from the current browser view.`
          : `Rendered view: <b>${target.outputW}×${target.outputH}</b> pixels from the current band.`;
      }
      if (kind === "png") {
        els.expNote.innerHTML += ` <span class="badge">PNG is rendered only</span> (use TIFF for raw).`;
      }
    }

    els.expEstimate.textContent = `Estimated output: ${humanBytes(estBytes)}`;
    const warn = estBytes > (512 * 1024 * 1024) || warnByPixels;
    els.expWarning.style.display = warn ? "inline-flex" : "none";
  }

  return {
    openExportDialog,
    updateExportDialogUI,
    updateExportEstimate
  };
}
