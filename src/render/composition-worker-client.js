import InlineCompositionWorker from "./workers/composition.worker.js?worker&inline";

function aborted() { return new DOMException("Composition superseded.", "AbortError"); }

/** One worker job plus two latest pending views. Pending patch transport and
 * immutable fallback snapshots each have a maxBytes cap; idle mirrors retain
 * at most six planes/maxBytes. These are local pools, not a tab-wide heap cap.
 * Only owned patch copies are
 * transferred: renderer planes are never detached. The caller owns a returned
 * ImageBitmap and must close it after presentation; fallback canvases stay owned
 * by the fallback compositor. Cancelling active CPU work retires its result,
 * rather than pretending a synchronous worker loop can be interrupted. */
export function createCompositionWorkerClient({ fallback, workerFactory, timeoutMs = 10000,
  maxBytes = 64 * 1024 * 1024 } = {}) {
  let worker = null, unavailable = false, active = null, nextId = 0, disposed = false;
  const queued = new Map(), known = new Map(), mirrors = new Map();
  const stats = { requests: 0, completed: 0, cancelled: 0, transferredBytes: 0,
    queuedBytes: 0, peakQueuedBytes: 0, queuedSnapshotBytes: 0, peakQueuedSnapshotBytes: 0,
    fallbackJobs: 0, workerPixelsColored: 0 };
  const supported = () => workerFactory || (typeof Worker !== "undefined"
    && typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function");

  function settle(job, error, value) {
    if (job.settled) { value?.close?.(); return; }
    job.settled = true; job.signal?.removeEventListener("abort", job.onAbort);
    for (const mirror of job.mirrors || []) mirror.holders -= 1;
    if (error) job.reject(error); else job.resolve(value);
  }
  function stopWorker() { worker?.terminate(); worker = null; known.clear(); }
  function local(job) {
    stats.fallbackJobs += 1;
    if (job.settled) return;
    try { Promise.resolve(fallback(job.rasters, job.params, job.opts)).then(
      (value) => settle(job, null, value), (error) => settle(job, error)); }
    catch (error) { settle(job, error); }
  }
  function failWorker() {
    unavailable = true; stopWorker();
    if (active) { const job = active; active = null; clearTimeout(job.timer); if (!job.settled) local(job); }
    pump();
  }
  function ensureWorker() {
    if (worker) return worker;
    if (unavailable || !supported()) return null;
    try { worker = workerFactory ? workerFactory() : new InlineCompositionWorker(); }
    catch { unavailable = true; return null; }
    worker.onerror = failWorker;
    worker.onmessageerror = failWorker;
    worker.onmessage = ({ data }) => {
      if (!active || data.id !== active.id) { data.bitmap?.close?.(); return; }
      const job = active; active = null; clearTimeout(job.timer);
      if (data.error) {
        // A rejected revision/cache assumption must never leave pixels stale.
        known.clear(); if (!job.settled) local(job);
      } else {
        known.clear(); for (const plane of data.planes || []) known.set(plane.id, plane);
        stats.completed += 1; stats.workerPixelsColored = data.pixelsColored || 0;
        settle(job, null, data.bitmap);
      }
      pump();
    };
    return worker;
  }

  function snapshot(rasters, id) {
    let bytes = 0;
    const ownedRasters = [], heldMirrors = [];
    const planes = rasters.map((raster, channel) => {
      const tracked = Number.isSafeInteger(raster.compositionId) && Number.isSafeInteger(raster.revision);
      const planeId = tracked ? raster.compositionId : `direct:${id}:${channel}`;
      let mirror = mirrors.get(planeId);
      const sameShape = mirror?.w === raster.w && mirror?.h === raster.h;
      const unchangedMirror = tracked && sameShape && mirror.revision === raster.revision;
      if (!unchangedMirror) {
        const patchMirror = tracked && sameShape && mirror.revision === raster.previousRevision;
        if (!patchMirror) mirror = { w: raster.w, h: raster.h, data: new Float32Array(raster.dataF32), holders: 0 };
        else {
          if (mirror.holders) mirror = { ...mirror, data: mirror.data.slice(), holders: 0 };
          for (const rect of raster.dirtyRects) for (let y = 0; y < rect.h; y += 1) {
            const start = (rect.y + y) * raster.w + rect.x;
            mirror.data.set(raster.dataF32.subarray(start, start + rect.w), start);
          }
        }
        mirror.revision = raster.revision;
      }
      mirrors.delete(planeId); mirrors.set(planeId, mirror);
      mirror.holders += 1; heldMirrors.push(mirror);
      ownedRasters.push({ ...raster, dataF32: mirror.data });
      const previous = active ? null : known.get(planeId);
      const incremental = tracked && previous?.w === raster.w && previous?.h === raster.h;
      const unchanged = incremental && previous.revision === raster.revision;
      const patchable = incremental && previous.revision === raster.previousRevision;
      const rects = unchanged ? [] : patchable ? raster.dirtyRects : [{ x: 0, y: 0, w: raster.w, h: raster.h }];
      const patches = rects.map((rect) => {
        const values = new Float32Array(rect.w * rect.h);
        for (let y = 0; y < rect.h; y += 1) values.set(mirror.data.subarray(
          (rect.y + y) * raster.w + rect.x, (rect.y + y) * raster.w + rect.x + rect.w), y * rect.w);
        bytes += values.byteLength;
        return { ...rect, values };
      });
      return { id: planeId, w: raster.w, h: raster.h, revision: tracked ? raster.revision : 1,
        previousRevision: incremental ? previous.revision : null,
        full: !unchanged && !patchable, patches };
    });
    let retainedBytes = [...mirrors.values()].reduce((sum, mirror) => sum + mirror.data.byteLength, 0);
    while (mirrors.size > 6 || retainedBytes > maxBytes) {
      const oldest = mirrors.keys().next().value;
      retainedBytes -= mirrors.get(oldest).data.byteLength; mirrors.delete(oldest);
    }
    return { planes, bytes, rasters: ownedRasters, mirrors: heldMirrors,
      snapshotBytes: [...new Set(heldMirrors)].reduce((sum, mirror) => sum + mirror.data.byteLength, 0) };
  }

  function pump() {
    if (active || disposed || !queued.size) return;
    const [key, job] = queued.entries().next().value;
    queued.delete(key); stats.queuedBytes -= job.bytes; stats.queuedSnapshotBytes -= job.snapshotBytes;
    if (job.settled) return pump();
    const target = ensureWorker();
    if (!target) { local(job); return pump(); }
    active = job;
    job.timer = setTimeout(failWorker, timeoutMs);
    try {
      const transfer = job.planes.flatMap((plane) => plane.patches.map((patch) => patch.values.buffer));
      stats.transferredBytes += job.bytes;
      target.postMessage({ id: job.id, planes: job.planes, params: job.params, opts: job.opts, maxBytes }, transfer);
    } catch { failWorker(); }
  }

  function compose(rasters, params, opts = {}, { key = "default", signal } = {}) {
    if (disposed || signal?.aborted) return Promise.reject(aborted());
    if (typeof fallback !== "function") return Promise.reject(new TypeError("Composition requires a fallback."));
    stats.requests += 1;
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const old = queued.get(key);
      if (old) {
        queued.delete(key); stats.queuedBytes -= old.bytes; stats.queuedSnapshotBytes -= old.snapshotBytes;
        settle(old, aborted()); stats.cancelled += 1;
      }
      if (active?.key === key && !active.settled) { settle(active, aborted()); stats.cancelled += 1; }
      const job = { id, key, signal, rasters, params: structuredClone(params), opts: { ...opts }, resolve, reject };
      job.onAbort = () => {
        if (queued.get(key) === job) {
          queued.delete(key); stats.queuedBytes -= job.bytes; stats.queuedSnapshotBytes -= job.snapshotBytes;
        }
        stats.cancelled += 1; settle(job, aborted());
      };
      signal?.addEventListener("abort", job.onAbort, { once: true });
      if (!supported() || unavailable || rasters.reduce((sum, raster) => sum + raster.w * raster.h * 4, 0) > maxBytes) {
        local(job); return;
      }
      // Snapshot at submission: mutable renderer planes may change before a
      // queued job is dispatched. A worker checks the acknowledged base revision.
      const copied = snapshot(rasters, id); Object.assign(job, copied);
      if (job.bytes > maxBytes) { local(job); return; }
      queued.set(key, job); stats.queuedBytes += job.bytes; stats.queuedSnapshotBytes += job.snapshotBytes;
      while (queued.size > 2 || stats.queuedBytes > maxBytes || stats.queuedSnapshotBytes > maxBytes) {
        const [oldestKey, oldest] = queued.entries().next().value;
        queued.delete(oldestKey); stats.queuedBytes -= oldest.bytes; stats.queuedSnapshotBytes -= oldest.snapshotBytes;
        stats.cancelled += 1; settle(oldest, aborted());
      }
      stats.peakQueuedBytes = Math.max(stats.peakQueuedBytes, stats.queuedBytes);
      stats.peakQueuedSnapshotBytes = Math.max(stats.peakQueuedSnapshotBytes, stats.queuedSnapshotBytes);
      pump();
    });
  }
  function clear() {
    if (active) { clearTimeout(active.timer); settle(active, aborted()); active = null; }
    for (const job of queued.values()) settle(job, aborted());
    queued.clear(); mirrors.clear(); stats.queuedBytes = 0; stats.queuedSnapshotBytes = 0; stopWorker();
  }
  function dispose() { disposed = true; clear(); }
  return { compose, clear, dispose, stats, usingWorker: () => !!worker };
}
