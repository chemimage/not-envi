const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function quickStatsFromArray(arr) {
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  for (let i = 0; i < arr.length; i += 1) {
    const v = arr[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    count += 1;
  }
  if (!count) return { min: 0, max: 1, count: 0 };
  if (max === min) max = min + 1e-6;
  return { min, max, count };
}

export function percentileFromHist(bins, min, max, q, total) {
  if (!total) return min;
  const target = clamp(q, 0, 1) * total;
  let acc = 0;
  const n = bins.length;
  for (let i = 0; i < n; i += 1) {
    acc += bins[i];
    if (acc >= target) {
      return min + ((i + 0.5) / n) * (max - min);
    }
  }
  return max;
}

export function computeHistogram(arr, bins = 256) {
  const { min, max, count } = quickStatsFromArray(arr);
  const out = new Uint32Array(bins);
  const scale = (bins - 1) / (max - min);
  for (let i = 0; i < arr.length; i += 1) {
    const v = arr[i];
    if (!Number.isFinite(v)) continue;
    const k = clamp(Math.floor((v - min) * scale), 0, bins - 1);
    out[k] += 1;
  }
  const p1 = percentileFromHist(out, min, max, 0.01, count);
  const p99 = percentileFromHist(out, min, max, 0.99, count);
  return { bins: out, min, max, count, p1, p99 };
}

export function tone01(v, minVal, maxVal, gamma, gain, contrast) {
  let x = (v - minVal) / (maxVal - minVal);
  x = clamp(x, 0, 1);
  x = Math.pow(x, 1 / Math.max(1e-6, gamma));
  x = (x - 0.5) * contrast + 0.5;
  x = x * gain;
  return clamp(x, 0, 1);
}

export function typeDefaultRange(meta) {
  const t = meta.dataType;
  if (t === 1) return { min: 0, max: 255 };
  if (t === 12) return { min: 0, max: 65535 };
  if (t === 2) return { min: -32768, max: 32767 };
  if (t === 3) return { min: -2147483648, max: 2147483647 };
  if (t === 13) return { min: 0, max: 4294967295 };
  return { min: null, max: null };
}

export function resolveDisplayRange(ds, band, fallbackArray, getBandSettings) {
  const s = getBandSettings(ds, band);
  let minVal = s.min;
  let maxVal = s.max;

  const stats = ds.bandStatsWhole.get(band) || ds.bandStatsView;
  if ((minVal == null || maxVal == null) && stats) {
    if (minVal == null) minVal = stats.p1;
    if (maxVal == null) maxVal = stats.p99;
  }

  if ((minVal == null || maxVal == null) && fallbackArray) {
    const h = computeHistogram(fallbackArray, 256);
    if (minVal == null) minVal = h.p1;
    if (maxVal == null) maxVal = h.p99;
  }

  if ((minVal == null || maxVal == null)) {
    const d = typeDefaultRange(ds.meta);
    if (minVal == null) minVal = (d.min != null) ? d.min : 0;
    if (maxVal == null) maxVal = (d.max != null) ? d.max : 1;
  }

  if (!Number.isFinite(minVal)) minVal = 0;
  if (!Number.isFinite(maxVal)) maxVal = minVal + 1;
  if (maxVal === minVal) maxVal = minVal + 1e-6;

  return { minVal, maxVal };
}
