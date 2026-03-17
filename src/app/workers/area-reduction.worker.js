self.onmessage = (ev) => {
  const data = ev?.data || {};
  const id = Number(data.id);
  const valuesBuffer = data.valuesBuffer;
  const indicesRaw = data.indices;
  if (!Number.isFinite(id) || !(valuesBuffer instanceof ArrayBuffer)) return;

  try {
    const values = new Float32Array(valuesBuffer);
    let indices = null;
    if (indicesRaw instanceof Uint32Array) indices = indicesRaw;
    else if (Array.isArray(indicesRaw)) indices = Uint32Array.from(indicesRaw);
    else if (indicesRaw && Number.isFinite(indicesRaw.length)) indices = Uint32Array.from(indicesRaw);
    else indices = new Uint32Array(0);

    let sum = 0;
    let sumSq = 0;
    let count = 0;
    for (let i = 0; i < indices.length; i += 1) {
      const v = values[indices[i]];
      if (!Number.isFinite(v)) continue;
      sum += v;
      sumSq += (v * v);
      count += 1;
    }
    self.postMessage({ id, sum, sumSq, count });
  } catch (err) {
    self.postMessage({
      id,
      error: (err && err.message) ? String(err.message) : "Area reduction worker failed"
    });
  }
};
