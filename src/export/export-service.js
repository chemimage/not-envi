import { encodeRawMultipageTiff, encodeRenderedTiff } from "./tiff-backend.js";
import { buildEnviHeaderText, encodeEnviBandBytes } from "./envi-backend.js";

export function createExportService(deps) {
  const RAW_ENVI_INTERLEAVE = "bsq";
  const RAW_ENVI_LITTLE_ENDIAN = true;

  function parseHexColor(color, alpha = 0.95) {
    const raw = String(color || "").trim();
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
    if (!m) return `rgba(255,45,45,${alpha})`;
    let hex = m[1];
    if (hex.length === 3) hex = `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function listRulerDrawings(ds) {
    if (!ds || !Array.isArray(ds.drawings)) return [];
    return ds.drawings.filter((item) => {
      if (!item || (item.tool !== "ruler" && item.tool !== "line")) return false;
      if (!Array.isArray(item.points) || item.points.length < 2) return false;
      return !!(item.points[0] && item.points[item.points.length - 1]);
    });
  }

  function drawRulersOnRenderedContext(ctx, ds, rect) {
    if (!ctx || !ds || !rect) return;
    const rulers = listRulerDrawings(ds);
    if (!rulers.length) return;
    ctx.save();
    ctx.lineWidth = 2;
    for (const item of rulers) {
      const a = item.points[0];
      const b = item.points[item.points.length - 1];
      const ax = a.x - rect.x0;
      const ay = a.y - rect.y0;
      const bx = b.x - rect.x0;
      const by = b.y - rect.y0;
      ctx.strokeStyle = parseHexColor(item.color, 0.95);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
    ctx.restore();
  }

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

  function buildSelectionMask(ds, job) {
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

  async function exportRenderedSelectionJobs(ds, kind, jobs) {
    const band = ds.activeBand;
    if (band == null || !Array.isArray(jobs) || !jobs.length) return;
    const maxPix = 20_000_000;
    for (const job of jobs) {
      if (job.w * job.h > maxPix) {
        deps.alertFn(`Export too large (${deps.fmt(job.w * job.h)} pixels). Please select a smaller region.`);
        return;
      }
    }

    for (let i = 0; i < jobs.length; i += 1) {
      const job = jobs[i];
      deps.setStatus(jobs.length > 1 ? `export… ${i + 1}/${jobs.length}` : "export…", "warn");
      const srcWin = sourceWindowForJob(ds, job);
      const mask = buildSelectionMask(ds, job);

      const outCanvas = document.createElement("canvas");
      outCanvas.width = job.w;
      outCanvas.height = job.h;
      const outCtx = outCanvas.getContext("2d", { alpha: false });
      const outImg = outCtx.createImageData(job.w, job.h);
      const outData = outImg.data;
      for (let px = 0; px < job.w * job.h; px += 1) {
        outData[px * 4 + 3] = 255;
      }

      if (srcWin.w > 0 && srcWin.h > 0) {
        const src = await deps.renderWindowToImageData(ds, band, srcWin.x0, srcWin.y0, srcWin.w, srcWin.h, 1);
        for (let row = 0; row < srcWin.h; row += 1) {
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

      outCtx.putImageData(outImg, 0, 0);
      drawRulersOnRenderedContext(outCtx, ds, { x0: job.x0, y0: job.y0, w: job.w, h: job.h });
      const base = selectionBaseName(ds, band, job, false);
      if (kind === "png") {
        const blob = await new Promise((res) => outCanvas.toBlob(res, "image/png"));
        deps.downloadBlob(blob, `${base}.png`);
      } else {
        const finalImg = outCtx.getImageData(0, 0, job.w, job.h);
        const blob = encodeRenderedTiff({ imageData: finalImg });
        deps.downloadBlob(blob, `${base}.tiff`);
      }
    }
    deps.setStatus("ready", "ok");
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
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const outCtx = c.getContext("2d", { alpha: false });
    outCtx.putImageData(img, 0, 0);
    drawRulersOnRenderedContext(outCtx, ds, rect);

    if (kind === "png") {
      const blob = await new Promise((res) => c.toBlob(res, "image/png"));
      deps.downloadBlob(blob, `${base}.png`);
      deps.setStatus("ready", "ok");
      return;
    }

    if (kind === "tiff") {
      const finalImg = outCtx.getImageData(0, 0, w, h);
      const blob = encodeRenderedTiff({ imageData: finalImg });
      deps.downloadBlob(blob, `${base}.tiff`);
      deps.setStatus("ready", "ok");
    }
  }

  async function exportRawSelectionJobs(ds, jobs) {
    if (!Array.isArray(jobs) || !jobs.length) return;
    const bpp = ds.meta.dataTypeInfo.bytes;
    const totalBytes = jobs.reduce((sum, job) => sum + (job.w * job.h * ds.meta.bands * bpp), 0);
    if (totalBytes > (1024 * 1024 * 1024)) {
      const ok = deps.confirmFn(`This raw stack export is about ${deps.humanBytes(totalBytes)} and may crash the browser. Continue?`);
      if (!ok) return;
    }

    for (let jobIdx = 0; jobIdx < jobs.length; jobIdx += 1) {
      const job = jobs[jobIdx];
      const srcWin = sourceWindowForJob(ds, job);
      const mask = buildSelectionMask(ds, job);
      const pages = [];
      for (let b = 0; b < ds.meta.bands; b += 1) {
        deps.setStatus(
          jobs.length > 1
            ? `export raw… ${jobIdx + 1}/${jobs.length} (${b + 1}/${ds.meta.bands})`
            : `export raw… ${b + 1}/${ds.meta.bands}`,
          "warn"
        );
        let src = null;
        if (srcWin.w > 0 && srcWin.h > 0) {
          if (ds.meta.interleave === "bip") {
            src = await deps.readBandWindowBIP(ds.meta, ds.ds, b, srcWin.x0, srcWin.y0, srcWin.w, srcWin.h, 1);
          } else {
            src = await deps.readBandWindow(ds.meta, ds.ds, b, srcWin.x0, srcWin.y0, srcWin.w, srcWin.h, 1);
          }
        }
        const Ctor = src ? src.constructor : (ds.meta.dataTypeInfo.ctor || Float64Array);
        const out = new Ctor(job.w * job.h);
        if (src && srcWin.w > 0 && srcWin.h > 0) {
          for (let row = 0; row < srcWin.h; row += 1) {
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
      const blob = encodeRawMultipageTiff({ meta: ds.meta, width: job.w, height: job.h, pages });
      const base = selectionBaseName(ds, ds.activeBand, job, true);
      deps.downloadBlob(blob, `${base}.tiff`);
    }
    deps.setStatus("ready", "ok");
  }

  async function exportRawSelectionJobsENVI(ds, jobs) {
    if (!Array.isArray(jobs) || !jobs.length) return;
    const bpp = ds.meta.dataTypeInfo.bytes;
    const totalBytes = jobs.reduce((sum, job) => sum + (job.w * job.h * ds.meta.bands * bpp), 0);
    if (totalBytes > (1024 * 1024 * 1024)) {
      const ok = deps.confirmFn(`This raw stack export is about ${deps.humanBytes(totalBytes)} and may crash the browser. Continue?`);
      if (!ok) return;
    }

    for (let jobIdx = 0; jobIdx < jobs.length; jobIdx += 1) {
      const job = jobs[jobIdx];
      const srcWin = sourceWindowForJob(ds, job);
      const mask = buildSelectionMask(ds, job);
      const parts = [];
      for (let b = 0; b < ds.meta.bands; b += 1) {
        deps.setStatus(
          jobs.length > 1
            ? `export raw… ${jobIdx + 1}/${jobs.length} (${b + 1}/${ds.meta.bands})`
            : `export raw… ${b + 1}/${ds.meta.bands}`,
          "warn"
        );
        let src = null;
        if (srcWin.w > 0 && srcWin.h > 0) {
          if (ds.meta.interleave === "bip") {
            src = await deps.readBandWindowBIP(ds.meta, ds.ds, b, srcWin.x0, srcWin.y0, srcWin.w, srcWin.h, 1);
          } else {
            src = await deps.readBandWindow(ds.meta, ds.ds, b, srcWin.x0, srcWin.y0, srcWin.w, srcWin.h, 1);
          }
        }
        const Ctor = src ? src.constructor : (ds.meta.dataTypeInfo.ctor || Float64Array);
        const out = new Ctor(job.w * job.h);
        if (src && srcWin.w > 0 && srcWin.h > 0) {
          for (let row = 0; row < srcWin.h; row += 1) {
            const outRow = row + srcWin.offY;
            for (let col = 0; col < srcWin.w; col += 1) {
              const outCol = col + srcWin.offX;
              const outIndex = outRow * job.w + outCol;
              if (!mask[outIndex]) continue;
              out[outIndex] = src[row * srcWin.w + col];
            }
          }
        }
        parts.push(encodeEnviBandBytes(ds.meta, out, RAW_ENVI_LITTLE_ENDIAN));
      }

      const base = selectionBaseName(ds, ds.activeBand, job, true);
      const datName = `${base}.dat`;
      const dataBlob = new Blob(parts, { type: "application/octet-stream" });
      const hdrText = buildEnviHeaderText({
        meta: ds.meta,
        width: job.w,
        height: job.h,
        bands: ds.meta.bands,
        interleave: RAW_ENVI_INTERLEAVE,
        littleEndian: RAW_ENVI_LITTLE_ENDIAN,
        dataFileName: datName
      });
      deps.downloadBlob(dataBlob, datName);
      deps.downloadBlob(new Blob([hdrText], { type: "text/plain;charset=utf-8" }), `${base}.hdr`);
    }
    deps.setStatus("ready", "ok");
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

  async function exportRawStackENVI(ds, rect) {
    const w = rect.w;
    const h = rect.h;
    const bpp = ds.meta.dataTypeInfo.bytes;
    const totalBytes = w * h * ds.meta.bands * bpp;

    if (totalBytes > (1024 * 1024 * 1024)) {
      const ok = deps.confirmFn(`This raw stack is about ${deps.humanBytes(totalBytes)} and may crash the browser. Continue?`);
      if (!ok) return;
    }

    deps.setStatus("export raw…", "warn");
    const parts = [];
    for (let b = 0; b < ds.meta.bands; b += 1) {
      deps.setStatus(`export raw… ${b + 1}/${ds.meta.bands}`, "warn");
      let data;
      if (ds.meta.interleave === "bip") {
        data = await deps.readBandWindowBIP(ds.meta, ds.ds, b, rect.x0, rect.y0, w, h, 1);
      } else {
        data = await deps.readBandWindow(ds.meta, ds.ds, b, rect.x0, rect.y0, w, h, 1);
      }
      parts.push(encodeEnviBandBytes(ds.meta, data, RAW_ENVI_LITTLE_ENDIAN));
    }

    const base = `${ds.name}_${rect.x0}_${rect.y0}_${w}x${h}_rawstack`;
    const datName = `${base}.dat`;
    const hdrText = buildEnviHeaderText({
      meta: ds.meta,
      width: w,
      height: h,
      bands: ds.meta.bands,
      interleave: RAW_ENVI_INTERLEAVE,
      littleEndian: RAW_ENVI_LITTLE_ENDIAN,
      dataFileName: datName
    });
    deps.downloadBlob(new Blob(parts, { type: "application/octet-stream" }), datName);
    deps.downloadBlob(new Blob([hdrText], { type: "text/plain;charset=utf-8" }), `${base}.hdr`);
    deps.setStatus("ready", "ok");
  }

  async function runExportFromDialog() {
    const ds = deps.getActive();
    if (!ds || ds.activeBand == null) return;
    const kind = deps.els.expFormatPng.checked ? "png" : (deps.els.expFormatEnvi?.checked ? "envi" : "tiff");
    deps.state.exportKind = kind;
    const selections = collectAreaSelections(ds);
    const multiSel = selections.length > 1;
    const separateMulti = !!(multiSel && deps.els.expSelModeSeparate && deps.els.expSelModeSeparate.checked);

    try {
      deps.els.exportDlg.close();
    } catch {}

    const rawMode = deps.els.expModeRaw.checked && kind !== "png";
    if (rawMode) {
      const scope = deps.els.expRawScopeWhole.checked ? "whole" : "sel";
      if (scope === "sel" && selections.length) {
        const plan = resolveSelectionExportPlan(ds, selections, separateMulti);
        if (kind === "envi") await exportRawSelectionJobsENVI(ds, plan.jobs);
        else await exportRawSelectionJobs(ds, plan.jobs);
        return;
      }
      const rect = resolveExportRect(ds, scope);
      if (kind === "envi") await exportRawStackENVI(ds, rect);
      else await exportRawStackTIFF(ds, rect);
      return;
    }

    const scope = deps.els.expRenScopeWhole.checked ? "whole" : (deps.els.expRenScopeSel.checked ? "sel" : "view");
    if (scope === "sel" && selections.length) {
      const plan = resolveSelectionExportPlan(ds, selections, separateMulti);
      await exportRenderedSelectionJobs(ds, kind, plan.jobs);
      return;
    }
    const rect = resolveExportRect(ds, scope);
    await exportRendered(ds, kind, rect);
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
    exportRendered,
    exportRawStackTIFF,
    exportRawStackENVI,
    runExportFromDialog
  };
}
