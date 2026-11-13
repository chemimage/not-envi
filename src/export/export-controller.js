import { isThreeBandColorMode } from "../app/three-band-display.js";
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
    if (els.expFormatPng.checked) return "png";
    if (els.expFormatEnvi?.checked) return "envi";
    return "tiff";
  }

  function selectedMode(kind = selectedKind()) {
    if (kind === "png") return "rendered";
    if (kind === "envi") return "raw";
    return els.expModeRaw.checked ? "raw" : "rendered";
  }

  function selectedScope() {
    return els.expScopeSel.checked ? "sel" : "view";
  }

  function selectedBandCount(ds, kind = selectedKind()) {
    if (!ds) return 0;
    if (isThreeBandColorMode(ds) && els.expBandComposite?.checked) return selectedMode(kind) === "raw" ? 3 : 1;
    if (kind === "png") return 1;
    return els.expBandAll?.checked ? Math.max(1, Number(ds.meta?.bands) || 1) : 1;
  }

  function includeAnnotations(kind = selectedKind(), mode = selectedMode(kind)) {
    return mode === "rendered" && !!els.expIncludeAnnotations?.checked;
  }

  function hasExportColorRange() {
    if (!els.expColorBarMin?.value && !els.expColorBarMax?.value) return false;
    const minVal = Number(els.expColorBarMin?.value || els.expColorBarMin?.placeholder);
    const maxVal = Number(els.expColorBarMax?.value || els.expColorBarMax?.placeholder);
    return Number.isFinite(minVal) && Number.isFinite(maxVal) && minVal !== maxVal;
  }

  function isEightBitDataset(ds) {
    return Number(ds?.meta?.dataTypeInfo?.bytes) === 1;
  }

  function shouldOfferScaled8(ds, kind = selectedKind()) {
    return kind === "tiff" && selectedMode(kind) === "raw" && !!ds && !isEightBitDataset(ds);
  }

  function useScaled8(ds, kind = selectedKind(), mode = selectedMode(kind)) {
    return kind === "tiff" && mode === "raw" && shouldOfferScaled8(ds, kind) && !!els.expScaled8?.checked;
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

  function resolveSelectionPlan(ds, selections) {
    if (!ds || !Array.isArray(selections) || !selections.length) return { jobs: [], hasNonRect: false };
    if (deps.resolveSelectionExportPlan) {
      return deps.resolveSelectionExportPlan(ds, selections, false);
    }
    const rect = resolveExportRect(ds, "sel");
    return { jobs: [{ w: rect.w, h: rect.h }], hasNonRect: false };
  }

  function ensureSelectionScope(hasSelection) {
    if (!els.expScopeSel) return;
    els.expScopeSel.disabled = !hasSelection;
    if (!hasSelection && els.expScopeSel.checked) {
      els.expScopeView.checked = true;
    } else if (hasSelection && !els.expScopeSel.checked && !els.expScopeView.checked) {
      els.expScopeSel.checked = true;
    }
  }

  function describeSelectionLabel(selectionCount) {
    if (selectionCount <= 0) return "Selection (none)";
    if (selectionCount === 1) return "Selection";
    return `Selection (${selectionCount} regions)`;
  }

  function openExportDialog() {
    if (state.exportRunning) return;
    const ds = getActive();
    if (!ds || ds.activeBand == null) {
      alertFn("Please select a dataset and band first.");
      return;
    }
    if (!els.expFormatPng.checked && !els.expFormatTiff.checked && !(els.expFormatEnvi && els.expFormatEnvi.checked)) {
      els.expFormatTiff.checked = true;
    }

    const kind = selectedKind();
    const selections = getAreaSelections(ds);
    const selectionCount = selections.length;
    const hasSelection = selectionCount > 0;

    if (selectionCount > 1) els.expTitle.textContent = "Export Selection";
    else if (selectionCount === 1) els.expTitle.textContent = "Export Selection";
    else els.expTitle.textContent = "Export";

    const range = deps.resolveDisplayRange?.(ds, ds.activeBand, null);
    for (const [input, value] of [[els.expColorBarMin, range?.minVal], [els.expColorBarMax, range?.maxVal]]) {
      if (input) {
        input.value = "";
        input.placeholder = Number.isFinite(value) ? String(value) : "auto";
      }
    }
    const band = ds.activeBand;
    els.expInfo.textContent = `${ds.name} • ${bandLabel(ds, band)} (band ${band})`;
    if (els.expLblScopeSel) {
      els.expLblScopeSel.textContent = describeSelectionLabel(selectionCount);
    }
    ensureSelectionScope(hasSelection);
    if (hasSelection) els.expScopeSel.checked = true;
    else els.expScopeView.checked = true;

    if (kind === "png") {
      els.expModeRendered.checked = true;
      els.expModeRaw.checked = false;
      if (els.expScaled8) els.expScaled8.checked = false;
      if (!isThreeBandColorMode(ds) && els.expBandCurrent) els.expBandCurrent.checked = true;
      if (els.expBandAll?.checked && !els.expBandComposite?.checked && els.expBandCurrent) els.expBandCurrent.checked = true;
      if (els.expBandAll) els.expBandAll.checked = false;
    } else if (kind === "envi") {
      els.expModeRaw.checked = true;
      els.expModeRendered.checked = false;
      if (els.expScaled8) els.expScaled8.checked = false;
    } else if (!els.expModeRaw.checked && !els.expModeRendered.checked) {
      els.expModeRaw.checked = true;
    }

    if (els.expIncludeAnnotations) {
      els.expIncludeAnnotations.checked = true;
    }

    if (els.expBandCurrent && !els.expBandCurrent.checked && !els.expBandAll?.checked) {
      els.expBandCurrent.checked = true;
    }

    if (els.expBandComposite) {
      els.expBandComposite.checked = isThreeBandColorMode(ds);
      if (isThreeBandColorMode(ds)) {
        els.expBandCurrent.checked = false;
        els.expBandAll.checked = false;
      }
    }
    updateExportDialogUI();
    try { els.exportDlg.showModal(); } catch { els.exportDlg.open = true; }
  }

  function updateExportDialogUI() {
    const ds = getActive();
    const kind = selectedKind();
    state.exportKind = kind;
    const color = isThreeBandColorMode(ds);
    if (els.expBandAll) els.expBandAll.disabled = kind === "png";
    if (els.expBandCompositeWrap) els.expBandCompositeWrap.style.display = color ? "flex" : "none";
    if (!color && els.expBandComposite?.checked) {
      els.expBandComposite.checked = false;
      if (els.expBandCurrent) els.expBandCurrent.checked = true;
    }
    const offerScaled8 = shouldOfferScaled8(ds, kind);
    if (els.expScaled8Wrap) {
      els.expScaled8Wrap.style.display = offerScaled8 ? "block" : "none";
    }
    if (!offerScaled8 && els.expScaled8?.checked) {
      els.expScaled8.checked = false;
    }

    if (kind === "png") {
      els.expModeRendered.checked = true;
      els.expModeRaw.checked = false;
      if (els.expScaled8) els.expScaled8.checked = false;
      els.expModeWrap.style.display = "none";
      els.expFormatHint.textContent = "PNG can only export rendered result.";
      if (els.expBandWrap) els.expBandWrap.style.display = color ? "block" : "none";
      if (!isThreeBandColorMode(ds) && els.expBandCurrent) els.expBandCurrent.checked = true;
      if (els.expBandAll?.checked && !els.expBandComposite?.checked && els.expBandCurrent) els.expBandCurrent.checked = true;
      if (els.expBandAll) els.expBandAll.checked = false;
    } else if (kind === "envi") {
      els.expModeRaw.checked = true;
      els.expModeRendered.checked = false;
      if (els.expScaled8) els.expScaled8.checked = false;
      els.expModeWrap.style.display = "none";
      els.expFormatHint.textContent = "ENVI exports raw numeric samples only.";
      if (els.expBandWrap) els.expBandWrap.style.display = "block";
    } else {
      els.expModeWrap.style.display = "block";
      els.expFormatHint.textContent = offerScaled8
        ? "TIFF raw export can optionally scale numeric samples to 8-bit data."
        : "TIFF can export raw numeric samples or rendered views.";
      if (els.expBandWrap) els.expBandWrap.style.display = "block";
    }

    const mode = selectedMode(kind);
    if (els.expIncludeAnnotationsWrap) {
      els.expIncludeAnnotationsWrap.style.display = (mode === "rendered") ? "block" : "none";
    }
    if (els.expRenderedOverlaysWrap) {
      els.expRenderedOverlaysWrap.style.display = (mode === "rendered") ? "block" : "none";
    }

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
    const mode = selectedMode(kind);
    const selections = getAreaSelections(ds);
    const selectionCount = selections.length;
    const hasSelection = selectionCount > 0;
    const scope = selectedScope();
    const nonRect = hasNonRect(selections);
    const bandCount = selectedBandCount(ds, kind);
    const annotationsOn = includeAnnotations(kind, mode);
    const scaled8 = useScaled8(ds, kind, mode);

    if (els.expLblScopeSel) {
      els.expLblScopeSel.textContent = describeSelectionLabel(selectionCount);
    }
    ensureSelectionScope(hasSelection);
    if (els.expShapeWarn) {
      els.expShapeWarn.style.display = (scope === "sel" && hasSelection && nonRect) ? "block" : "none";
    }

    let estBytes = 0;
    let warnByPixels = false;
    let note = "—";

    if (scope === "sel" && hasSelection) {
      const plan = resolveSelectionPlan(ds, selections);
      if (mode === "raw") {
        const bpp = scaled8 ? 1 : (Number(ds.meta?.dataTypeInfo?.bytes) || 0);
        estBytes = plan.jobs.reduce((sum, job) => sum + (job.w * job.h * bandCount * bpp), 0);
        warnByPixels = plan.jobs.some((job) => (job.w * job.h > 20_000_000));
        if (scaled8) {
          note = bandCount > 1
            ? `Scaled 8-bit TIFF stack from selection: <b>${plan.jobs[0]?.w || 0}×${plan.jobs[0]?.h || 0}</b> × <b>${bandCount}</b> bands.`
            : `Scaled 8-bit TIFF export from selection: <b>${plan.jobs[0]?.w || 0}×${plan.jobs[0]?.h || 0}</b> for the current band.`;
        } else if (kind === "envi") {
          note = bandCount > 1
            ? `Raw ENVI stack from selection: <b>${plan.jobs[0]?.w || 0}×${plan.jobs[0]?.h || 0}</b> × <b>${bandCount}</b> bands as <code>.hdr</code> + <code>.dat</code>.`
            : `Raw ENVI export from selection: <b>${plan.jobs[0]?.w || 0}×${plan.jobs[0]?.h || 0}</b> for the current band as <code>.hdr</code> + <code>.dat</code>.`;
        } else {
          note = bandCount > 1
            ? `Raw TIFF stack from selection: <b>${plan.jobs[0]?.w || 0}×${plan.jobs[0]?.h || 0}</b> × <b>${bandCount}</b> bands (${ds.meta.dataTypeInfo.name}).`
            : `Raw TIFF export from selection: <b>${plan.jobs[0]?.w || 0}×${plan.jobs[0]?.h || 0}</b> for the current band (${ds.meta.dataTypeInfo.name}).`;
        }
      } else {
        estBytes = plan.jobs.reduce((sum, job) => sum + (job.w * job.h * 4 * bandCount), 0);
        warnByPixels = plan.jobs.some((job) => (job.w * job.h > 20_000_000));
        if (kind === "png") {
          note = `Rendered PNG from selection: <b>${plan.jobs[0]?.w || 0}×${plan.jobs[0]?.h || 0}</b> from the current band.`;
        } else if (bandCount > 1) {
          note = `Rendered TIFF stack from selection: <b>${plan.jobs[0]?.w || 0}×${plan.jobs[0]?.h || 0}</b> × <b>${bandCount}</b> bands.`;
        } else {
          note = `Rendered TIFF from selection: <b>${plan.jobs[0]?.w || 0}×${plan.jobs[0]?.h || 0}</b> from the current band.`;
        }
      }
    } else {
      const rect = resolveExportRect(ds, "view");
      if (mode === "raw") {
        const bpp = scaled8 ? 1 : (Number(ds.meta?.dataTypeInfo?.bytes) || 0);
        estBytes = rect.w * rect.h * bandCount * bpp;
        warnByPixels = (rect.w * rect.h > 20_000_000);
        if (scaled8) {
          note = bandCount > 1
            ? `Scaled 8-bit TIFF stack from the whole view: <b>${rect.w}×${rect.h}</b> × <b>${bandCount}</b> bands.`
            : `Scaled 8-bit TIFF export from the whole view: <b>${rect.w}×${rect.h}</b> for the current band.`;
        } else if (kind === "envi") {
          note = bandCount > 1
            ? `Raw ENVI stack from the whole view: <b>${rect.w}×${rect.h}</b> × <b>${bandCount}</b> bands as <code>.hdr</code> + <code>.dat</code>.`
            : `Raw ENVI export from the whole view: <b>${rect.w}×${rect.h}</b> for the current band as <code>.hdr</code> + <code>.dat</code>.`;
        } else {
          note = bandCount > 1
            ? `Raw TIFF stack from the whole view: <b>${rect.w}×${rect.h}</b> × <b>${bandCount}</b> bands (${ds.meta.dataTypeInfo.name}).`
            : `Raw TIFF export from the whole view: <b>${rect.w}×${rect.h}</b> for the current band (${ds.meta.dataTypeInfo.name}).`;
        }
      } else {
        const target = (typeof resolveRenderedExportTarget === "function")
          ? resolveRenderedExportTarget(ds, "view")
          : { outputW: rect.w, outputH: rect.h, mode: "window" };
        estBytes = target.outputW * target.outputH * 4 * bandCount;
        warnByPixels = ((target.outputW * target.outputH) > 20_000_000);
        if (kind === "png") {
          note = `Rendered PNG from the whole view: <b>${target.outputW}×${target.outputH}</b> from the current band.`;
        } else if (bandCount > 1) {
          note = `Rendered TIFF stack from the whole view: <b>${target.outputW}×${target.outputH}</b> × <b>${bandCount}</b> bands.`;
        } else {
          note = `Rendered TIFF from the whole view: <b>${target.outputW}×${target.outputH}</b> from the current band.`;
        }
      }
    }

    if (isThreeBandColorMode(ds) && els.expBandComposite?.checked) {
      note = note.replace(/from the current band|for the current band/g, "as the displayed color composite");
      if (kind === "tiff") note = note.replace(/TIFF stack/g, "RGB TIFF").replace(/ \u00d7 <b>3<\/b> bands/g, " with three color channels");
      note += ` ${String(ds.displayMode).toUpperCase()} channel order; ${mode === "raw" ? "original samples preserved" : "channel display settings applied"}.`;
    }
    if (mode === "rendered") {
      note += annotationsOn ? " Includes annotations." : " Annotations will be omitted.";
      if (els.expScaleBar?.checked) note += " Includes scale bar.";
      if (els.expColorBar?.checked) note += " Includes color bar.";
      if ((els.expScaleBar?.checked && els.expScaleBarInside?.checked === false)
        || (els.expColorBar?.checked && els.expColorBarInside?.checked === false)) {
        note += " Outside bars add margins to the estimated image size.";
      }
      if (hasExportColorRange()) note += " Uses the export color range for tone mapping.";
    }

    els.expEstimate.textContent = `Estimated output: ${humanBytes(estBytes)}`;
    els.expNote.innerHTML = note;
    const warn = estBytes > (512 * 1024 * 1024) || warnByPixels;
    els.expWarning.style.display = warn ? "inline-flex" : "none";
  }

  return {
    openExportDialog,
    updateExportDialogUI,
    updateExportEstimate
  };
}
