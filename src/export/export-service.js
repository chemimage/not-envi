import { encodeRawMultipageTiff, encodeRenderedTiff } from "./tiff-backend.js";

export function createExportService(deps) {
  function sanitizeFilePart(s) {
    return String(s || "").replace(/[\\/:*?"<>|]+/g, "_").trim() || "band";
  }

  function viewRect(ds) {
    const dpr = window.devicePixelRatio || 1;
    const eff = ds.view.scale * dpr;
    const viewW = deps.els.cpuCanvas.width / eff;
    const viewH = deps.els.cpuCanvas.height / eff;
    return clampRect(ds, {
      x0: Math.floor(ds.view.x),
      y0: Math.floor(ds.view.y),
      x1: Math.ceil(ds.view.x + viewW),
      y1: Math.ceil(ds.view.y + viewH)
    });
  }

  function wholeRect(ds) {
    return { x0: 0, y0: 0, x1: ds.meta.samples, y1: ds.meta.lines, w: ds.meta.samples, h: ds.meta.lines };
  }

  function clampRect(ds, rect) {
    const x0 = deps.clamp(rect.x0, 0, ds.meta.samples);
    const y0 = deps.clamp(rect.y0, 0, ds.meta.lines);
    const x1 = deps.clamp(rect.x1, 0, ds.meta.samples);
    const y1 = deps.clamp(rect.y1, 0, ds.meta.lines);
    const w = Math.max(1, x1 - x0);
    const h = Math.max(1, y1 - y0);
    return { x0, y0, x1, y1, w, h };
  }

  function resolveExportRect(ds, scope) {
    if (scope === "whole") return wholeRect(ds);
    if (scope === "view") return viewRect(ds);

    if (scope === "sel") {
      const r = deps.state.selection.imgRect;
      if (r) {
        const x0 = Number.isFinite(r.x0) ? r.x0 : 0;
        const y0 = Number.isFinite(r.y0) ? r.y0 : 0;
        const x1 = Number.isFinite(r.x1) ? r.x1 : (x0 + (Number.isFinite(r.w) ? r.w : 1));
        const y1 = Number.isFinite(r.y1) ? r.y1 : (y0 + (Number.isFinite(r.h) ? r.h : 1));
        return clampRect(ds, { x0, y0, x1, y1 });
      }
      return viewRect(ds);
    }
    return viewRect(ds);
  }

  async function exportRendered(ds, kind, rect) {
    const band = ds.activeBand;
    if (band == null) return;
    const w = rect.w;
    const h = rect.h;
    const maxPix = 20_000_000;
    if (w * h > maxPix) {
      deps.alertFn(`Export too large (${deps.fmt(w * h)} pixels). Please select a smaller region.`);
      return;
    }

    deps.setStatus("export…", "warn");
    const img = await deps.renderWindowToImageData(ds, band, rect.x0, rect.y0, w, h, 1);
    const base = `${ds.name}_${sanitizeFilePart(deps.bandLabel(ds, band))}_${rect.x0}_${rect.y0}_${w}x${h}`;

    if (kind === "png") {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d", { alpha: false }).putImageData(img, 0, 0);
      const blob = await new Promise((res) => c.toBlob(res, "image/png"));
      deps.downloadBlob(blob, `${base}.png`);
      deps.setStatus("ready", "ok");
      return;
    }

    if (kind === "tiff") {
      const blob = encodeRenderedTiff({ imageData: img });
      deps.downloadBlob(blob, `${base}.tiff`);
      deps.setStatus("ready", "ok");
    }
  }

  async function exportRawStackTIFF(ds, rect) {
    const w = rect.w;
    const h = rect.h;
    const bpp = ds.meta.dataTypeInfo.bytes;
    const totalBytes = w * h * ds.meta.bands * bpp;

    if (totalBytes > (1024 * 1024 * 1024)) {
      const ok = deps.confirmFn(`This raw stack is about ${deps.humanBytes(totalBytes)} and may crash the browser. Continue?`);
      if (!ok) return;
    }

    deps.setStatus("export raw…", "warn");
    const pages = [];
    for (let b = 0; b < ds.meta.bands; b += 1) {
      deps.setStatus(`export raw… ${b + 1}/${ds.meta.bands}`, "warn");
      let data;
      if (ds.meta.interleave === "bip") {
        data = await deps.readBandWindowBIP(ds.meta, ds.ds, b, rect.x0, rect.y0, w, h, 1);
      } else {
        data = await deps.readBandWindow(ds.meta, ds.ds, b, rect.x0, rect.y0, w, h, 1);
      }
      pages.push(data);
    }

    const blob = encodeRawMultipageTiff({ meta: ds.meta, width: w, height: h, pages });
    const base = `${ds.name}_${rect.x0}_${rect.y0}_${w}x${h}_rawstack`;
    deps.downloadBlob(blob, `${base}.tiff`);
    deps.setStatus("ready", "ok");
  }

  async function runExportFromDialog() {
    const ds = deps.getActive();
    if (!ds || ds.activeBand == null) return;
    const kind = deps.els.expFormatPng.checked ? "png" : "tiff";
    deps.state.exportKind = kind;

    try {
      deps.els.exportDlg.close();
    } catch {}

    const rawMode = deps.els.expModeRaw.checked && kind === "tiff";
    if (rawMode) {
      const scope = deps.els.expRawScopeWhole.checked ? "whole" : "sel";
      const rect = resolveExportRect(ds, scope);
      await exportRawStackTIFF(ds, rect);
      return;
    }

    const scope = deps.els.expRenScopeWhole.checked ? "whole" : (deps.els.expRenScopeSel.checked ? "sel" : "view");
    const rect = resolveExportRect(ds, scope);
    await exportRendered(ds, kind, rect);
  }

  return {
    sanitizeFilePart,
    viewRect,
    wholeRect,
    clampRect,
    resolveExportRect,
    exportRendered,
    exportRawStackTIFF,
    runExportFromDialog
  };
}
