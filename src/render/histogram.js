import {
  applyHistogramDragSetting,
  histogramClientXToRaw,
  histogramHandleXs,
  histogramPlotRect,
  pickHistogramHandle,
  resolveHistogramDisplay
} from "./histogram-math.js";

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
    resolveStats,
    syncRangeInputsFromSettings,
    render
  } = deps;

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
      let raw;
      if (ds.meta.interleave === "bip") {
        raw = await readBandWindowBIP(ds.meta, ds.ds, band, 0, 0, outW, outH, step);
      } else {
        raw = await readBandWindow(ds.meta, ds.ds, band, 0, 0, outW, outH, step);
      }
      const f32 = toFloat32(raw);
      const stats = computeHistogram(f32, 256);
      ds.bandStatsWhole.set(band, stats);

      if (ds.id === state.activeId && ds.activeBand === band && state.histMode === "whole") {
        syncRangeInputsFromSettings(ds, { force: true });
        drawHistogram(ds);
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
    const stats = computeHistogram(ds.lastRaster.dataF32, 256);
    ds.bandStatsView = stats;
    syncRangeInputsFromSettings(ds, { force: true });
    drawHistogram(ds);
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

    const b = ds?.activeBand;
    const s = (ds && b != null) ? getBandSettings(ds, b) : null;
    const stats = (ds && b != null) ? resolveStats(ds) : null;

    ctx.fillStyle = "rgba(17,24,39,0.92)";
    ctx.fillRect(0, 0, w, h);
    if (!ds || !s || !stats || !stats.bins) {
      ctx.fillStyle = "rgba(209,213,219,0.9)";
      ctx.font = `${12 * dpr}px ${getComputedStyle(document.body).fontFamily}`;
      ctx.fillText("Histogram not ready (select a band)", 10 * dpr, 20 * dpr);
      ctx.restore();
      return;
    }

    const bins = stats.bins;
    const maxBin = Math.max(1, ...bins);
    const plot = histogramPlotRect(w, h, dpr);
    const { plotX0, plotY0, plotW, plotH } = plot;

    ctx.fillStyle = "rgba(156,163,175,0.35)";
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
    const s = getBandSettings(ds, ds.activeBand);
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

    const s = getBandSettings(ds, ds.activeBand);
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
    drawHistogram,
    histPickHandle,
    applyHistogramDrag
  };
}
