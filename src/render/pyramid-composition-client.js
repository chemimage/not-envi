import InlinePyramidWorker from "./workers/pyramid-composition.worker.js?worker&inline";
import { createPyramidCompositionEngine } from "./workers/pyramid-composition.worker.js";

const abortError = () => Object.assign(new Error("Pyramid composition superseded."), { name: "AbortError" });
const stamps = new WeakMap();
let nextStamp = 0;
let nextCompositionId = 0;
function tileStamp(tile) {
  if (!stamps.has(tile)) stamps.set(tile, ++nextStamp);
  return stamps.get(tile);
}

/** One active job and one latest queued job per panel/band. Main-thread mirrors
 * contain immutable exported pixels, not worker-owned planes. Each side retains
 * at most 64 MiB and six entries, independent of raw pyramid tile storage.
 * Keep the existing plane limit on the worker side: halving it would make three
 * high-DPI channel planes evict each other during ordinary mobile refinement.
 * Only tile copies are transferred. Unsupported/crashed workers use the same
 * kernel locally and expose that fallback in stats rather than hiding it. */
export function createPyramidCompositionClient(limit, options = {}) {
  const fallback = createPyramidCompositionEngine();
  const entries = new Map(), queued = new Map();
  const stats = { mode: "unstarted", fallbackReason: null, inputBytes: 0, outputBytes: 0,
    copyMs: 0, workerMs: 0, workerBytes: 0, cancelledJobs: 0, completedJobs: 0, snapshotRetries: 0 };
  let worker = null, active = null, nextId = 0, disposed = false, bytes = 0, timer = null;
  let target = 0;
  const canWorker = options.workerFactory || (typeof Worker !== "undefined" && typeof window !== "undefined");
  const factory = options.workerFactory || (() => new InlinePyramidWorker());

  function trim() {
    while (bytes > target || entries.size > 6) {
      const key = entries.keys().next().value;
      bytes -= entries.get(key).bytes; entries.delete(key);
    }
  }
  function setLimit(value) {
    target = Math.max(0, Math.min(64 * 1024 * 1024, Number(value) || 0)); trim();
  }
  setLimit(limit);
  function remove(key) {
    const previous = entries.get(key);
    if (previous) bytes -= previous.bytes;
    entries.delete(key);
  }
  function accept(job, result) {
    stats.completedJobs += 1; stats.workerMs += result.workerMs;
    stats.workerBytes = result.workerBytes;
    stats.outputBytes += result.data?.byteLength || 0;
    for (const key of entries.keys()) if (!result.retainedKeys.includes(key)) remove(key);
    const prior = entries.get(job.key);
    const data = result.data || prior?.data;
    if (!data) throw new Error("Pyramid worker omitted an uncached output snapshot.");
    const sources = prior?.viewKey === job.viewKey ? new Map(prior.sources) : new Map();
    for (const op of job.sentOperations) sources.set(op.key, op.stamp);
    remove(job.key);
    const compositionId = prior?.viewKey === job.viewKey && prior.workerPlaneId === result.compositionId
      ? prior.compositionId : ++nextCompositionId;
    const entry = { ...result, data, workerPlaneId: result.compositionId, compositionId,
      viewKey: job.viewKey, sources, bytes: data.byteLength };
    if (result.retainedKeys.includes(job.key) && entry.bytes <= target) {
      entries.set(job.key, entry); bytes += entry.bytes; trim();
    }
    return entry;
  }
  function failWorker(error) {
    clearTimeout(timer); timer = null;
    worker?.terminate(); worker = null;
    stats.mode = "sync"; stats.fallbackReason = String(error?.message || error);
    entries.clear(); bytes = 0;
    if (active) {
      const job = active; active = null;
      if (!job.cancelled) queued.set(job.key, job);
    }
    pump();
  }
  function ensureWorker() {
    if (stats.mode !== "unstarted") return;
    if (!canWorker) { stats.mode = "sync"; stats.fallbackReason = "Worker unavailable"; return; }
    try {
      worker = factory(); stats.mode = "worker";
      const currentWorker = worker;
      worker.onmessage = ({ data }) => {
        if (worker !== currentWorker || !active || data.id !== active.id) return;
        clearTimeout(timer); timer = null;
        const job = active; active = null;
        if (data.error) {
          active = job; failWorker(Object.assign(new Error(data.error.message), { name: data.error.name })); return;
        }
        // A budget reduction can evict the exported mirror while its unchanged
        // revision is in flight. Request an explicit snapshot instead of
        // mistaking that ordinary cache race for a worker failure.
        if (data.result?.data == null && !entries.get(job.key)?.data && !job.forceSnapshot) {
          for (const key of entries.keys()) if (!data.result.retainedKeys.includes(key)) remove(key);
          if (!job.cancelled) {
            job.forceSnapshot = true; stats.snapshotRetries += 1; queued.set(job.key, job);
          }
          pump(); return;
        }
        try {
          const result = accept(job, data.result);
          if (!job.cancelled) job.resolve(result);
        } catch (error) { active = job; failWorker(error); return; }
        pump();
      };
      worker.onerror = (error) => { if (worker === currentWorker) failWorker(error); };
      worker.onmessageerror = () => { if (worker === currentWorker) failWorker(new Error("Pyramid worker message failed.")); };
    } catch (error) {
      worker?.terminate(); worker = null;
      stats.mode = "sync"; stats.fallbackReason = String(error?.message || error);
    }
  }
  function pump() {
    if (disposed || active || !queued.size) return;
    ensureWorker();
    const key = queued.keys().next().value;
    const job = queued.get(key); queued.delete(key);
    active = job;
    // Filtering and copying happen only when admitted, so superseded jobs do
    // not allocate input buffers. Unacknowledged operations are never skipped.
    const previous = entries.get(key);
    job.sentOperations = job.operations.filter((op) => previous?.viewKey !== job.viewKey || previous.sources.get(op.key) !== op.stamp);
    if (stats.mode === "sync") {
      try {
        const result = fallback.compose({ ...job, operations: job.sentOperations, limit: target }, false);
        const entry = accept(job, result); active = null;
        if (!job.cancelled) job.resolve(entry);
      } catch (error) { active = null; job.reject(error); }
      pump(); return;
    }
    const copyStart = performance.now();
    try {
      const operations = job.sentOperations.map((op) => {
        const data = op.tile.data.slice(); stats.inputBytes += data.byteLength;
        return { ...op, tile: { level: op.tile.level, w: op.tile.w, data } };
      });
      stats.copyMs += performance.now() - copyStart;
      timer = setTimeout(() => failWorker(new Error("Pyramid composition worker timed out.")), options.timeoutMs || 30000);
      worker.postMessage({ id: job.id, key: job.key, viewKey: job.viewKey, geometry: job.geometry,
        uint8: job.uint8, requiredPixels: job.requiredPixels, limit: target, operations,
        knownRevision: !job.forceSnapshot && previous?.viewKey === job.viewKey ? previous.revision : null,
        knownPlaneId: !job.forceSnapshot && previous?.viewKey === job.viewKey ? previous.workerPlaneId : null },
      operations.map((op) => op.tile.data.buffer));
    } catch (error) { failWorker(error); }
  }
  function compose(input) {
    if (disposed) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const job = { ...input, id: ++nextId, resolve, reject,
        operations: input.operations.map((op) => ({ ...op, stamp: tileStamp(op.tile) })) };
      const previous = queued.get(job.key);
      if (previous) { previous.reject(abortError()); stats.cancelledJobs += 1; }
      if (active?.key === job.key && !active.cancelled) {
        active.cancelled = true; active.reject(abortError()); stats.cancelledJobs += 1;
      }
      // Hyve has two display panels and three color channels. Keep even unusual
      // callers bounded, retiring the oldest unstarted scope if necessary.
      if (!queued.has(job.key) && queued.size >= 6) {
        const oldest = queued.keys().next().value;
        queued.get(oldest).reject(abortError()); queued.delete(oldest); stats.cancelledJobs += 1;
      }
      queued.set(job.key, job); pump();
    });
  }
  function clear() {
    clearTimeout(timer); timer = null;
    if (active) active.reject(abortError());
    for (const job of queued.values()) job.reject(abortError());
    active = null; queued.clear(); entries.clear(); bytes = 0;
    worker?.terminate(); worker = null; fallback.clear();
    stats.mode = "unstarted"; stats.workerBytes = 0;
  }
  return { compose, setLimit, peek: (key, viewKey) => {
    const entry = entries.get(key); return entry?.viewKey === viewKey ? entry : null;
  }, clear, dispose() { clear(); disposed = true; }, entries, stats,
  get bytes() { return bytes; }, get limit() { return target; } };
}
