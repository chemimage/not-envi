import { probeValueAtBand } from "./spectrum-data.js";

// Read bounded, evenly spaced samples from the source, independent of viewport zoom.
export async function readLineProfile(ds, item, band, {
  maxSamples = 1024,
  concurrency = 3,
  cancelled = () => false
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
  const values = new Float32Array(count).fill(Number.NaN);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(count, Math.max(1, concurrency)) }, async () => {
    while (!cancelled()) {
      const i = next++;
      if (i >= count) return;
      const fraction = i / (count - 1);
      const x = Math.round(start.x + dx * fraction);
      const y = Math.round(start.y + dy * fraction);
      const value = await probeValueAtBand(ds, x, y, band);
      if (cancelled()) return;
      values[i] = value == null ? Number.NaN : value;
    }
  }));
  return cancelled() ? null : { values, lengthPx, sampled: count < fullCount };
}
