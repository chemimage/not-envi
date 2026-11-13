// Observed browser file access, never a disk-type classifier. Only actual reads
// needed by foreground work enter the detector; cache hits have no read event.
export const SOURCE_READ_THRESHOLDS = Object.freeze({
  minBytes: 32 * 1024,
  maxBytes: 256 * 1024,
  windowReads: 20,
  slowWindows: 2,
  medianMs: 4,
  foregroundWaitMs: 1000,
  idleMs: 250
});

export function createSourceReadMonitor({ now = () => performance.now(), ...options } = {}) {
  const limits = { ...SOURCE_READ_THRESHOLDS, ...options };
  const jobs = new Map();
  let settledAt = -Infinity;
  let qualified = 0, slowWindows = 0, medianMs = 0, waitMs = 0, readEnd = 0;
  let warning = 0, warningMedianMs = 0, warningWaitMs = 0, warningRequestId = 0;
  let evidenceEpoch = null, warningEpoch = 0;
  const samples = [], offsets = new Set();

  function resetEvidence() {
    qualified = 0; slowWindows = 0; medianMs = 0; waitMs = 0; readEnd = 0;
    samples.length = 0; offsets.clear();
    evidenceEpoch = null;
  }

  function begin(id, foreground, epoch = 0) {
    if (!foreground) return;
    if (!jobs.size && now() - settledAt > limits.idleMs) resetEvidence();
    jobs.set(id, epoch);
  }

  function read({ offset, length, startMs, endMs }, foregroundIds) {
    if (!foregroundIds.some((id) => jobs.has(id)) || !Number.isFinite(startMs)
      || !Number.isFinite(endMs) || endMs < startMs) return;
    for (const id of foregroundIds) if (jobs.has(id)) evidenceEpoch = Math.min(evidenceEpoch ?? Infinity, jobs.get(id));
    // Completion callbacks arrive in end-time order. Count overlapping reads
    // once, and exclude queueing, decoding and gaps between file reads.
    waitMs += Math.max(0, endMs - Math.max(startMs, readEnd));
    readEnd = Math.max(readEnd, endMs);
    if (length < limits.minBytes || length > limits.maxBytes || offsets.has(offset)) return;
    offsets.add(offset);
    if (offsets.size > limits.windowReads * limits.slowWindows) offsets.delete(offsets.values().next().value);
    qualified++;
    samples.push(endMs - startMs);
    if (samples.length !== limits.windowReads) return;
    const sorted = [...samples].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    medianMs = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    slowWindows = medianMs >= limits.medianMs ? Math.min(limits.slowWindows, slowWindows + 1) : 0;
    samples.length = 0;
  }

  function finish(id, success = true) {
    if (!jobs.delete(id)) return;
    // Discard a canceled/failed burst conservatively, including shared reads.
    // A previous valid warning remains sticky for this file's lifetime.
    if (!success) resetEvidence();
    if (jobs.size) return;
    settledAt = now();
    if (success && slowWindows >= limits.slowWindows && waitMs > limits.foregroundWaitMs) {
      warning = 1; warningMedianMs = medianMs; warningWaitMs = waitMs; warningRequestId = id;
      warningEpoch = evidenceEpoch;
    }
  }

  function clear() { jobs.clear(); resetEvidence(); settledAt = -Infinity; }
  function invalidate() { resetEvidence(); warning = 0; warningRequestId = 0; warningMedianMs = 0; warningWaitMs = 0; }

  function snapshot() {
    return { sourceReadQualifiedSamples: qualified, sourceReadWindowSamples: samples.length,
      sourceReadMedianMs: medianMs, sourceReadSlowWindows: slowWindows, sourceReadWaitMs: waitMs,
      sourceReadWarning: warning, sourceReadWarningMedianMs: warningMedianMs, sourceReadWarningWaitMs: warningWaitMs,
      sourceReadWarningRequestId: warningRequestId, sourceReadWarningEpoch: warningEpoch };
  }

  return { begin, read, finish, clear, invalidate, snapshot };
}

// Linear TIFF delegates numeric reads directly to its fmap source. Follow that
// source instead of relying on a wrapper's possibly older cached stats.
export function resolveSourceReadStats(source) {
  const seen = new Set();
  let found = null;
  while (source && !seen.has(source) && seen.size < 8) {
    seen.add(source);
    if (Number.isFinite(source.stats?.sourceReadQualifiedSamples)) found = source.stats;
    source = source.rawSource || source.source;
  }
  return found;
}
