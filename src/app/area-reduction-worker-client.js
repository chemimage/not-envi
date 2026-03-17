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

export function createAreaReductionWorkerClient() {
  return {
    reduce: async (values, sampleIndices) => reduceSync(values, sampleIndices),
    dispose: () => {},
    usingWorker: () => false
  };
}
