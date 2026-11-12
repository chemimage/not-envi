import { probeValueAtBand } from "./spectrum-data.js";
import { analysisBudget } from "../core/analysis-batches.js";

// Read bounded, evenly spaced samples from the source, independent of viewport zoom.
export async function readLineProfile(ds, item, band, {
  maxSamples = 1024,
  concurrency = 3,
  cancelled = () => false,
  onProgress
} = {}) {
  const start = item?.points?.[0];
  const end = item?.points?.at(-1);
  if (!start || !end || ![start.x, start.y, end.x, end.y].every(Number.isFinite)) return null;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthPx = Math.hypot(dx, dy);
  if (lengthPx <= 0) return null;
  const fullCount = Math.ceil(lengthPx) + 1;
  const count = Math.min(fullCount, Math.max(2, Math.floor(maxSamples)));
  const release = await analysisBudget.reserve(count * 4 + 4096, cancelled);
  try {
    if (cancelled()) return null;
    const values = new Float32Array(count).fill(Number.NaN);
    let next = 0;
    let completed = 0, failed = false;
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(count, Math.max(1, concurrency)) }, async () => {
      try { while (!cancelled() && !failed) {
        const i = next++;
        if (i >= count) return;
        const fraction = i / (count - 1);
        const x = Math.round(start.x + dx * fraction);
        const y = Math.round(start.y + dy * fraction);
        const value = await probeValueAtBand(ds, x, y, band, { cancelled: () => cancelled() || failed, priority: "background" });
        if (cancelled()) return;
        values[i] = value == null ? Number.NaN : value;
        onProgress?.({ completed: ++completed, total: count });
      } } catch (error) { failed = true; throw error; }
    }));
    const error = outcomes.find((outcome) => outcome.status === "rejected");
    if (error && !cancelled()) throw error.reason;
    return cancelled() ? null : { values, lengthPx, sampled: count < fullCount };
  } finally { release(); }
}
