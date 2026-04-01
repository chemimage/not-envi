import {
  applyHistogramDragSetting,
  histogramClientXToRaw,
  histogramHandleXs,
  histogramPlotRect,
  pickHistogramHandle,
  resolveHistogramDisplay
} from "./histogram-math.js";
import { createFloat32ScratchPool } from "../core/float-scratch.js";

export function createHistogramController(deps) {
  const {
    state,
    els,
    setStatus,
    readBandWindow,
    readBandWindowBIP,
    toFloat32,
    computeHistogram,
    tone01,
    getBandSettings,
    getDisplayBand,
    getDisplayColor,
    resolveStats,
    syncRangeInputsFromSettings,
    render
  } = deps;
  const floatScratchPool = createFloat32ScratchPool({
    maxRetainedBuffers: 2,
    maxRetainedElements: 1_048_576
  });

  function resolveDisplayBand(ds) {
    if (!ds) return null;
    return (typeof getDisplayBand === "function") ? getDisplayBand(ds) : ds.activeBand;
  }

  function decorateHistogramStats(stats, metadata = {}) {
    if (!stats) return null;
    return {
      ...stats,
      sampleStep: Number.isFinite(metadata.sampleStep) ? metadata.sampleStep : 1,
      trueRawSamples: metadata.trueRawSamples !== false,
      samplingMode: metadata.samplingMode || "raw"
    };
  }

  function resolveBarFillStyle(ds) {
    const color = (typeof getDisplayColor === "function") ? getDisplayColor(ds) : null;
    if (color === "red") return "rgb(252 165 165 / 0.96)";
    if (color === "green") return "rgb(134 239 172 / 0.96)";
    if (color === "blue") return "rgb(147 197 253 / 0.96)";
    return "rgba(156,163,175,0.35)";
  }

  function pointInPolygon(x, y, points) {
    let inside = false;
    const n = points.length;
    for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
      const pi = points[i];
      const pj = points[j];
      const intersects = ((pi.y > y) !== (pj.y > y))
        && (x < (((pj.x - pi.x) * (y - pi.y)) / Math.max(1e-12, (pj.y - pi.y)) + pi.x));
      if (intersects) inside = !inside;
    }
    return inside;
  }

  function isHistogramSelection(item) {
    return !!(item && (item.tool === "rect" || item.tool === "shape"));
  }

  function selectionKeyFromItems(items) {
    if (!Array.isArray(items) || !items.length) return "";
    return items
      .filter((item) => isHistogramSelection(item) && Number.isFinite(item.id))
      .sort((a, b) => a.id - b.id)
      .map((item) => String(item.id))
      .join(",");
  }

  function resolveSelectionBounds(ds, selection) {
    if (!selection || !Array.isArray(selection.points) || selection.points.length < 2) return null;
    const maxX = Math.max(0, ds.meta.samples - 1);
    const maxY = Math.max(0, ds.meta.lines - 1);

    if (selection.tool === "rect") {
      const a = selection.points[0];
      const b = selection.points[selection.points.length - 1];
      const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x)));
      const x1 = Math.min(maxX, Math.ceil(Math.max(a.x, b.x)));
      const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y)));
      const y1 = Math.min(maxY, Math.ceil(Math.max(a.y, b.y)));
      if (x1 < x0 || y1 < y0) return null;
      return { x0, y0, x1, y1 };
    }

    if (selection.tool === "shape") {
      if (selection.points.length < 3) return null;
      let x0 = Number.POSITIVE_INFINITY;
      let y0 = Number.POSITIVE_INFINITY;
      let x1 = Number.NEGATIVE_INFINITY;
      let y1 = Number.NEGATIVE_INFINITY;
      for (const p of selection.points) {
        if (!p) continue;
        if (p.x < x0) x0 = p.x;
        if (p.y < y0) y0 = p.y;
        if (p.x > x1) x1 = p.x;
        if (p.y > y1) y1 = p.y;
      }
      x0 = Math.max(0, Math.floor(x0));
      y0 = Math.max(0, Math.floor(y0));
      x1 = Math.min(maxX, Math.ceil(x1));
      y1 = Math.min(maxY, Math.ceil(y1));
      if (x1 < x0 || y1 < y0) return null;
      return { x0, y0, x1, y1 };
    }

    return null;
  }

  function appendSelectionValues(selection, f32, outW, outH, x0, y0, step, rowStride, seen, values) {
    if (!selection || !f32 || !values) return;
    const isShape = selection.tool === "shape" && Array.isArray(selection.points) && selection.points.length >= 3;
    for (let row = 0; row < outH; row += 1) {
      const iy = y0 + row * step;
      for (let col = 0; col < outW; col += 1) {
        const ix = x0 + col * step;
        if (isShape) {
          const cx = ix + (0.5 * step);
          const cy = iy + (0.5 * step);
          if (!pointInPolygon(cx, cy, selection.points)) continue;
        }
        const key = iy * rowStride + ix;
        if (seen.has(key)) continue;
        seen.add(key);
        ensureSelectionValueCapacity(values, values.length + 1);
        values.buffer[values.length] = f32[row * outW + col];
        values.length += 1;
      }
    }
  }

  function ensureSelectionValueCapacity(values, needed) {
    if (!values || values.buffer.length >= needed) return;
    const nextSize = Math.max(needed, values.buffer.length ? values.buffer.length * 2 : 1024);
    const next = new Float32Array(nextSize);
    if (values.length > 0) next.set(values.buffer.subarray(0, values.length), 0);
    values.buffer = next;
  }

  async function readWindowF32(ds, band, x0, y0, outW, outH, step) {
    const length = Math.max(0, outW * outH);
    const scratch = floatScratchPool.acquire(length);
    try {
      const raw = ds.meta.interleave === "bip"
        ? await readBandWindowBIP(ds.meta, ds.ds, band, x0, y0, outW, outH, step, scratch)
        : await readBandWindow(ds.meta, ds.ds, band, x0, y0, outW, outH, step, scratch);
      return {
        data: raw === scratch ? scratch : toFloat32(raw, scratch),
        release() {
          floatScratchPool.release(scratch);
        }
      };
    } catch (err) {
      floatScratchPool.release(scratch);
      throw err;
    }
  }

  async function computeSelectionStats(ds, band, selections) {
    if (!ds || band == null || !Array.isArray(selections) || !selections.length) return null;

    const valid = [];
    let totalArea = 0;
    for (const selection of selections) {
      if (!isHistogramSelection(selection)) continue;
      const bounds = resolveSelectionBounds(ds, selection);
      if (!bounds) continue;
      const width = bounds.x1 - bounds.x0 + 1;
      const height = bounds.y1 - bounds.y0 + 1;
      if (width <= 0 || height <= 0) continue;
      valid.push({ selection, bounds, width, height });
      totalArea += width * height;
    }
    if (!valid.length) return null;

    const targetSamples = 700_000;
    const step = Math.max(1, Math.ceil(Math.sqrt(totalArea / targetSamples)));
    const seen = new Set();
    const estimatedSamples = Math.max(1, Math.ceil(totalArea / Math.max(1, step * step)));
    const values = {
      buffer: new Float32Array(estimatedSamples),
      length: 0
    };

    for (const item of valid) {
      const { selection, bounds, width, height } = item;
      const outW = Math.max(1, Math.ceil(width / step));
      const outH = Math.max(1, Math.ceil(height / step));
      const window = await readWindowF32(ds, band, bounds.x0, bounds.y0, outW, outH, step);
      try {
        appendSelectionValues(selection, window.data, outW, outH, bounds.x0, bounds.y0, step, ds.meta.samples, seen, values);
      } finally {
        window.release();
      }
    }

    if (!values.length) return null;
    const samples = values.length === values.buffer.length
      ? values.buffer
      : values.buffer.subarray(0, values.length);
    return decorateHistogramStats(
      computeHistogram(samples, 256),
      {
        sampleStep: step,
        trueRawSamples: step === 1,
        samplingMode: step === 1 ? "selection-raw" : "selection-subsampled"
      }
    );
  }

  async function buildBandStatsWhole(ds, band) {
    if (!ds || band == null) return;
    if (ds.bandStatsWhole.has(band)) return;

    const target = 512;
    const stepX = Math.ceil(ds.meta.samples / target);
    const stepY = Math.ceil(ds.meta.lines / target);
    const step = Math.max(1, Math.max(stepX, stepY));
    const outW = Math.min(target, Math.ceil(ds.meta.samples / step));
    const outH = Math.min(target, Math.ceil(ds.meta.lines / step));

    try {
      setStatus("histogram…", "warn");
      const window = await readWindowF32(ds, band, 0, 0, outW, outH, step);
      try {
        const stats = decorateHistogramStats(
          computeHistogram(window.data, 256),
          {
            sampleStep: step,
            trueRawSamples: step === 1,
            samplingMode: step === 1 ? "whole-raw" : "whole-subsampled"
          }
        );
        ds.bandStatsWhole.set(band, stats);

        if (ds.id === state.activeId && ds.activeBand === band && state.histMode === "whole") {
          syncRangeInputsFromSettings(ds, { force: true });
          drawHistogram(ds);
        }
      } finally {
        window.release();
      }
      setStatus("ready", "ok");
    } catch (e) {
      console.warn("Histogram build failed", e);
      setStatus("ready", "ok");
    }
  }

  function ensureViewHistogram(ds) {
    if (!ds || !ds.lastRaster) return;
    const b = ds.activeBand;
    if (b == null || ds.lastRaster.band !== b) return;
    const stats = decorateHistogramStats(
      computeHistogram(ds.lastRaster.dataF32, 256),
      {
        sampleStep: Number.isFinite(ds.lastRaster.step) ? ds.lastRaster.step : 1,
        trueRawSamples: false,
        samplingMode: "view-raster"
      }
    );
    ds.bandStatsView = stats;
    syncRangeInputsFromSettings(ds, { force: true });
    drawHistogram(ds);
  }

  async function updateSelectionHistogram(ds, selections) {
    if (!ds) return;
    const band = ds.activeBand;
    const list = Array.isArray(selections) ? selections.filter((item) => isHistogramSelection(item)) : [];
    const selectionKey = selectionKeyFromItems(list);
    const token = (ds.__selectionHistToken || 0) + 1;
    ds.__selectionHistToken = token;

    if (!list.length || band == null) {
      ds.bandStatsSelection = null;
      if (ds.id === state.activeId) {
        syncRangeInputsFromSettings(ds, { force: true });
        drawHistogram(ds);
      }
      return;
    }

    try {
      setStatus("histogram…", "warn");
      const stats = await computeSelectionStats(ds, band, list);
      if (token !== ds.__selectionHistToken) return;
      ds.bandStatsSelection = stats ? { band, selectionKey, stats } : null;
      if (ds.id === state.activeId) {
        syncRangeInputsFromSettings(ds, { force: true });
        drawHistogram(ds);
      }
      setStatus("ready", "ok");
    } catch (e) {
      console.warn("Selection histogram build failed", e);
      if (token !== ds.__selectionHistToken) return;
      ds.bandStatsSelection = null;
      if (ds.id === state.activeId) drawHistogram(ds);
      setStatus("ready", "ok");
    }
  }

  function clearSelectionHistogram(ds) {
    if (!ds) return;
    ds.__selectionHistToken = (ds.__selectionHistToken || 0) + 1;
    ds.bandStatsSelection = null;
    if (ds.id === state.activeId) {
      syncRangeInputsFromSettings(ds, { force: true });
      drawHistogram(ds);
    }
  }

  function drawHistogram(ds) {
    const canvas = els.hist;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d", { alpha: true });
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const b = resolveDisplayBand(ds);
    const s = (ds && b != null) ? getBandSettings(ds, b) : null;
    const stats = (ds && b != null) ? resolveStats(ds) : null;

    ctx.fillStyle = "rgba(17,24,39,0.92)";
    ctx.fillRect(0, 0, w, h);
    if (!ds || !s || !stats || !stats.bins) {
      ctx.fillStyle = "rgba(209,213,219,0.9)";
      ctx.font = `${12 * dpr}px ${getComputedStyle(document.body).fontFamily}`;
      ctx.fillText("Histogram not ready", 10 * dpr, 20 * dpr);
      ctx.restore();
      return;
    }

    const bins = stats.bins;
    const maxBin = Math.max(1, ...bins);
    const plot = histogramPlotRect(w, h, dpr);
    const { plotX0, plotY0, plotW, plotH } = plot;

    ctx.fillStyle = resolveBarFillStyle(ds);
    for (let i = 0; i < bins.length; i++) {
      const t = i / (bins.length - 1);
      const x = plotX0 + t * plotW;
      const barH = (bins[i] / maxBin) * plotH;
      ctx.fillRect(x, plotY0 + (plotH - barH), Math.max(1, plotW / bins.length), barH);
    }

    const { domMin, domMax, minVal, maxVal, brightness, gain, contrast } = resolveHistogramDisplay(stats, s);
    const { xMin, xMax } = histogramHandleXs(plot, domMin, domMax, minVal, maxVal);
    ctx.fillStyle = "rgba(75,85,99,0.30)";
    ctx.fillRect(Math.min(xMin, xMax), plotY0, Math.abs(xMax - xMin), plotH);

    ctx.strokeStyle = "rgba(229,231,235,0.95)";
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    for (let ix = 0; ix <= 256; ix++) {
      const t = ix / 256;
      const raw = domMin + t * (domMax - domMin);
      const y01 = tone01(raw, minVal, maxVal, brightness, gain, contrast);
      const x = plotX0 + t * plotW;
      const y = plotY0 + (1 - y01) * plotH;
      if (ix === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    function drawHandle(x, kind) {
      ctx.strokeStyle = "rgba(229,231,235,0.9)";
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.moveTo(x, plotY0);
      ctx.lineTo(x, plotY0 + plotH);
      ctx.stroke();

      const r = 6 * dpr;
      const y = plotY0 + plotH + 0.5 * r;
      ctx.fillStyle = "rgba(156,163,175,0.95)";
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(31,41,55,0.95)";
      ctx.stroke();
    }

    drawHandle(xMin, "min");
    drawHandle(xMax, "max");
    ctx.strokeStyle = "rgba(75,85,99,0.85)";
    ctx.lineWidth = 1 * dpr;
    ctx.strokeRect(plotX0, plotY0, plotW, plotH);
    ctx.restore();
  }

  function histPickHandle(ds, px, py) {
    const canvas = els.hist;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const x = (px - rect.left) * dpr;
    const y = (py - rect.top) * dpr;
    const stats = resolveStats(ds);
    if (!stats) return null;

    const plot = histogramPlotRect(canvas.width, canvas.height, dpr);
    const band = resolveDisplayBand(ds);
    if (band == null) return null;
    const s = getBandSettings(ds, band);
    const { domMin, domMax, minVal, maxVal } = resolveHistogramDisplay(stats, s);
    const { xMin, xMax } = histogramHandleXs(plot, domMin, domMax, minVal, maxVal);
    return pickHistogramHandle(plot, x, y, xMin, xMax, dpr);
  }

  function histXToRaw(ds, clientX) {
    const stats = resolveStats(ds);
    if (!stats) return null;
    const canvas = els.hist;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    return histogramClientXToRaw(stats, clientX, rect.left, dpr, canvas.width);
  }

  function applyHistogramDrag(ds, kind, clientX) {
    const stats = resolveStats(ds);
    if (!stats) return;
    const raw = histXToRaw(ds, clientX);
    if (raw == null) return;

    const band = resolveDisplayBand(ds);
    if (band == null) return;
    const s = getBandSettings(ds, band);
    const patch = applyHistogramDragSetting(stats, s, kind, raw);
    if (patch.min != null) s.min = patch.min;
    if (patch.max != null) s.max = patch.max;
    syncRangeInputsFromSettings(ds, { force: true });
    drawHistogram(ds);
    render({ reuseRaster: true });
  }

  return {
    buildBandStatsWhole,
    ensureViewHistogram,
    updateSelectionHistogram,
    clearSelectionHistogram,
    drawHistogram,
    histPickHandle,
    applyHistogramDrag
  };
}
