function reduceSync(values, sampleIndices) {
  if (!values || !sampleIndices || !sampleIndices.length) return { sum: 0, sumSq: 0, count: 0 };
  let sum = 0;
  let sumSq = 0;
  const count = sampleIndices.length;
  for (let i = 0; i < count; i += 1) {
    const v = values[sampleIndices[i]];
    sum += v;
    sumSq += (v * v);
  }
  return { sum, sumSq, count };
}

export function createAreaReductionWorkerClient() {
  const canUseWorker = (typeof Worker !== "undefined") && (typeof URL !== "undefined");
  if (!canUseWorker) {
    return {
      reduce: async (values, sampleIndices) => reduceSync(values, sampleIndices),
      dispose: () => {},
      usingWorker: () => false
    };
  }

  let worker = null;
  let reqId = 0;
  const pending = new Map();

  function failPending(err) {
    for (const [id, req] of pending) {
      pending.delete(id);
      req.reject(err);
    }
  }

  function ensureWorker() {
    if (worker) return worker;
    try {
      worker = new Worker(new URL("./workers/area-reduction.worker.js", import.meta.url), { type: "module" });
    } catch (_err) {
      worker = null;
      return null;
    }
    worker.onmessage = (ev) => {
      const data = ev?.data || {};
      const id = Number(data.id);
      if (!Number.isFinite(id)) return;
      const req = pending.get(id);
      if (!req) return;
      pending.delete(id);
      if (data.error) {
        req.reject(new Error(String(data.error)));
        return;
      }
      req.resolve({
        sum: Number(data.sum) || 0,
        sumSq: Number(data.sumSq) || 0,
        count: Number(data.count) || 0
      });
    };
    worker.onerror = (err) => {
      const e = (err instanceof Error) ? err : new Error("Area reduction worker crashed");
      failPending(e);
      try { worker.terminate(); } catch (_ignore) {}
      worker = null;
    };
    return worker;
  }

  async function reduce(values, sampleIndices) {
    if (!values || !sampleIndices || !sampleIndices.length) return { sum: 0, sumSq: 0, count: 0 };
    const w = ensureWorker();
    if (!w) return reduceSync(values, sampleIndices);

    return new Promise((resolve, reject) => {
      const id = ++reqId;
      pending.set(id, { resolve, reject });
      try {
        const valuesF32 = (values instanceof Float32Array) ? values : Float32Array.from(values);
        w.postMessage(
          { id, valuesBuffer: valuesF32.buffer, indices: sampleIndices },
          [valuesF32.buffer]
        );
      } catch (_err) {
        pending.delete(id);
        resolve(reduceSync(values, sampleIndices));
      }
    });
  }

  function dispose() {
    failPending(new Error("Area reduction worker disposed"));
    if (worker) {
      try { worker.terminate(); } catch (_ignore) {}
      worker = null;
    }
  }

  return {
    reduce,
    dispose,
    usingWorker: () => !!worker
  };
}

