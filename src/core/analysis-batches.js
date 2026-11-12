// The grid stays anchored to each original selection, independent of batching.
// Earlier selections own overlapping grid points; no ROI-sized seen set/mask.
export const ANALYSIS_BATCH_VALUES = 16384;

export function requireAnalysisCurrent(cancelled) {
  if (cancelled?.()) {
    const error = new Error("Analysis cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

export function analysisCancellation(ds, cancelled) {
  const providers = [ds.ds, ds.ds?.rawSource, ds.ds?.rawSource?.source].filter(Boolean);
  const generations = providers.map((provider) => provider.generation);
  return () => !!(cancelled?.() || providers.some((provider, index) => provider.closed
    || provider.mapping?.released || provider.generation !== generations[index]));
}

export async function retryAnalysisOperation(operation, cancelled) {
  for (;;) {
    requireAnalysisCurrent(cancelled);
    try { return await operation(); } catch (error) {
      if (error.name !== "AbortError"
        || !/^fmap background (?:work|output) yielded to foreground work\.$/.test(error.message)
        || cancelled()) throw error;
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  }
}

export function createAnalysisPlan(regions, step, contains = () => true) {
  if (!Number.isSafeInteger(step) || step < 1) throw new RangeError("Invalid analysis sample step.");
  for (const { bounds, outW, outH } of regions) {
    if (![outW, outH, bounds.x0, bounds.y0].every(Number.isSafeInteger) || outW < 1 || outH < 1
      || !Number.isSafeInteger(outW * outH)) throw new RangeError("Invalid analysis region.");
  }
  const items = regions.map(({ selection, bounds, outW, outH }) => ({
    selection: selection ? { ...selection, points: selection.points?.map((p) => ({ ...p })) } : null,
    x0: bounds.x0, y0: bounds.y0, outW, outH
  }));
  const width = (item) => Math.min(item.outW, ANALYSIS_BATCH_VALUES);
  const rows = (item) => Math.max(1, Math.floor(ANALYSIS_BATCH_VALUES / width(item)));
  const batchCount = items.reduce((n, item) => n
    + Math.ceil(item.outW / width(item)) * Math.ceil(item.outH / rows(item)), 0);
  function includes(item, x, y) {
    const col = (x - item.x0) / step, row = (y - item.y0) / step;
    return Number.isInteger(col) && Number.isInteger(row) && col >= 0 && row >= 0
      && col < item.outW && row < item.outH
      && (item.selection?.tool !== "shape" || contains(item.selection, x + step * 0.5, y + step * 0.5));
  }
  function* batches(cancelled) {
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      for (let row = 0; row < item.outH; row += rows(item)) {
        for (let col = 0; col < item.outW; col += width(item)) {
          requireAnalysisCurrent(cancelled);
          const outW = Math.min(width(item), item.outW - col);
          const outH = Math.min(rows(item), item.outH - row);
          const x0 = item.x0 + col * step, y0 = item.y0 + row * step;
          yield { x0, y0, outW, outH, step, prepare() {
            let mask = null, sampleCount = outW * outH;
            if (index || item.selection?.tool === "shape") {
              mask = new Uint8Array(sampleCount);
              sampleCount = 0;
              for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) {
                const ix = x0 + x * step, iy = y0 + y * step;
                if (!includes(item, ix, iy)) continue;
                let seen = false;
                for (let prior = 0; prior < index; prior++) {
                  if (includes(items[prior], ix, iy)) { seen = true; break; }
                }
                if (seen) continue;
                mask[y * outW + x] = 1;
                sampleCount++;
              }
            }
            return { mask, sampleCount };
          } };
        }
      }
    }
  }
  return { batches, batchCount };
}

// Scoped transient analysis reservations. This is an integration point for #33,
// not accounting for persistent file pools, decoded caches or browser memory.
export function createAnalysisBudget(capacity = 4 * 1024 * 1024) {
  let activeBytes = 0, peakBytes = 0;
  const pending = [];
  function drain() {
    for (let i = 0; i < pending.length;) {
      const job = pending[i];
      try { requireAnalysisCurrent(job.cancelled); } catch (error) {
        pending.splice(i, 1); job.reject(error); continue;
      }
      if (activeBytes + job.bytes > capacity) { i++; continue; }
      pending.splice(i, 1);
      activeBytes += job.bytes;
      peakBytes = Math.max(peakBytes, activeBytes);
      let released = false;
      job.resolve(() => {
        if (released) return;
        released = true; activeBytes -= job.bytes; drain();
      });
    }
  }
  return {
    reserve(bytes, cancelled) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > capacity) return Promise.reject(new RangeError("Analysis batch exceeds reservation capacity."));
      return new Promise((resolve, reject) => { pending.push({ bytes, cancelled, resolve, reject }); drain(); });
    },
    stats: () => ({ activeBytes, peakBytes, queued: pending.length, capacity })
  };
}
export const analysisBudget = createAnalysisBudget();
