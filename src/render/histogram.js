import {
  applyHistogramDragSetting,
  histogramClientXToRaw,
  histogramHandleXs,
  histogramPlotRect,
  pickHistogramHandle,
  resolveHistogramDisplay
} from "./histogram-math.js";
import { createFloat32ScratchPool } from "../core/float-scratch.js";
import { APP_CONFIG } from "../app/config.js";
import { histogramFromReduction } from "./display-math.js";
import { ANALYSIS_BATCH_VALUES, createAnalysisPlan } from "../core/analysis-batches.js";
import { streamStatistics } from "../core/stream-statistics.js";

function isAbortError(error) {
  return error?.name === "AbortError";
}

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
    render,
    getActiveViewportDevice,
    getDevicePixelRatio
  } = deps;
  const floatScratchPool = createFloat32ScratchPool({
    maxRetainedBytes: ANALYSIS_BATCH_VALUES * 8,
    maxRetainedBuffers: APP_CONFIG.scratch.histogram.maxRetainedBuffers,
    maxRetainedElements: APP_CONFIG.scratch.histogram.maxRetainedElements
  });

  function resolveDisplayBand(ds) {
    if (!ds) return null;
    return (typeof getDisplayBand === "function") ? getDisplayBand(ds) : ds.activeBand;
  }

  function getWholeStatsPendingMap(ds) {
    if (!ds) return null;
    if (!ds.__wholeStatsPending || typeof ds.__wholeStatsPending.get !== "function") {
      ds.__wholeStatsPending = new Map();
    }
    return ds.__wholeStatsPending;
  }

  function resolveHistogramViewRaster(ds, band, rasterOverride = null) {
    if (!ds || band == null) return null;
    if (rasterOverride?.band === band && rasterOverride?.dataF32?.length) return rasterOverride;
    const compositeRaster = ds.lastCompositeRaster?.rasterByBand?.get?.(band) || null;
    if (compositeRaster?.dataF32?.length) return compositeRaster;
    if (ds.lastRaster?.band === band && ds.lastRaster?.dataF32?.length) return ds.lastRaster;
    return null;
  }

  function decorateHistogramStats(stats, metadata = {}) {
    if (!stats) return null;
    return {
      ...stats,
      band: Number.isFinite(metadata.band) ? metadata.band : null,
      sampleStep: Number.isFinite(metadata.sampleStep) ? metadata.sampleStep : 1,
      trueRawSamples: metadata.trueRawSamples !== false,
      samplingMode: metadata.samplingMode || "raw"
    };
  }

  // Compatibility for providers exposing only the original compact histogram
  // operation. The streaming driver otherwise uses reduceStatisticsWindow.
  function canReduce(ds, count) {
    return ds.meta.dataType === 1 && count >= 262144 && typeof ds.ds?.reduceBandWindow === "function";
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

  async function readWindowF32(ds, band, x0, y0, outW, outH, step, options = null) {
    const length = Math.max(0, outW * outH);
    const scratch = floatScratchPool.acquire(length);
    try {
      const raw = ds.meta.interleave === "bip"
        ? await readBandWindowBIP(ds.meta, ds.ds, band, x0, y0, outW, outH, step, scratch, options)
        : await readBandWindow(ds.meta, ds.ds, band, x0, y0, outW, outH, step, scratch, options);
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

  async function computeSelectionStats(ds, band, selections, options = null) {
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
    if (!ds.ds?.reduceStatisticsWindow && valid.length === 1 && valid[0].selection.tool === "rect") {
      const { bounds, width, height } = valid[0];
      const outW = Math.ceil(width / step), outH = Math.ceil(height / step);
      if (canReduce(ds, outW * outH)) {
        const reduced = await ds.ds.reduceBandWindow(ds.meta, band, bounds.x0, bounds.y0, outW, outH, step,
          options || {});
        return reduced.count ? decorateHistogramStats(histogramFromReduction(reduced), {
          band, sampleStep: step, trueRawSamples: step === 1,
          samplingMode: step === 1 ? "selection-raw" : "selection-subsampled"
        }) : null;
      }
    }
    const plan = createAnalysisPlan(valid.map(({ selection, bounds, width, height }) => ({
      selection, bounds, outW: Math.ceil(width / step), outH: Math.ceil(height / step)
    })), step, (selection, x, y) => pointInPolygon(x, y, selection.points));
    const stats = await streamStatistics({ ds, band, plan, histogram: true,
      cancelled: options?.cancelled, onProgress: options?.onProgress,
      readWindow: (batch, readOptions) => readWindowF32(ds, band, batch.x0, batch.y0,
        batch.outW, batch.outH, step, readOptions) });
    return stats.count ? decorateHistogramStats(stats, {
      band, sampleStep: step, trueRawSamples: step === 1,
      samplingMode: step === 1 ? "selection-raw" : "selection-subsampled"
    }) : null;
  }

  async function streamWindowHistogram(ds, band, x0, y0, outW, outH, step, options = {}) {
    if (!ds.ds?.reduceStatisticsWindow && canReduce(ds, outW * outH)) {
      return histogramFromReduction(await ds.ds.reduceBandWindow(ds.meta, band, x0, y0, outW, outH, step, options));
    }
    const plan = createAnalysisPlan([{ bounds: { x0, y0 }, outW, outH }], step);
    return streamStatistics({ ds, band, plan, histogram: true, ...options,
      readWindow: (batch, readOptions) => readWindowF32(ds, band, batch.x0, batch.y0,
        batch.outW, batch.outH, step, readOptions) });
  }

  async function buildBandStatsWhole(ds, band) {
    if (!ds || band == null) return;
    if (ds.bandStatsWhole.has(band)) return;
    const pending = getWholeStatsPendingMap(ds);
    const existing = pending?.get(band);
    if (existing) {
      await existing;
      return;
    }

    const target = 512;
    const stepX = Math.ceil(ds.meta.samples / target);
    const stepY = Math.ceil(ds.meta.lines / target);
    const step = Math.max(1, Math.max(stepX, stepY));
    const outW = Math.min(target, Math.ceil(ds.meta.samples / step));
    const outH = Math.min(target, Math.ceil(ds.meta.lines / step));
    const task = (async () => {
      try {
        setStatus("histogram…", "warn");
        const stats = decorateHistogramStats(
          await streamWindowHistogram(ds, band, 0, 0, outW, outH, step), {
            band, sampleStep: step, trueRawSamples: step === 1,
            samplingMode: step === 1 ? "whole-raw" : "whole-subsampled"
          });
        if (ds.ds?.closed) return;
        ds.bandStatsWhole.set(band, stats);
        if (ds.id === state.activeId && resolveDisplayBand(ds) === band && state.histMode === "whole") {
          syncRangeInputsFromSettings(ds);
          drawHistogram(ds);
        }
        setStatus("ready", "ok");
      } catch (e) {
        console.warn("Histogram build failed", e);
        setStatus("ready", "ok");
      } finally {
        pending?.delete(band);
      }
    })();
    pending?.set(band, task);
    await task;
  }

  function estimatedViewKey(ds, band) {
    if (!ds || band == null) return "";
    const dpr = typeof getDevicePixelRatio === "function" ? (Number(getDevicePixelRatio()) || 1) : (window.devicePixelRatio || 1);
    const viewport = typeof getActiveViewportDevice === "function"
      ? getActiveViewportDevice()
      : null;
    const viewW = Math.max(1, Number(viewport?.width || viewport?.w || 0) || 1);
    const viewH = Math.max(1, Number(viewport?.height || viewport?.h || 0) || 1);
    return [
      band,
      Math.round(Number(ds.view?.x || 0)),
      Math.round(Number(ds.view?.y || 0)),
      Math.round((Number(ds.view?.scale || 1) || 1) * 1000),
      Math.round(viewW),
      Math.round(viewH),
      Math.round(dpr * 100)
    ].join(":");
  }

  async function buildEstimatedViewHistogram(ds) {
    if (!ds) return;
    const band = resolveDisplayBand(ds);
    if (band == null || ds.bandStatsWhole?.has?.(band)) return;
    const key = estimatedViewKey(ds, band);
    if (!key) return;
    if (!ds.__viewStatsPending || typeof ds.__viewStatsPending.get !== "function") {
      ds.__viewStatsPending = new Map();
    }
    if (ds.__viewStatsPending.has(key)) {
      await ds.__viewStatsPending.get(key);
      return;
    }

    const dpr = typeof getDevicePixelRatio === "function" ? (Number(getDevicePixelRatio()) || 1) : (window.devicePixelRatio || 1);
    const viewport = typeof getActiveViewportDevice === "function"
      ? getActiveViewportDevice()
      : null;
    const viewportW = Math.max(1, Number(viewport?.width || viewport?.w || 0) || 1);
    const viewportH = Math.max(1, Number(viewport?.height || viewport?.h || 0) || 1);
    const eff = Math.max(1e-9, (Number(ds.view?.scale) || 1) * dpr);
    const maxX = Math.max(0, Math.floor(Number(ds.meta?.samples || 1)) - 1);
    const maxY = Math.max(0, Math.floor(Number(ds.meta?.lines || 1)) - 1);
    const x0 = Math.max(0, Math.min(maxX, Math.floor(Number(ds.view?.x) || 0)));
    const y0 = Math.max(0, Math.min(maxY, Math.floor(Number(ds.view?.y) || 0)));
    const x1 = Math.max(0, Math.min(maxX, Math.ceil((Number(ds.view?.x) || 0) + (viewportW / eff))));
    const y1 = Math.max(0, Math.min(maxY, Math.ceil((Number(ds.view?.y) || 0) + (viewportH / eff))));
    const srcW = Math.max(1, x1 - x0 + 1);
    const srcH = Math.max(1, y1 - y0 + 1);
    const target = 512;
    const stepX = Math.ceil(srcW / target);
    const stepY = Math.ceil(srcH / target);
    const stepByArea = Math.ceil(Math.sqrt((srcW * srcH) / 700_000));
    const step = Math.max(1, stepX, stepY, stepByArea);
    const outW = Math.max(1, Math.ceil(srcW / step));
    const outH = Math.max(1, Math.ceil(srcH / step));

    const task = (async () => {
      try {
        const stats = await streamWindowHistogram(ds, band, x0, y0, outW, outH, step, {
          cancelled: () => estimatedViewKey(ds, band) !== key
        });
        if (estimatedViewKey(ds, band) !== key || ds.ds?.closed) return;
        ds.bandStatsView = decorateHistogramStats(stats, {
          band, sampleStep: step, trueRawSamples: false,
          samplingMode: step === 1 ? "view-estimated" : "view-subsampled"
        });
        if (ds.id === state.activeId && resolveDisplayBand(ds) === band && !ds.bandStatsWhole.has(band)) {
          syncRangeInputsFromSettings(ds);
          drawHistogram(ds);
        }
      } catch (e) {
        if (isAbortError(e) && estimatedViewKey(ds, band) !== key) return;
        console.warn("Estimated view histogram failed", e);
      } finally {
        ds.__viewStatsPending?.delete?.(key);
      }
    })();
    ds.__viewStatsPending.set(key, task);
    await task;
  }

  function ensureViewHistogram(ds, rasterOverride = null) {
    if (!ds) return;
    const b = resolveDisplayBand(ds);
    const raster = resolveHistogramViewRaster(ds, b, rasterOverride);
    if (!raster) return;
    const step = Number.isFinite(raster.step) ? raster.step : 1;
    const stats = decorateHistogramStats(
      raster.histogramStats || computeHistogram(raster.dataF32, 256),
      {
        band: b,
        sampleStep: step,
        trueRawSamples: step <= 1 && !raster.approximate && !raster.partial && Number(raster.level || 0) <= 0,
        samplingMode: (raster.approximate || raster.partial || step > 1 || Number(raster.level || 0) > 0)
          ? "view-estimated"
          : "view-raster"
      }
    );
    ds.bandStatsView = stats;
    syncRangeInputsFromSettings(ds);
    drawHistogram(ds);
  }

  async function updateSelectionHistogram(ds, selections, onProgress) {
    if (!ds) return;
    const band = resolveDisplayBand(ds);
    const list = Array.isArray(selections) ? selections.filter((item) => isHistogramSelection(item)) : [];
    const selectionKey = selectionKeyFromItems(list);
    const token = (ds.__selectionHistToken || 0) + 1;
    ds.__selectionHistToken = token;

    if (!list.length || band == null) {
      ds.bandStatsSelection = null;
      if (ds.id === state.activeId) {
        syncRangeInputsFromSettings(ds);
        drawHistogram(ds);
      }
      return;
    }

    try {
      setStatus("histogram…", "warn");
      const stats = await computeSelectionStats(ds, band, list, {
        cancelled: () => token !== ds.__selectionHistToken,
        priority: "background", onProgress
      });
      if (token !== ds.__selectionHistToken) return;
      ds.bandStatsSelection = stats ? { band, selectionKey, stats } : null;
      if (ds.id === state.activeId) {
        syncRangeInputsFromSettings(ds);
        drawHistogram(ds);
      }
      setStatus("ready", "ok");
    } catch (e) {
      if (isAbortError(e) && token !== ds.__selectionHistToken) return;
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
      syncRangeInputsFromSettings(ds);
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
    if (stats.trueRawSamples === false || String(stats.samplingMode || "").includes("estimated") || Number(stats.sampleStep || 1) > 1) {
      ctx.fillStyle = "rgba(17,24,39,0.72)";
      ctx.fillRect(plotX0 + (4 * dpr), plotY0 + (4 * dpr), 62 * dpr, 18 * dpr);
      ctx.fillStyle = "rgba(253,224,71,0.96)";
      ctx.font = `${11 * dpr}px ${getComputedStyle(document.body).fontFamily}`;
      ctx.fillText("Estimated", plotX0 + (8 * dpr), plotY0 + (17 * dpr));
    }
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
    buildEstimatedViewHistogram,
    ensureViewHistogram,
    updateSelectionHistogram,
    clearSelectionHistogram,
    drawHistogram,
    histPickHandle,
    applyHistogramDrag
  };
}
