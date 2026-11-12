import { CompositionCache } from "../incremental-composition.js";

/** Worker-owned planes. The returned snapshot is a separate export allocation:
 * transferring it never detaches the retained plane or caller-owned tile data. */
export function createPyramidCompositionEngine() {
  const cache = new CompositionCache(64 * 1024 * 1024);
  return {
    cache,
    compose(job, snapshot = true) {
      const start = performance.now();
      cache.setLimit(job.limit);
      const plane = cache.get(job.key, job.viewKey, job.geometry, job.uint8);
      plane.begin();
      let tilesUsed = 0;
      for (const op of job.operations) {
        if (plane.apply(op.tile, op.key, op.rect, op.factor, op.originX, op.originY, op.tileX, op.tileY)) tilesUsed += 1;
      }
      const incremental = plane.finish(job.requiredPixels);
      return {
        ...incremental, data: snapshot
          ? (job.knownRevision === plane.revision && job.knownPlaneId === plane.id ? null : plane.data.slice())
          : plane.data,
        filledCount: plane.filledCount, fineCount: plane.fineCount, bestLevel: plane.bestLevel,
        changedPixels: plane.changedPixels, tilesUsed, workerMs: performance.now() - start,
        retainedKeys: [...cache.entries.keys()], workerBytes: cache.bytes
      };
    },
    clear() { cache.clear(); }
  };
}

if (typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope) {
  const engine = createPyramidCompositionEngine();
  globalThis.onmessage = ({ data: job }) => {
    try {
      const result = engine.compose(job);
      globalThis.postMessage({ id: job.id, result }, result.data ? [result.data.buffer] : []);
    } catch (error) {
      globalThis.postMessage({ id: job.id, error: { name: error.name, message: error.message } });
    }
  };
}
