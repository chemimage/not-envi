import areaReductionWorkerSource from "./workers/area-reduction.worker.js?raw";

function reduceSync(values, sampleIndices) {
  if (!values || !sampleIndices || !sampleIndices.length) return { sum: 0, sumSq: 0, count: 0 };
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let i = 0; i < sampleIndices.length; i += 1) {
    const v = values[sampleIndices[i]];
    if (!Number.isFinite(v)) continue;
    sum += v;
    sumSq += (v * v);
    count += 1;
  }
  return { sum, sumSq, count };
}

function createSyncOnlyClient() {
  return {
    reduce: async (values, sampleIndices) => reduceSync(values, sampleIndices),
    dispose: () => {},
    usingWorker: () => false
  };
}

export function createAreaReductionWorkerClient(options = {}) {
  const timeoutMs = (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0)
    ? Number(options.timeoutMs)
    : 1500;
  const canUseWorker = (typeof Worker !== "undefined")
    && (typeof URL !== "undefined")
    && (typeof URL.createObjectURL === "function")
    && (typeof URL.revokeObjectURL === "function")
    && (typeof Blob !== "undefined")
    && !!String(areaReductionWorkerSource || "").trim();
  if (!canUseWorker) return createSyncOnlyClient();

  let worker = null;
  let workerUrl = "";
  let reqId = 0;
  const pending = new Map();

  function cleanupWorker() {
    if (worker) {
      try { worker.terminate(); } catch (_ignore) {}
      worker = null;
    }
    if (workerUrl) {
      try { URL.revokeObjectURL(workerUrl); } catch (_ignore) {}
      workerUrl = "";
    }
  }

  function settlePendingRequest(id, action) {
    const req = pending.get(id);
    if (!req) return;
    pending.delete(id);
    clearTimeout(req.timer);
    action(req);
  }

  function failPending(err) {
    const ids = Array.from(pending.keys());
    for (const id of ids) {
      settlePendingRequest(id, (req) => req.reject(err));
    }
  }

  function ensureWorker() {
    if (worker) return worker;
    try {
      const blob = new Blob([String(areaReductionWorkerSource)], { type: "text/javascript" });
      workerUrl = URL.createObjectURL(blob);
      worker = new Worker(workerUrl);
    } catch (_err) {
      cleanupWorker();
      return null;
    }
    worker.onmessage = (ev) => {
      const data = ev?.data || {};
      const id = Number(data.id);
      if (!Number.isFinite(id)) return;
      settlePendingRequest(id, (req) => {
        if (data.error) {
          req.reject(new Error(String(data.error)));
          return;
        }
        req.resolve({
          sum: Number(data.sum) || 0,
          sumSq: Number(data.sumSq) || 0,
          count: Number(data.count) || 0
        });
      });
    };
    worker.onerror = (err) => {
      const e = (err instanceof Error) ? err : new Error("Area reduction worker crashed");
      failPending(e);
      cleanupWorker();
    };
    return worker;
  }

  async function reduce(values, sampleIndices) {
    if (!values || !sampleIndices || !sampleIndices.length) return { sum: 0, sumSq: 0, count: 0 };
    const valuesF32 = (values instanceof Float32Array) ? values : Float32Array.from(values);
    const w = ensureWorker();
    if (!w) return reduceSync(valuesF32, sampleIndices);

    return new Promise((resolve) => {
      const id = ++reqId;
      const resolveWithLocalFallback = () => {
        cleanupWorker();
        resolve(reduceSync(valuesF32, sampleIndices));
      };
      const timer = setTimeout(() => {
        settlePendingRequest(id, () => {
          resolveWithLocalFallback();
        });
      }, timeoutMs);

      pending.set(id, {
        timer,
        resolve: (out) => resolve(out),
        reject: () => resolveWithLocalFallback()
      });

      try {
        w.postMessage({ id, valuesBuffer: valuesF32.buffer, indices: sampleIndices });
      } catch (_err) {
        settlePendingRequest(id, () => {
          resolveWithLocalFallback();
        });
      }
    });
  }

  function dispose() {
    failPending(new Error("Area reduction worker disposed"));
    cleanupWorker();
  }

  return {
    reduce,
    dispose,
    usingWorker: () => !!worker
  };
}
