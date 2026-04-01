import { fmtNoGroup } from "../core/utils.js";

export function formatAxisNumber(v) {
  const a = Math.abs(v);
  if (!Number.isFinite(v)) return "—";
  if (a >= 1000) return fmtNoGroup(Math.round(v));
  if (a >= 100) return v.toFixed(1);
  if (a >= 10) return v.toFixed(2);
  return v.toFixed(3);
}

export function isCmInverseUnit(unit) {
  const raw = String(unit || "").trim().toLowerCase();
  if (!raw) return false;
  const normalized = raw.replace(/[−–]/g, "-").replace(/\s+/g, "");
  return normalized.includes("wavenumber")
    || normalized.includes("cm-1")
    || normalized.includes("cm^-1")
    || normalized.includes("cm⁻1")
    || normalized.includes("1/cm");
}

export function medianBandInterval(xVals) {
  if (!xVals || xVals.length < 2) return null;
  const steps = [];
  for (let i = 1; i < xVals.length; i += 1) {
    const a = Number(xVals[i - 1]);
    const b = Number(xVals[i]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const d = Math.abs(b - a);
    if (d > 0) steps.push(d);
  }
  if (!steps.length) return null;
  steps.sort((a, b) => a - b);
  const mid = Math.floor(steps.length / 2);
  if (steps.length % 2 === 1) return steps[mid];
  return (steps[mid - 1] + steps[mid]) * 0.5;
}

export function hasApproximatelyUniformBandIntervals(
  xVals,
  {
    absoluteTolerance = 1,
    relativeTolerance = 0.05,
    minConsistentFraction = 0.85
  } = {}
) {
  if (!xVals || xVals.length < 3) return false;
  const med = medianBandInterval(xVals);
  if (!Number.isFinite(med) || med <= 0) return false;
  const steps = [];
  for (let i = 1; i < xVals.length; i += 1) {
    const a = Number(xVals[i - 1]);
    const b = Number(xVals[i]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const d = Math.abs(b - a);
    if (d > 0) steps.push(d);
  }
  if (steps.length < 2) return false;
  const tolerance = Math.max(absoluteTolerance, med * relativeTolerance);
  let consistent = 0;
  for (const step of steps) {
    if (Math.abs(step - med) <= tolerance) consistent += 1;
  }
  return (consistent / steps.length) >= minConsistentFraction;
}

export function shouldUseBarSpectrumPlot(xVals, wlUnits, options = undefined) {
  if (!isCmInverseUnit(wlUnits)) return false;
  return !hasApproximatelyUniformBandIntervals(xVals, options);
}

function inferCmInverseUnitFromEntries(entries) {
  if (!Array.isArray(entries)) return "";
  for (let i = 0; i < entries.length; i += 1) {
    const raw = entries[i];
    if (raw == null) continue;
    const text = String(raw).trim();
    if (!text) continue;
    if (isCmInverseUnit(text)) return "cm-1";
  }
  return "";
}

export function resolveSpectralUnit(ds) {
  const explicit = (ds?.meta?.wlUnits && String(ds.meta.wlUnits).trim())
    ? String(ds.meta.wlUnits).trim()
    : "";
  if (explicit) return explicit;
  return inferCmInverseUnitFromEntries(ds?.meta?.wavelengths);
}

export function resolveUniformBarWidthPx(bandCenters, plotW) {
  if (!bandCenters || !bandCenters.length) return Math.max(1, plotW * 0.72);
  const finiteCenters = Array.from(bandCenters)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!finiteCenters.length) return Math.max(1, plotW * 0.72);
  const fallbackGap = plotW / Math.max(1, finiteCenters.length);
  let minGap = Number.POSITIVE_INFINITY;
  for (let i = 1; i < finiteCenters.length; i += 1) {
    const gap = finiteCenters[i] - finiteCenters[i - 1];
    if (gap > 0 && gap < minGap) minGap = gap;
  }
  const slotWidth = Number.isFinite(minGap) ? minGap : fallbackGap;
  return Math.max(0.5, slotWidth * 0.78);
}

export function summarizeSpectrum(yVals) {
  if (!yVals || !yVals.length) return null;
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < yVals.length; i += 1) {
    const value = Number(yVals[i]);
    if (!Number.isFinite(value)) continue;
    n += 1;
    sum += value;
    sumSq += value * value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!n) return null;
  const mean = sum / n;
  const variance = Math.max(0, (sumSq / n) - (mean * mean));
  return {
    mean,
    std: Math.sqrt(variance),
    rms: Math.sqrt(sumSq / n),
    min,
    max
  };
}
