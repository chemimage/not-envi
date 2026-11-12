import { analysisBudget, requireAnalysisCurrent } from "./analysis-batches.js";
import { computeHistogram, histogramFromReduction, histogramFromUint8Counts } from "../render/display-math.js";

function accumulator() {
  return { min: Infinity, max: -Infinity, count: 0, sum: 0, sumSq: 0, bins: new Uint32Array(256) };
}

export async function streamStatistics({ ds, band, plan, readWindow, histogram = false,
  cancelled, onProgress, reserve = (bytes, abort) => analysisBudget.reserve(bytes, abort) }) {
  const current = () => !!(cancelled?.() || ds.ds?.closed);
  requireAnalysisCurrent(current);
  const uint8 = Number(ds.meta.dataType) === 1;
  const small = histogram && !uint8 && plan.batchCount === 1;
  const passes = histogram && !uint8 && !small ? 2 : 1;
  let smallHistogram;
  let completed = 0, sampleCount = 0, lastYield = performance.now();
  const total = plan.batchCount * passes;
  if (onProgress) await onProgress({ completed, total, phase: histogram && !uint8 ? "range" : "statistics" });
  async function pass(bins, min, max, phase) {
    const result = accumulator();
    let selected = 0;
    for (const batch of plan.batches(current)) {
      requireAnalysisCurrent(current);
      // Includes input conversion/transport and bounded mask snapshots. File
      // pager and codec reservations remain owned by their existing providers.
      const release = await reserve(512 * 1024, current);
      let window;
      try {
        requireAnalysisCurrent(current);
        Object.assign(batch, batch.prepare());
        selected += batch.sampleCount;
        if (batch.sampleCount) {
          let part;
          if (!small && typeof ds.ds?.reduceStatisticsWindow === "function") {
            part = await ds.ds.reduceStatisticsWindow(ds.meta, band, batch.x0, batch.y0,
              batch.outW, batch.outH, batch.step, { cancelled: current, priority: "background", mask: batch.mask, bins, min, max });
          } else {
            window = await readWindow(batch, { cancelled: current, priority: "background" });
            requireAnalysisCurrent(current);
            if (!window?.data || window.data.length < batch.outW * batch.outH) throw new Error("Incomplete analysis batch.");
            part = accumulator();
            const samples = small ? new Float32Array(batch.sampleCount) : null;
            let written = 0;
            const scale = bins ? (bins - 1) / (max - min) : 0;
            for (let i = 0; i < batch.outW * batch.outH; i++) {
              if (batch.mask && !batch.mask[i]) continue;
              const value = Math.fround(window.data[i]);
              if (samples) samples[written++] = value;
              if (!Number.isFinite(value)) continue;
              part.min = Math.min(part.min, value); part.max = Math.max(part.max, value);
              part.count++; part.sum += value; part.sumSq += value * value;
              if (bins) {
                const index = Math.floor((value - min) * scale);
                if (!Number.isNaN(index)) part.bins[Math.max(0, Math.min(bins - 1, index))]++;
              }
            }
            if (samples) smallHistogram = computeHistogram(samples.subarray(0, written), 256);
          }
          requireAnalysisCurrent(current);
          result.min = Math.min(result.min, part.min); result.max = Math.max(result.max, part.max);
          result.count += part.count; result.sum += part.sum; result.sumSq += part.sumSq;
          for (let i = 0; i < bins; i++) result.bins[i] += part.bins[i];
        }
      } finally { window?.release(); release(); }
      requireAnalysisCurrent(current);
      completed++;
      if (onProgress) await onProgress({ completed, total, phase });
      if (performance.now() - lastYield >= 12) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        lastYield = performance.now();
      }
    }
    sampleCount = selected;
    return result;
  }
  const range = await pass(histogram && uint8 ? 256 : 0, 0, 255, histogram && !uint8 ? "range" : "statistics");
  requireAnalysisCurrent(current);
  let stats = range;
  if (histogram) {
    if (smallHistogram) stats = smallHistogram;
    else if (small) stats = computeHistogram(new Float32Array(0), 256);
    else if (uint8) stats = histogramFromUint8Counts(range.bins);
    else {
      const min = range.count ? range.min : 0;
      const max = range.count ? (range.max === min ? min + 1e-6 : range.max) : 1;
      const counts = await pass(256, min, max, "histogram");
      stats = histogramFromReduction({ ...counts, min, max });
    }
  }
  requireAnalysisCurrent(current);
  return { ...stats, sampleCount, complete: true };
}
