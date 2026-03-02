import { clamp } from "../core/utils.js";

export function histogramPlotRect(canvasWidth, canvasHeight, dpr) {
  const pad = 10 * dpr;
  return {
    pad,
    plotX0: pad,
    plotY0: pad,
    plotW: canvasWidth - 2 * pad,
    plotH: canvasHeight - 2 * pad
  };
}

export function resolveHistogramDisplay(stats, settings) {
  const domMin = stats.min;
  const domMax = stats.max;
  const minVal = (settings.min != null && Number.isFinite(settings.min)) ? settings.min : stats.p1;
  const maxVal = (settings.max != null && Number.isFinite(settings.max)) ? settings.max : stats.p99;
  const gamma = settings.gamma ?? 1;
  const gain = settings.gain ?? 1;
  const contrast = settings.contrast ?? 1;
  return { domMin, domMax, minVal, maxVal, gamma, gain, contrast };
}

export function histogramHandleXs(plot, domMin, domMax, minVal, maxVal, gamma) {
  const range = Math.max(1e-12, domMax - domMin);
  const xMin = plot.plotX0 + ((minVal - domMin) / range) * plot.plotW;
  const xMax = plot.plotX0 + ((maxVal - domMin) / range) * plot.plotW;
  const midT = Math.pow(0.5, 1 / Math.max(1e-6, gamma));
  const midVal = minVal + midT * (maxVal - minVal);
  const xMid = plot.plotX0 + ((midVal - domMin) / range) * plot.plotW;
  return { xMin, xMid, xMax };
}

export function pickHistogramHandle(plot, x, y, xMin, xMid, xMax, dpr) {
  const tol = 10 * dpr;
  if (y < plot.plotY0 || y > plot.plotY0 + plot.plotH + 16 * dpr) return null;

  const dMin = Math.abs(x - xMin);
  const dMid = Math.abs(x - xMid);
  const dMax = Math.abs(x - xMax);
  const best = Math.min(dMin, dMid, dMax);
  if (best > tol) return null;
  if (best === dMid) return "mid";
  if (best === dMin) return "min";
  return "max";
}

export function histogramClientXToRaw(stats, clientX, rectLeft, dpr, canvasWidth) {
  const px = (clientX - rectLeft) * dpr;
  const pad = 10 * dpr;
  const plotX0 = pad;
  const plotW = canvasWidth - 2 * pad;
  const t = clamp((px - plotX0) / plotW, 0, 1);
  return stats.min + t * (stats.max - stats.min);
}

export function applyHistogramDragSetting(stats, settings, kind, raw) {
  const currentMin = (settings.min != null && Number.isFinite(settings.min)) ? settings.min : stats.p1;
  const currentMax = (settings.max != null && Number.isFinite(settings.max)) ? settings.max : stats.p99;

  if (kind === "min") {
    return { min: clamp(raw, stats.min, currentMax) };
  }
  if (kind === "max") {
    return { max: clamp(raw, currentMin, stats.max) };
  }
  if (kind === "mid") {
    const lo = currentMin;
    const hi = currentMax;
    const mid = clamp(raw, lo, hi);
    const t = clamp((mid - lo) / Math.max(1e-12, (hi - lo)), 0.001, 0.999);
    const gamma = Math.log(0.5) / Math.log(t);
    return { gamma: clamp(gamma, 0.10, 5.0) };
  }
  return {};
}
