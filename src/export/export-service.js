import { layoutExportBars } from "./export-bar-layout.js";
import { encodeExportJob } from "./encode-job.js";
import { createExportProgress, yieldExportUi } from "./export-progress.js";
import { isThreeBandColorMode, resolveThreeBandChannelOrder } from "../app/three-band-display.js";
import { buildEnviHeaderText } from "./envi-backend.js";
import { createOverlayRenderer } from "../render/overlay.js";
import { resolveRasterSampling } from "../render/raster-geometry.js";

export function createExportService(deps) {
  let activeJob = null;
  const progress = deps.exportProgress || createExportProgress();
  async function stage(label, completed, total) {
    if (!activeJob) return;
    progress.update({ stage: activeJob.region ? `${activeJob.region}: ${label}` : label, completed, total });
    await yieldExportUi();
  }
  async function encode(kind, args) {
    await stage("Encoding…");
    const meta = args.meta ? { ...args.meta, dataTypeInfo: { ...args.meta.dataTypeInfo, ctor: undefined } } : undefined;
    const result = await (deps.encodeExport || encodeExportJob)({ kind, ...args, meta });
    await stage("Preparing downloads…");
    return result;
  }
  async function encodePng(canvas) {
    await stage("Encoding PNG…");
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("PNG encoder returned no image.");
    await stage("Preparing downloads…");
    return blob;
  }
  async function renderExportWindow(ds, band, x0, y0, w, h, step, opts = {}) {
    // Chunk tone mapping so cached reads still leave time for UI paints.
    const rows = Math.max(1, Math.floor(262144 / w));
    const renderOptions = band === null
      ? { ...opts, channelDisplayRanges: Object.fromEntries(resolveThreeBandChannelOrder(ds).map((b) => [b, opts.displayRange || resolveScaled8Range(ds, b)])) }
      : { ...opts, displayRange: opts.displayRange || resolveScaled8Range(ds, band) };
    const output = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    for (let y = 0; y < h; y += rows) {
      const count = Math.min(rows, h - y);
      await stage("Rendering rows…", y, h);
      const part = band === null
        ? await deps.renderCompositeWindowToImageData(ds, x0, y0 + y * step, w, count, step, null, renderOptions)
        : await deps.renderWindowToImageData(ds, band, x0, y0 + y * step, w, count, step, renderOptions);
      output.data.set(part.data, y * w * 4);
    }
    await stage("Rendered rows", h, h);
    return typeof ImageData === "function" ? new ImageData(output.data, w, h) : output;
  }
  const RAW_ENVI_INTERLEAVE = "bsq";
  const RAW_ENVI_LITTLE_ENDIAN = true;

  function pointInPolygon(x, y, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
      const pi = points[i];
      const pj = points[j];
      const intersects = ((pi.y > y) !== (pj.y > y))
        && (x < (((pj.x - pi.x) * (y - pi.y)) / Math.max(1e-12, (pj.y - pi.y)) + pi.x));
      if (intersects) inside = !inside;
    }
    return inside;
  }

  function sanitizeFilePart(s) {
    return String(s || "").replace(/[\\/:*?"<>|]+/g, "_").trim() || "band";
  }

  function selectedKindFromDialog() {
    if (deps.els.expFormatPng?.checked) return "png";
    if (deps.els.expFormatEnvi?.checked) return "envi";
    return "tiff";
  }

  function selectedModeFromDialog(kind = selectedKindFromDialog()) {
    if (kind === "png") return "rendered";
    if (kind === "envi") return "raw";
    return deps.els.expModeRaw?.checked ? "raw" : "rendered";
  }

  function useScaled8FromDialog(ds, kind = selectedKindFromDialog(), mode = selectedModeFromDialog(kind)) {
    return kind === "tiff"
      && mode === "raw"
      && Number(ds?.meta?.dataTypeInfo?.bytes) !== 1
      && !!deps.els.expScaled8?.checked;
  }

  function selectedScopeFromDialog() {
    return deps.els.expScopeSel?.checked ? "sel" : "view";
  }

  function selectedBandIndices(ds, kind = selectedKindFromDialog()) {
    if (!ds || ds.activeBand == null) return [];
    if (isThreeBandColorMode(ds) && deps.els.expBandComposite?.checked) {
      return selectedModeFromDialog(kind) === "rendered" ? [null] : resolveThreeBandChannelOrder(ds);
    }
    if (kind === "png") return [ds.activeBand];
    if (deps.els.expBandAll?.checked) {
      return Array.from({ length: Math.max(1, Number(ds.meta?.bands) || 1) }, (_v, i) => i);
    }
    return [ds.activeBand];
  }

  function includeAnnotationsFromDialog(kind = selectedKindFromDialog(), mode = selectedModeFromDialog(kind)) {
    return mode === "rendered" && !!deps.els.expIncludeAnnotations?.checked;
  }

  function finiteNumberFromInput(input) {
    if (input?.value == null || String(input.value).trim() === "") return null;
    const value = Number(input.value);
    return Number.isFinite(value) ? value : null;
  }

  function normalizeExportBarCorner(value) {
    const corner = String(value || "").toLowerCase();
    return ["top-left", "top-right", "bottom-left", "bottom-right"].includes(corner)
      ? corner
      : "bottom-right";
  }

  function renderedExportOptionsFromDialog(kind = selectedKindFromDialog(), mode = selectedModeFromDialog(kind)) {
    if (mode !== "rendered") return {};
    const minInput = deps.els.expColorBarMin;
    const maxInput = deps.els.expColorBarMax;
    const minVal = finiteNumberFromInput(minInput) ?? finiteNumberFromInput({ value: minInput?.placeholder });
    const maxVal = finiteNumberFromInput(maxInput) ?? finiteNumberFromInput({ value: maxInput?.placeholder });
    const hasRange = !!(minInput?.value || maxInput?.value) && minVal != null && maxVal != null && minVal !== maxVal;
    const range = hasRange
      ? { minVal: Math.min(minVal, maxVal), maxVal: Math.max(minVal, maxVal) }
      : null;
    return {
      includeAnnotations: includeAnnotationsFromDialog(kind, mode),
      includeScaleBar: !!deps.els.expScaleBar?.checked,
      scaleBarSize: finiteNumberFromInput(deps.els.expScaleBarSize),
      scaleBarCorner: normalizeExportBarCorner(deps.els.expScaleBarCorner?.value),
      scaleBarInside: deps.els.expScaleBarInside?.checked !== false,
      colorBarCorner: normalizeExportBarCorner(deps.els.expColorBarCorner?.value),
      colorBarInside: deps.els.expColorBarInside?.checked !== false,
      includeColorBar: !!deps.els.expColorBar?.checked,
      colorBarRange: range,
      displayRange: range
    };
  }

  function bandExportToken(ds, bandIndices) {
    if (activeJob?.composite) return `${ds.displayMode}-composite`;
    if (Array.isArray(bandIndices) && bandIndices.length === 1) {
      return sanitizeFilePart(deps.bandLabel(ds, bandIndices[0]));
    }
    return "all-bands";
  }

  function effectiveSelectionIdSet(ds) {
    const items = (typeof deps.getEffectiveAreaSelections === "function")
      ? deps.getEffectiveAreaSelections(ds)
      : [];
    const ids = new Set();
    for (const item of (Array.isArray(items) ? items : [])) {
      if (Number.isFinite(Number(item?.id))) ids.add(Number(item.id));
    }
    if (!ids.size && Number.isFinite(Number(ds?.selectedAreaId))) {
      ids.add(Number(ds.selectedAreaId));
    }
    return ids;
  }

  function normalizeAnnotationState(ds, opts = {}) {
    const omitSelectionOverlay = !!opts.omitSelectionOverlay;
    const selectionIds = omitSelectionOverlay ? effectiveSelectionIdSet(ds) : new Set();
    const drawings = Array.isArray(ds?.drawings) ? ds.drawings : [];
    return {
      drawings: selectionIds.size
        ? drawings.filter((item) => !selectionIds.has(Number(item?.id)))
        : drawings,
      selectedAreaId: omitSelectionOverlay ? null : (Number.isFinite(Number(ds?.selectedAreaId)) ? Number(ds.selectedAreaId) : null),
      draft: null,
      rulerHover: null,
      rulerProfileHover: null
    };
  }

  function drawAnnotationsOnRenderedContext(ctx, ds, rect, opts = {}) {
    if (!ctx || !ds || !rect || typeof deps.getDrawData !== "function") return;
    const outputW = Math.max(1, Number(opts.outputW || rect.w || 1));
    const outputH = Math.max(1, Number(opts.outputH || rect.h || 1));
    const scale = outputW / Math.max(1, Number(rect.w) || 1);
    const overlayRenderer = createOverlayRenderer({
      els: { overlayCanvas: { width: outputW, height: outputH }, btnGrid: null, chkGrid: null },
      overlayCtx: ctx,
      getDevicePixelRatio: () => 1,
      getDrawData: (dataset, explicitState = null) => {
        const drawData = deps.getDrawData(dataset, explicitState);
        if (!drawData) return drawData;
        return {
          ...drawData,
          selectionIds: [],
          marqueeOffset: 0
        };
      }
    });
    const exportDataset = {
      ...ds,
      view: {
        ...(ds.view || {}),
        x: Number(rect.x0) || 0,
        y: Number(rect.y0) || 0,
        scale
      }
    };
    overlayRenderer.drawOverlaysForPanel(exportDataset, { x: 0, y: 0, w: outputW, h: outputH }, {
      active: false,
      showScaleBar: false,
      showImageBounds: false,
      borderColor: "rgba(0,0,0,0)",
      label: "",
      annotations: normalizeAnnotationState(ds, { omitSelectionOverlay: !!opts.omitSelectionOverlay })
    });
  }

  function subsetMetaForBandIndices(meta, bandIndices) {
    const safe = Array.isArray(bandIndices) && bandIndices.length ? bandIndices : [0];
    return {
      ...meta,
      bands: safe.length,
      bandNames: Array.isArray(meta?.bandNames) ? safe.map((idx) => meta.bandNames[idx]).filter((v) => v != null) : undefined,
      wavelengths: Array.isArray(meta?.wavelengths) ? safe.map((idx) => meta.wavelengths[idx]).filter((v) => v != null) : undefined
    };
  }

  function viewRect(ds) {
    const dpr = window.devicePixelRatio || 1;
    const eff = ds.view.scale * dpr;
    const viewport = (typeof deps.getActiveViewportDevice === "function")
      ? deps.getActiveViewportDevice()
      : { width: deps.els.cpuCanvas.width, height: deps.els.cpuCanvas.height };
    const viewW = Math.max(1, Number(viewport.width || viewport.w || 1)) / eff;
    const viewH = Math.max(1, Number(viewport.height || viewport.h || 1)) / eff;
    return clampRect(ds, {
      x0: Math.floor(ds.view.x),
      y0: Math.floor(ds.view.y),
      x1: Math.ceil(ds.view.x + viewW),
      y1: Math.ceil(ds.view.y + viewH)
    });
  }

  function viewportCssSize() {
    const viewport = (typeof deps.getActiveViewportCss === "function")
      ? deps.getActiveViewportCss()
      : null;
    return {
      width: Math.max(1, Math.round(Number(viewport?.width || viewport?.w || deps.els.main?.getBoundingClientRect?.().width || 1))),
      height: Math.max(1, Math.round(Number(viewport?.height || viewport?.h || deps.els.main?.getBoundingClientRect?.().height || 1)))
    };
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

  function normalizeRectExclusive(ds, x0, y0, x1, y1) {
    const maxX = Math.max(1, ds.meta.samples);
    const maxY = Math.max(1, ds.meta.lines);
    let nx0 = Math.floor(Math.min(x0, x1));
    let ny0 = Math.floor(Math.min(y0, y1));
    let nx1 = Math.ceil(Math.max(x0, x1));
    let ny1 = Math.ceil(Math.max(y0, y1));
    nx0 = deps.clamp(nx0, 0, maxX - 1);
    ny0 = deps.clamp(ny0, 0, maxY - 1);
    nx1 = deps.clamp(nx1, 1, maxX);
    ny1 = deps.clamp(ny1, 1, maxY);
    if (nx1 <= nx0) nx1 = Math.min(maxX, nx0 + 1);
    if (ny1 <= ny0) ny1 = Math.min(maxY, ny0 + 1);
    return {
      x0: nx0,
      y0: ny0,
      x1: nx1,
      y1: ny1,
      w: nx1 - nx0,
      h: ny1 - ny0
    };
  }

  function collectSelectionsFromItems(ds, items) {
    const out = [];
    const drawings = Array.isArray(items) ? items.slice() : [];
    drawings.sort((a, b) => (Number(a?.id) || 0) - (Number(b?.id) || 0));

    for (const item of drawings) {
      if (!item || !Array.isArray(item.points)) continue;
      if (item.tool === "rect" && item.points.length >= 2) {
        const a = item.points[0];
        const b = item.points[item.points.length - 1];
        const rect = normalizeRectExclusive(ds, a.x, a.y, b.x, b.y);
        out.push({ id: item.id, tool: "rect", rect, points: null });
      } else if (item.tool === "shape" && item.points.length >= 3) {
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        const points = [];
        for (const p of item.points) {
          if (!p) continue;
          points.push({ x: p.x, y: p.y });
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        }
        if (points.length < 3) continue;
        const rect = normalizeRectExclusive(ds, minX, minY, maxX, maxY);
        out.push({ id: item.id, tool: "shape", rect, points });
      }
    }
    return out;
  }

  function collectAreaSelections(ds) {
    if (!ds) return [];
    const out = (typeof deps.getEffectiveAreaSelections === "function")
      ? collectSelectionsFromItems(ds, deps.getEffectiveAreaSelections(ds))
      : collectSelectionsFromItems(ds, ds.drawings);

    if (out.length) return out;
    const r = deps.state.selection.imgRect;
    if (!r) return out;
    const x0 = Number.isFinite(r.x0) ? r.x0 : 0;
    const y0 = Number.isFinite(r.y0) ? r.y0 : 0;
    const x1 = Number.isFinite(r.x1) ? r.x1 : x0 + (Number.isFinite(r.w) ? r.w : 1);
    const y1 = Number.isFinite(r.y1) ? r.y1 : y0 + (Number.isFinite(r.h) ? r.h : 1);
    const rect = normalizeRectExclusive(ds, x0, y0, x1, y1);
    out.push({ id: "legacy-sel", tool: "rect", rect, points: null });
    return out;
  }

  function hasNonRectSelections(selections) {
    return Array.isArray(selections) && selections.some((sel) => sel && sel.tool === "shape");
  }

  function unionRects(rects) {
    if (!Array.isArray(rects) || !rects.length) return null;
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (const r of rects) {
      if (!r) continue;
      if (r.x0 < x0) x0 = r.x0;
      if (r.y0 < y0) y0 = r.y0;
      if (r.x1 > x1) x1 = r.x1;
      if (r.y1 > y1) y1 = r.y1;
    }
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) return null;
    return { x0, y0, x1, y1, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }

  function resolveSelectionExportPlan(ds, selections, separate = false) {
    const list = Array.isArray(selections) ? selections.filter(Boolean) : [];
    if (!list.length) return { jobs: [], hasNonRect: false };
    const jobs = [];
    const isSeparate = !!(separate && list.length > 1);

    const buildJob = (parts, serial = null) => {
      const box = unionRects(parts.map((p) => p.rect));
      if (!box) return null;
      const hasNonRect = hasNonRectSelections(parts);
      let w = box.w;
      let h = box.h;
      if (hasNonRect) {
        const side = Math.max(w, h);
        w = side;
        h = side;
      }
      return {
        serial,
        selections: parts,
        x0: box.x0,
        y0: box.y0,
        w,
        h,
        hasNonRect
      };
    };

    if (isSeparate) {
      for (let i = 0; i < list.length; i += 1) {
        const job = buildJob([list[i]], i + 1);
        if (job) jobs.push(job);
      }
    } else {
      const job = buildJob(list, null);
      if (job) jobs.push(job);
    }
    return { jobs, hasNonRect: hasNonRectSelections(list) };
  }

  function selectionContainsPixel(sel, x, y) {
    if (!sel) return false;
    if (x < sel.rect.x0 || x >= sel.rect.x1 || y < sel.rect.y0 || y >= sel.rect.y1) return false;
    if (sel.tool === "rect") return true;
    if (sel.tool === "shape" && Array.isArray(sel.points) && sel.points.length >= 3) {
      return pointInPolygon(x + 0.5, y + 0.5, sel.points);
    }
    return false;
  }

  async function buildSelectionMask(ds, job) {
    const { w, h, x0, y0 } = job;
    const mask = new Uint8Array(w * h);
    const rectOnly = job.selections.every((sel) => sel.tool === "rect");
    if (rectOnly) {
      for (const sel of job.selections) {
        const sx0 = Math.max(0, sel.rect.x0 - x0);
        const sy0 = Math.max(0, sel.rect.y0 - y0);
        const sx1 = Math.min(w, sel.rect.x1 - x0);
        const sy1 = Math.min(h, sel.rect.y1 - y0);
        for (let row = sy0; row < sy1; row += 1) {
          mask.fill(1, row * w + sx0, row * w + sx1);
        }
      }
      return mask;
    }

    for (let row = 0; row < h; row += 1) {
      if (row % Math.max(1, Math.floor(262144 / w)) === 0) await stage("Preparing selection mask...", row, h);
      const gy = y0 + row;
      if (gy < 0 || gy >= ds.meta.lines) continue;
      for (let col = 0; col < w; col += 1) {
        const gx = x0 + col;
        if (gx < 0 || gx >= ds.meta.samples) continue;
        for (const sel of job.selections) {
          if (selectionContainsPixel(sel, gx, gy)) {
            mask[row * w + col] = 1;
            break;
          }
        }
      }
    }
    return mask;
  }

  function sourceWindowForJob(ds, job) {
    const x0 = deps.clamp(job.x0, 0, ds.meta.samples);
    const y0 = deps.clamp(job.y0, 0, ds.meta.lines);
    const x1 = deps.clamp(job.x0 + job.w, 0, ds.meta.samples);
    const y1 = deps.clamp(job.y0 + job.h, 0, ds.meta.lines);
    const w = Math.max(0, x1 - x0);
    const h = Math.max(0, y1 - y0);
    return {
      x0,
      y0,
      w,
      h,
      offX: x0 - job.x0,
      offY: y0 - job.y0
    };
  }

  function selectionBaseName(ds, band, job, raw) {
    const stem = `${ds.name}_${sanitizeFilePart(deps.bandLabel(ds, band))}`;
    if (Number.isFinite(job.serial)) {
      const serial = String(job.serial).padStart(3, "0");
      return raw ? `${stem}_${serial}_rawstack` : `${stem}_${serial}`;
    }
    return raw
      ? `${stem}_${job.x0}_${job.y0}_${job.w}x${job.h}_rawstack`
      : `${stem}_${job.x0}_${job.y0}_${job.w}x${job.h}`;
  }

  function resolveExportRect(ds, scope) {
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

  function resolveRenderedExportTarget(ds, scope, rect = null) {
    const targetRect = rect || resolveExportRect(ds, scope);
    if (scope === "view") {
      const viewport = viewportCssSize();
      return {
        rect: targetRect,
        outputW: viewport.width,
        outputH: viewport.height,
        mode: "viewport"
      };
    }
    return {
      rect: targetRect,
      outputW: targetRect.w,
      outputH: targetRect.h,
      mode: "window"
    };
  }

  function imageDataToCanvas(img) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Number(img?.width) || 1);
    canvas.height = Math.max(1, Number(img?.height) || 1);
    const ctx = canvas.getContext("2d", { alpha: false });
    if (ctx && img) ctx.putImageData(img, 0, 0);
    return canvas;
  }

  async function renderViewportToImageData(ds, band, rect, opts = {}) {
    const viewport = viewportCssSize();
    const geom = resolveRasterSampling(ds, viewport.width, viewport.height, Number(ds?.view?.scale) || 1);
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (geom.validW > 0 && geom.validH > 0) {
      const src = await renderExportWindow(ds, band, geom.srcX0, geom.srcY0, geom.validW, geom.validH, geom.step, {
        displayRange: opts.displayRange || opts.colorBarRange || null
      });
      const srcCanvas = imageDataToCanvas(src);
      const displayRect = geom.displayRect || { x: 0, y: 0, w: canvas.width, h: canvas.height };
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(
        srcCanvas,
        0,
        0,
        srcCanvas.width,
        srcCanvas.height,
        Number(displayRect.x) || 0,
        Number(displayRect.y) || 0,
        Math.max(1, Number(displayRect.w) || 1),
        Math.max(1, Number(displayRect.h) || 1)
      );
    }

    return {
      imageData: ctx.getImageData(0, 0, canvas.width, canvas.height),
      outputW: canvas.width,
      outputH: canvas.height,
      rect
    };
  }

  function selectionBaseName(ds, bandIndices, job, suffix = "") {
    const stem = `${ds.name}_${bandExportToken(ds, bandIndices)}`;
    const core = Number.isFinite(job.serial)
      ? String(job.serial).padStart(3, "0")
      : `${job.x0}_${job.y0}_${job.w}x${job.h}`;
    return suffix ? `${stem}_${core}_${suffix}` : `${stem}_${core}`;
  }

  function rectBaseName(ds, bandIndices, rect, suffix = "", scope = "window", outputW = rect.w, outputH = rect.h) {
    const stem = `${ds.name}_${bandExportToken(ds, bandIndices)}`;
    if (scope === "view") {
      return suffix ? `${stem}_view_${outputW}x${outputH}_${suffix}` : `${stem}_view_${outputW}x${outputH}`;
    }
    return suffix ? `${stem}_${rect.x0}_${rect.y0}_${rect.w}x${rect.h}_${suffix}` : `${stem}_${rect.x0}_${rect.y0}_${rect.w}x${rect.h}`;
  }

  async function readBandExportData(ds, bandIndex, x0, y0, w, h) {
    const read = ds.meta.interleave === "bip" ? deps.readBandWindowBIP : deps.readBandWindow;
    const rows = Math.max(1, Math.floor(262144 / w));
    let output;
    for (let y = 0; y < h; y += rows) {
      await stage(`Reading band ${bandIndex + 1}, rows…`, y, h);
      const part = await read(ds.meta, ds.ds, bandIndex, x0, y0 + y, w, Math.min(rows, h - y), 1);
      if (!output) output = new part.constructor(w * h);
      output.set(part, y * w);
    }
    await stage(`Read band ${bandIndex + 1} rows`, h, h);
    return output;
  }

  function scaled8Meta(meta, bandIndices) {
    return {
      ...subsetMetaForBandIndices(meta, bandIndices),
      dataType: 1,
      dataTypeInfo: { bytes: 1, name: "uint8", ctor: Uint8Array }
    };
  }

  function resolveScaled8Range(ds, bandIndex) {
    const resolved = (typeof deps.resolveDisplayRange === "function")
      ? deps.resolveDisplayRange(ds, bandIndex, null)
      : null;
    const settings = (typeof deps.getBandSettings === "function")
      ? deps.getBandSettings(ds, bandIndex)
      : null;
    let minVal = Number(resolved?.minVal);
    let maxVal = Number(resolved?.maxVal);
    if (!Number.isFinite(minVal)) minVal = Number(settings?.min);
    if (!Number.isFinite(maxVal)) maxVal = Number(settings?.max);
    if (!Number.isFinite(minVal)) minVal = 0;
    if (!Number.isFinite(maxVal)) maxVal = minVal + 1;
    if (maxVal === minVal) maxVal = minVal + 1e-6;
    if (maxVal < minVal) {
      const tmp = minVal;
      minVal = maxVal;
      maxVal = tmp;
    }
    return { minVal, maxVal };
  }

  function imageDataFromCanvas(canvas) {
    const ctx = canvas.getContext("2d", { alpha: false });
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  function formatExportNumber(v) {
    if (!Number.isFinite(v)) return "";
    const a = Math.abs(v);
    if (a !== 0 && (a < 0.001 || a >= 100000)) return Number(v).toExponential(3).replace(/0+e/, "e");
    return String(Number(v.toPrecision(6))).replace(/\.0+$/, "");
  }

  function formatExportDistance(ds, imgPx) {
    const sc = ds?.meta?.scale;
    const umPerPx = Number(sc?.umPerPixelX);
    if (Number.isFinite(umPerPx) && umPerPx > 0) {
      const um = imgPx * umPerPx;
      if (Math.abs(um) >= 1000) return `${formatExportNumber(um / 1000)} mm`;
      if (Math.abs(um) >= 1) return `${formatExportNumber(um)} um`;
      return `${formatExportNumber(um * 1000)} nm`;
    }
    return `${formatExportNumber(imgPx)} px`;
  }

  function resolveScaleBarImagePixels(ds, rect, outputW, requestedSize) {
    const rawSize = Number(requestedSize);
    if (Number.isFinite(rawSize) && rawSize > 0) {
      const umPerPx = Number(ds?.meta?.scale?.umPerPixelX);
      return (Number.isFinite(umPerPx) && umPerPx > 0) ? rawSize / umPerPx : rawSize;
    }
    const target = Math.max(1, Number(rect?.w) || 1) * 0.22;
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    const base = target / pow;
    const nice = base >= 5 ? 5 : base >= 2 ? 2 : 1;
    return nice * pow;
  }

  function exportBarMetrics(ctx, ds, rect, outputW, outputH, opts = {}) {
    const imgPx = resolveScaleBarImagePixels(ds, rect, outputW, opts.scaleBarSize);
    const pxPerImg = outputW / Math.max(1, Number(rect?.w) || 1);
    const barW = deps.clamp(Math.round(imgPx * pxPerImg), 12, Math.max(12, outputW - 28));
    const pad = Math.max(10, Math.round(Math.min(outputW, outputH) * 0.018));
    const tick = Math.max(6, Math.round(pad * 0.55));
    const fontPx = Math.max(12, Math.round(Math.min(outputW, outputH) * 0.025));
    const scaleLabel = formatExportDistance(ds, imgPx);
    const colorRange = resolveExportColorRange(ds, opts.bandIndex, opts.colorBarRange);
    const colorMinLabel = formatExportNumber(colorRange.minVal);
    const colorMaxLabel = formatExportNumber(colorRange.maxVal);
    const colorGap = Math.max(6, Math.round(pad * 0.55));
    const colorBarH = Math.max(10, Math.round(fontPx * 0.75));
    ctx.save();
    ctx.font = `${fontPx}px Arial, sans-serif`;
    const colorBarW = Math.max(barW,
      ctx.measureText(colorMinLabel).width + ctx.measureText(colorMaxLabel).width + pad);
    const labelTextW = Math.max(
      opts.includeScaleBar ? Math.max(ctx.measureText(scaleLabel).width, barW) : 0,
      opts.includeColorBar ? colorBarW : 0
    );
    ctx.restore();
    return {
      pad,
      tick,
      fontPx,
      colorGap,
      imgPx,
      barW,
      colorBarH,
      colorBarW,
      scaleLabel,
      colorRange,
      colorMinLabel,
      colorMaxLabel,
      boxW: Math.ceil(labelTextW + (pad * 2))
    };
  }

  function drawExportScaleBar(ctx, metrics, x0, yCursor) {
    const bx0 = x0 + metrics.pad;
    const by = yCursor;
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = Math.max(2, Math.round(metrics.fontPx * 0.16));
    ctx.beginPath();
    ctx.moveTo(bx0, by);
    ctx.lineTo(bx0 + metrics.barW, by);
    ctx.moveTo(bx0, by);
    ctx.lineTo(bx0, by + metrics.tick);
    ctx.moveTo(bx0 + metrics.barW, by);
    ctx.lineTo(bx0 + metrics.barW, by + metrics.tick);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(metrics.scaleLabel, bx0, yCursor + metrics.tick + metrics.colorGap + metrics.fontPx);
  }

  function resolveExportColorRange(ds, bandIndex, explicitRange) {
    const minVal = Number(explicitRange?.minVal);
    const maxVal = Number(explicitRange?.maxVal);
    if (Number.isFinite(minVal) && Number.isFinite(maxVal) && minVal !== maxVal) {
      return { minVal: Math.min(minVal, maxVal), maxVal: Math.max(minVal, maxVal) };
    }
    return resolveScaled8Range(ds, bandIndex);
  }

  function drawExportColorBar(ctx, metrics, x0, yCursor) {
    const bx = x0 + metrics.pad;
    const by = yCursor + metrics.fontPx + Math.round(metrics.colorGap * 0.35);
    const grad = ctx.createLinearGradient(bx, 0, bx + metrics.colorBarW, 0);
    grad.addColorStop(0, "#000");
    grad.addColorStop(1, "#fff");
    ctx.fillStyle = grad;
    ctx.fillRect(bx, by, metrics.colorBarW, metrics.colorBarH);
    ctx.strokeStyle = "rgba(255,255,255,0.86)";
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, by, metrics.colorBarW, metrics.colorBarH);
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(metrics.colorMinLabel, bx, yCursor + metrics.fontPx);
    ctx.textAlign = "right";
    ctx.fillText(metrics.colorMaxLabel, bx + metrics.colorBarW, yCursor + metrics.fontPx);
  }

  function drawExportBars(ctx, metrics, layout) {
    ctx.save();
    ctx.font = `${metrics.fontPx}px Arial, sans-serif`;
    for (const group of layout.groups) {
      let yCursor = group.y + metrics.pad;
      for (const type of group.bars) {
        if (type === "color") {
          drawExportColorBar(ctx, metrics, group.x, yCursor);
          yCursor += metrics.fontPx + metrics.colorBarH + metrics.colorGap * 2;
        } else {
          drawExportScaleBar(ctx, metrics, group.x, yCursor);
        }
      }
    }
    ctx.restore();
  }

  function finalizeRenderedImage(ds, rect, imageData, opts = {}) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Number(opts.outputW || imageData?.width || rect?.w || 1));
    canvas.height = Math.max(1, Number(opts.outputH || imageData?.height || rect?.h || 1));
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.putImageData(imageData, 0, 0);
    if (opts.includeAnnotations) {
      drawAnnotationsOnRenderedContext(ctx, ds, rect, {
        outputW: canvas.width,
        outputH: canvas.height,
        omitSelectionOverlay: !!opts.omitSelectionOverlay
      });
    }
    if (!opts.includeScaleBar && !opts.includeColorBar) return imageDataFromCanvas(canvas);
    const metrics = exportBarMetrics(ctx, ds, rect, canvas.width, canvas.height, opts);
    const layout = layoutExportBars(canvas.width, canvas.height, metrics, opts);
    const output = document.createElement("canvas");
    output.width = layout.width;
    output.height = layout.height;
    const outputCtx = output.getContext("2d", { alpha: false });
    outputCtx.fillStyle = "#000";
    outputCtx.fillRect(0, 0, output.width, output.height);
    outputCtx.drawImage(canvas, layout.imageX, layout.imageY);
    drawExportBars(outputCtx, metrics, layout);
    return imageDataFromCanvas(output);
  }

  async function buildSelectionRenderedImageData(ds, bandIndex, job, opts = {}) {
    const srcWin = sourceWindowForJob(ds, job);
    const mask = await buildSelectionMask(ds, job);
    const outCanvas = document.createElement("canvas");
    outCanvas.width = job.w;
    outCanvas.height = job.h;
    const outCtx = outCanvas.getContext("2d", { alpha: false });
    const outImg = outCtx.createImageData(job.w, job.h);
    const outData = outImg.data;
    for (let px = 0; px < job.w * job.h; px += 1) {
      outData[(px * 4) + 3] = 255;
    }

    if (srcWin.w > 0 && srcWin.h > 0) {
      const src = await renderExportWindow(ds, bandIndex, srcWin.x0, srcWin.y0, srcWin.w, srcWin.h, 1, {
        displayRange: opts.displayRange || opts.colorBarRange || null
      });
      for (let row = 0; row < srcWin.h; row += 1) {
        if (row % Math.max(1, Math.floor(262144 / srcWin.w)) === 0) await stage("Applying selection mask...", row, srcWin.h);
        const outRow = row + srcWin.offY;
        for (let col = 0; col < srcWin.w; col += 1) {
          const outCol = col + srcWin.offX;
          const outPixel = outRow * job.w + outCol;
          if (!mask[outPixel]) continue;
          const srcPixel = row * srcWin.w + col;
          const si = srcPixel * 4;
          const oi = outPixel * 4;
          outData[oi] = src.data[si];
          outData[oi + 1] = src.data[si + 1];
          outData[oi + 2] = src.data[si + 2];
          outData[oi + 3] = 255;
        }
      }
    }

    return finalizeRenderedImage(ds, { x0: job.x0, y0: job.y0, w: job.w, h: job.h }, outImg, {
      outputW: job.w,
      outputH: job.h,
      includeAnnotations: !!opts.includeAnnotations,
      omitSelectionOverlay: !!opts.omitSelectionOverlay,
      includeScaleBar: !!opts.includeScaleBar,
      scaleBarSize: opts.scaleBarSize,
      barCorner: opts.barCorner,
      scaleBarCorner: opts.scaleBarCorner,
      scaleBarInside: opts.scaleBarInside,
      colorBarCorner: opts.colorBarCorner,
      colorBarInside: opts.colorBarInside,
      includeColorBar: !!opts.includeColorBar,
      colorBarRange: opts.colorBarRange,
      bandIndex
    });
  }

  async function buildRenderedImageData(ds, bandIndex, rect, scope = "window", opts = {}) {
    const target = resolveRenderedExportTarget(ds, scope, rect);
    const rendered = target.mode === "viewport"
      ? await renderViewportToImageData(ds, bandIndex, target.rect, opts)
      : {
          imageData: await renderExportWindow(ds, bandIndex, target.rect.x0, target.rect.y0, target.outputW, target.outputH, 1, {
            displayRange: opts.displayRange || opts.colorBarRange || null
          }),
          outputW: target.outputW,
          outputH: target.outputH,
          rect: target.rect
        };
    const finalImage = finalizeRenderedImage(ds, target.rect, rendered.imageData, {
      outputW: target.outputW,
      outputH: target.outputH,
      includeAnnotations: !!opts.includeAnnotations,
      omitSelectionOverlay: !!opts.omitSelectionOverlay,
      includeScaleBar: !!opts.includeScaleBar,
      scaleBarSize: opts.scaleBarSize,
      barCorner: opts.barCorner,
      scaleBarCorner: opts.scaleBarCorner,
      scaleBarInside: opts.scaleBarInside,
      colorBarCorner: opts.colorBarCorner,
      colorBarInside: opts.colorBarInside,
      includeColorBar: !!opts.includeColorBar,
      colorBarRange: opts.colorBarRange,
      bandIndex
    });
    return {
      imageData: finalImage,
      outputW: finalImage.width,
      outputH: finalImage.height,
      rect: target.rect,
      mode: target.mode
    };
  }

  async function maybeConfirmLargeRawExport(totalBytes, label = "raw export") {
    if (totalBytes <= (1024 * 1024 * 1024)) return true;
    return deps.confirmFn(`This ${label} is about ${deps.humanBytes(totalBytes)} and may crash the browser. Continue?`);
  }

  async function exportRenderedSelectionJobs(ds, kind, jobs, bandIndices = [ds.activeBand], opts = {}) {
    if (!Array.isArray(jobs) || !jobs.length || !Array.isArray(bandIndices) || !bandIndices.length) return;
    const maxPix = 20_000_000;
    for (const job of jobs) {
      if (job.w * job.h > maxPix) {
        deps.alertFn(`Export too large (${deps.fmt(job.w * job.h)} pixels). Please select a smaller region.`);
        return;
      }
    }

    for (let i = 0; i < jobs.length; i += 1) {
      const job = jobs[i];
      if (activeJob) activeJob.region = `Region ${i + 1}/${jobs.length}`;
      const pages = [];
      for (let bandPos = 0; bandPos < bandIndices.length; bandPos += 1) {
        const bandIndex = bandIndices[bandPos];
        deps.setStatus(
          bandIndices.length > 1
            ? `export… ${i + 1}/${jobs.length} (${bandPos + 1}/${bandIndices.length})`
            : (jobs.length > 1 ? `export… ${i + 1}/${jobs.length}` : "export…"),
          "warn"
        );
        pages.push(await buildSelectionRenderedImageData(ds, bandIndex, job, opts));
      }

      if (kind === "png") {
        const canvas = imageDataToCanvas(pages[0]);
        const blob = await encodePng(canvas);
        deps.downloadBlob(blob, `${selectionBaseName(ds, bandIndices, job)}.png`);
      } else {
        const base = selectionBaseName(ds, bandIndices, job, bandIndices.length > 1 ? "renderedstack" : "rendered");
        const blob = await encode("rendered", { pages });
        deps.downloadBlob(blob, `${base}.tiff`);
      }
    }
    deps.setStatus("ready", "ok");
  }

  async function exportRendered(ds, kind, rect, scope = "window", bandIndices = [ds.activeBand], opts = {}) {
    if (!Array.isArray(bandIndices) || !bandIndices.length) return;
    const target = resolveRenderedExportTarget(ds, scope, rect);
    const w = target.outputW;
    const h = target.outputH;
    const maxPix = 20_000_000;
    if ((w * h) > maxPix) {
      deps.alertFn(`Export too large (${deps.fmt(w * h)} pixels). Please select a smaller region.`);
      return;
    }

    const pages = [];
    for (let bandPos = 0; bandPos < bandIndices.length; bandPos += 1) {
      const bandIndex = bandIndices[bandPos];
      deps.setStatus(
        bandIndices.length > 1 ? `export… ${bandPos + 1}/${bandIndices.length}` : "export…",
        "warn"
      );
      const rendered = await buildRenderedImageData(ds, bandIndex, rect, scope, opts);
      pages.push(rendered.imageData);
    }

    const base = rectBaseName(ds, bandIndices, target.rect, bandIndices.length > 1 ? "renderedstack" : "rendered", scope, w, h);
    if (kind === "png") {
      const canvas = imageDataToCanvas(pages[0]);
      const blob = await encodePng(canvas);
      deps.downloadBlob(blob, `${rectBaseName(ds, bandIndices, target.rect, "", scope, w, h)}.png`);
      deps.setStatus("ready", "ok");
      return;
    }

    const blob = await encode("rendered", { pages });
    deps.downloadBlob(blob, `${base}.tiff`);
    deps.setStatus("ready", "ok");
  }

  async function buildRawSelectionPages(ds, job, bandIndices) {
    const srcWin = sourceWindowForJob(ds, job);
    const mask = await buildSelectionMask(ds, job);
    const pages = [];
    for (let bandPos = 0; bandPos < bandIndices.length; bandPos += 1) {
      const bandIndex = bandIndices[bandPos];
      deps.setStatus(`export raw… ${bandPos + 1}/${bandIndices.length}`, "warn");
      let src = null;
      if (srcWin.w > 0 && srcWin.h > 0) {
        src = await readBandExportData(ds, bandIndex, srcWin.x0, srcWin.y0, srcWin.w, srcWin.h);
      }
      const Ctor = src ? src.constructor : (ds.meta.dataTypeInfo.ctor || Float64Array);
      const out = new Ctor(job.w * job.h);
      if (src && srcWin.w > 0 && srcWin.h > 0) {
        for (let row = 0; row < srcWin.h; row += 1) {
          if (row % Math.max(1, Math.floor(262144 / srcWin.w)) === 0) await stage("Applying selection mask...", row, srcWin.h);
          const outRow = row + srcWin.offY;
          for (let col = 0; col < srcWin.w; col += 1) {
            const outCol = col + srcWin.offX;
            const outIndex = outRow * job.w + outCol;
            if (!mask[outIndex]) continue;
            out[outIndex] = src[row * srcWin.w + col];
          }
        }
      }
      pages.push(out);
    }
    return pages;
  }

  async function exportRawSelectionJobs(ds, jobs, bandIndices = [ds.activeBand], kind = "tiff") {
    if (!Array.isArray(jobs) || !jobs.length || !Array.isArray(bandIndices) || !bandIndices.length) return;
    const bpp = ds.meta.dataTypeInfo.bytes;
    const totalBytes = jobs.reduce((sum, job) => sum + (job.w * job.h * bandIndices.length * bpp), 0);
    if (!(await maybeConfirmLargeRawExport(totalBytes))) return;

    for (let jobIdx = 0; jobIdx < jobs.length; jobIdx += 1) {
      const job = jobs[jobIdx];
      if (activeJob) activeJob.region = `Region ${jobIdx + 1}/${jobs.length}`;
      const pages = await buildRawSelectionPages(ds, job, bandIndices);
      const base = selectionBaseName(ds, bandIndices, job, bandIndices.length > 1 ? "rawstack" : "raw");
      if (kind === "envi") {
        const meta = subsetMetaForBandIndices(ds.meta, bandIndices);
        const datName = `${base}.dat`;
        const parts = [];
        for (const page of pages) parts.push(await encode("envi", { meta, pages: [page] }));
        const hdrText = buildEnviHeaderText({
          meta,
          width: job.w,
          height: job.h,
          bands: bandIndices.length,
          interleave: RAW_ENVI_INTERLEAVE,
          littleEndian: RAW_ENVI_LITTLE_ENDIAN,
          dataFileName: datName
        });
        deps.downloadBlob(new Blob(parts, { type: "application/octet-stream" }), datName);
        deps.downloadBlob(new Blob([hdrText], { type: "text/plain;charset=utf-8" }), `${base}.hdr`);
      } else {
        const blob = await encode("raw", { composite: !!activeJob?.composite, meta: ds.meta, width: job.w, height: job.h, pages });
        deps.downloadBlob(blob, `${base}.tiff`);
      }
    }
    deps.setStatus("ready", "ok");
  }

  async function exportScaled8SelectionJobs(ds, jobs, bandIndices = [ds.activeBand]) {
    if (!Array.isArray(jobs) || !jobs.length || !Array.isArray(bandIndices) || !bandIndices.length) return;
    const totalBytes = jobs.reduce((sum, job) => sum + (job.w * job.h * bandIndices.length), 0);
    if (!(await maybeConfirmLargeRawExport(totalBytes, "scaled 8-bit export"))) return;

    for (let jobIdx = 0; jobIdx < jobs.length; jobIdx += 1) {
      const job = jobs[jobIdx];
      if (activeJob) activeJob.region = `Region ${jobIdx + 1}/${jobs.length}`;
      const rawPages = await buildRawSelectionPages(ds, job, bandIndices);
      const pages = rawPages;
      const base = selectionBaseName(ds, bandIndices, job, bandIndices.length > 1 ? "scaled8stack" : "scaled8");
      const blob = await encode("scaled8", { composite: !!activeJob?.composite,
        ranges: bandIndices.map((band) => resolveScaled8Range(ds, band)),
        meta: scaled8Meta(ds.meta, bandIndices),
        width: job.w,
        height: job.h,
        pages
      });
      deps.downloadBlob(blob, `${base}.tiff`);
    }
    deps.setStatus("ready", "ok");
  }

  async function exportRawStackTIFF(ds, rect, bandIndices = [ds.activeBand]) {
    const w = rect.w;
    const h = rect.h;
    const totalBytes = w * h * bandIndices.length * ds.meta.dataTypeInfo.bytes;
    if (!(await maybeConfirmLargeRawExport(totalBytes, "raw export"))) return;

    deps.setStatus("export raw…", "warn");
    const pages = [];
    for (let bandPos = 0; bandPos < bandIndices.length; bandPos += 1) {
      deps.setStatus(`export raw… ${bandPos + 1}/${bandIndices.length}`, "warn");
      pages.push(await readBandExportData(ds, bandIndices[bandPos], rect.x0, rect.y0, w, h));
    }

    const blob = await encode("raw", { composite: !!activeJob?.composite, meta: ds.meta, width: w, height: h, pages });
    deps.downloadBlob(blob, `${rectBaseName(ds, bandIndices, rect, bandIndices.length > 1 ? "rawstack" : "raw")}.tiff`);
    deps.setStatus("ready", "ok");
  }

  async function exportScaled8StackTIFF(ds, rect, bandIndices = [ds.activeBand]) {
    const w = rect.w;
    const h = rect.h;
    const totalBytes = w * h * bandIndices.length;
    if (!(await maybeConfirmLargeRawExport(totalBytes, "scaled 8-bit export"))) return;

    deps.setStatus("export scaled 8-bit…", "warn");
    const pages = [];
    for (let bandPos = 0; bandPos < bandIndices.length; bandPos += 1) {
      deps.setStatus(`export scaled 8-bit… ${bandPos + 1}/${bandIndices.length}`, "warn");
      const raw = await readBandExportData(ds, bandIndices[bandPos], rect.x0, rect.y0, w, h);
      pages.push(raw);
    }

    const blob = await encode("scaled8", { composite: !!activeJob?.composite, ranges: bandIndices.map((band) => resolveScaled8Range(ds, band)), meta: scaled8Meta(ds.meta, bandIndices), width: w, height: h, pages });
    deps.downloadBlob(blob, `${rectBaseName(ds, bandIndices, rect, bandIndices.length > 1 ? "scaled8stack" : "scaled8")}.tiff`);
    deps.setStatus("ready", "ok");
  }

  async function exportRawStackENVI(ds, rect, bandIndices = [ds.activeBand]) {
    const w = rect.w;
    const h = rect.h;
    const totalBytes = w * h * bandIndices.length * ds.meta.dataTypeInfo.bytes;
    if (!(await maybeConfirmLargeRawExport(totalBytes, "raw export"))) return;

    deps.setStatus("export raw…", "warn");
    const meta = subsetMetaForBandIndices(ds.meta, bandIndices);
    const parts = [];
    for (let bandPos = 0; bandPos < bandIndices.length; bandPos += 1) {
      deps.setStatus(`export raw… ${bandPos + 1}/${bandIndices.length}`, "warn");
      const data = await readBandExportData(ds, bandIndices[bandPos], rect.x0, rect.y0, w, h);
      parts.push(await encode("envi", { meta, pages: [data] }));
    }

    const base = rectBaseName(ds, bandIndices, rect, bandIndices.length > 1 ? "rawstack" : "raw");
    const datName = `${base}.dat`;
    const hdrText = buildEnviHeaderText({
      meta,
      width: w,
      height: h,
      bands: bandIndices.length,
      interleave: RAW_ENVI_INTERLEAVE,
      littleEndian: RAW_ENVI_LITTLE_ENDIAN,
      dataFileName: datName
    });
    deps.downloadBlob(new Blob(parts, { type: "application/octet-stream" }), datName);
    deps.downloadBlob(new Blob([hdrText], { type: "text/plain;charset=utf-8" }), `${base}.hdr`);
    deps.setStatus("ready", "ok");
  }

  async function runExportFromDialog() {
    if (activeJob || deps.state.exportRunning) return;
    const ds = deps.getActive();
    if (!ds || ds.activeBand == null) return;
    activeJob = { composite: isThreeBandColorMode(ds) && !!deps.els.expBandComposite?.checked };
    deps.state.exportRunning = true;
    const button = deps.els.btnExpGo;
    const wasDisabled = button?.disabled;
    if (button) button.disabled = true;
    try {
      await stage("Preparing export…");
      await executeExportFromDialog(ds);
    } finally {
      activeJob = null;
      deps.state.exportRunning = false;
      if (button) button.disabled = wasDisabled;
      progress.close();
    }
  }

  async function executeExportFromDialog(ds) {
    const kind = selectedKindFromDialog();
    const mode = selectedModeFromDialog(kind);
    const scope = selectedScopeFromDialog();
    const bandIndices = selectedBandIndices(ds, kind);
    const includeAnnotations = includeAnnotationsFromDialog(kind, mode);
    const scaled8 = useScaled8FromDialog(ds, kind, mode);
    const renderedOpts = renderedExportOptionsFromDialog(kind, mode);
    deps.state.exportKind = kind;
    const selections = collectAreaSelections(ds);

    try {
      deps.els.exportDlg.close();
    } catch {}

    if (mode === "raw") {
      if (scope === "sel" && selections.length) {
        const plan = resolveSelectionExportPlan(ds, selections, false);
        if (scaled8) await exportScaled8SelectionJobs(ds, plan.jobs, bandIndices);
        else await exportRawSelectionJobs(ds, plan.jobs, bandIndices, kind);
        return;
      }
      const rect = resolveExportRect(ds, "view");
      if (scaled8) await exportScaled8StackTIFF(ds, rect, bandIndices);
      else if (kind === "envi") await exportRawStackENVI(ds, rect, bandIndices);
      else await exportRawStackTIFF(ds, rect, bandIndices);
      return;
    }

    if (scope === "sel" && selections.length) {
      const plan = resolveSelectionExportPlan(ds, selections, false);
      await exportRenderedSelectionJobs(ds, kind, plan.jobs, bandIndices, {
        ...renderedOpts,
        includeAnnotations,
        omitSelectionOverlay: true
      });
      return;
    }
    const rect = resolveExportRect(ds, "view");
    await exportRendered(ds, kind, rect, "view", bandIndices, { ...renderedOpts, includeAnnotations });
  }

  return {
    sanitizeFilePart,
    viewRect,
    wholeRect,
    clampRect,
    collectAreaSelections,
    hasNonRectSelections,
    resolveSelectionExportPlan,
    resolveExportRect,
    resolveRenderedExportTarget,
    exportRendered,
    exportRawStackTIFF,
    exportScaled8StackTIFF,
    exportRawStackENVI,
    runExportFromDialog
  };
}
