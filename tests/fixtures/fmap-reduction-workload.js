import { createFmapDataSource } from "../../src/io/fmap/index.js";
import { computeHistogram, histogramFromReduction } from "../../src/render/display-math.js";

function same(actual, expected, context) {
  for (const key of ["min", "max", "count", "p1", "p99", "mean", "rms", "stdDev", "mode", "modeBin", "binWidth"]) {
    if ((!Number.isFinite(actual[key]) && !Object.is(actual[key], expected[key]))
      || Math.abs(actual[key] - expected[key]) > Math.max(1e-8, Math.abs(expected[key]) * 1e-10)) {
      throw new Error(`${context}: ${key} ${actual[key]} != ${expected[key]}`);
    }
  }
  if (actual.bins.some((v, i) => v !== expected.bins[i])) throw new Error(`${context}: bins differ`);
}

export async function checkReductions(wasmBytes) {
  const types = [[1, 1, "setUint8"], [2, 2, "setInt16"], [3, 4, "setInt32"],
    [4, 4, "setFloat32"], [5, 8, "setFloat64"], [12, 2, "setUint16"],
    [13, 4, "setUint32"], [14, 8, "setBigInt64"], [15, 8, "setBigUint64"]];
  let cases = 0;
  for (const [dataType, bytes, setter] of types) for (const interleave of ["bsq", "bil", "bip"]) for (const littleEndian of [true, false]) {
    const samples = 17, lines = 9, bands = 3, headerOffset = 4093;
    const data = new ArrayBuffer(headerOffset + samples * lines * bands * bytes);
    const view = new DataView(data);
    const reference = [];
    for (let band = 0; band < bands; band += 1) for (let y = 0; y < lines; y += 1) for (let x = 0; x < samples; x += 1) {
      const index = interleave === "bsq" ? (band * lines + y) * samples + x
        : interleave === "bil" ? (y * bands + band) * samples + x : (y * samples + x) * bands + band;
      let value = (band * 13 + y * 3 + x) % 67;
      if (dataType === 2 || dataType === 3) value -= 31;
      if (dataType === 4 || dataType === 5) value = x === 1 ? NaN : x === 2 ? Infinity : x === 3 ? -Infinity : value - 31.125;
      if (dataType === 14) value = BigInt(value) - 9007199254740992n;
      if (dataType === 15) value = BigInt(value) + 9007199254740992n;
      view[setter](headerOffset + index * bytes, value, littleEndian);
      if (band === 1) reference.push(Math.fround(Number(value)));
    }
    const meta = { samples, lines, bands, headerOffset, dataType, interleave, littleEndian,
      dataTypeInfo: { bytes, ctor: Float64Array } };
    const source = createFmapDataSource(new File([data], "reduction.dat"), meta,
      { wasmBytes, pageSize: 4096, poolBytes: 8192, batchBytes: 128, maxResultBytes: 8192 });
    try {
      for (const masked of [false, true]) {
        const mask = masked ? Uint8Array.from(reference, (_, i) => +(i % 3 !== 0 && i % 17 < 12)) : undefined;
        const actual = histogramFromReduction(await source.reduceBandWindow(meta, 1, 0, 0, samples, lines, 1, { mask }));
        const selected = Float32Array.from(reference.filter((_, i) => !mask || mask[i]));
        same(actual, computeHistogram(selected), `${dataType}/${interleave}/${littleEndian}/${masked}`);
      }
      const sampled = [];
      for (let y = 1; y < lines; y += 2) for (let x = 1; x < samples; x += 2) sampled.push(reference[y * samples + x]);
      same(histogramFromReduction(await source.reduceBandWindow(meta, 1, 1, 1, 8, 4, 2)),
        computeHistogram(Float32Array.from(sampled)), "sampled ROI");
      const empty = new Uint8Array(samples * lines);
      same(histogramFromReduction(await source.reduceBandWindow(meta, 1, 0, 0, samples, lines, 1, { mask: empty })),
        computeHistogram(new Float32Array()), "empty mask");
      same(histogramFromReduction(await source.reduceBandWindow(meta, 1, 0, 0, 1, 1, 1)),
        computeHistogram(Float32Array.of(reference[0])), "constant ROI");
      if (dataType === 4 || dataType === 5) {
        same(histogramFromReduction(await source.reduceBandWindow(meta, 1, 1, 0, 3, 1, 1)),
          computeHistogram(Float32Array.of(NaN, Infinity, -Infinity)), "non-finite-only ROI");
      }
      await source.getStats();
      if (source.stats.logicalBytesReserved || source.stats.activeRequests) throw new Error("Reduction reservations did not drain");
      cases += 1;
    } finally { source.close(); }
  }
  return { cases, masks: "irregular union flags, no duplicate samples", sampleStep: 2 };
}

export async function benchmarkReductions(wasmBytes) {
  const reports = [];
  for (const dataType of [1, 4]) for (const samples of [512, 1024]) for (const layout of ["bsq", "bip"]) for (const fits of [true, false]) {
    const lines = samples, bands = layout === "bip" ? 3 : 1;
    const Ctor = dataType === 1 ? Uint8Array : Float32Array;
    const data = new Ctor(samples * lines * bands);
    for (let i = 0; i < data.length; i += 1) data[i] = i % 37 === 0 ? NaN : (i % 251) * 0.125 - 12;
    const meta = { samples, lines, bands, headerOffset: 0, dataType, interleave: layout,
      littleEndian: true, dataTypeInfo: { bytes: Ctor.BYTES_PER_ELEMENT, ctor: Ctor } };
    const file = new File([data], "bench.f32");
    const source = createFmapDataSource(file, meta, { wasmBytes, pageSize: 65536,
      poolBytes: fits ? data.byteLength : 131072, maxLogicalResultBytes: 16 * 1024 * 1024 });
    try {
      await source.ready;
      for (const path of ["materialized", "reduced-js", "reduced"]) {
        const timings = { cold: [], warm: [] };
        let bytes;
        for (let round = 0; round < 5; round += 1) {
          await source.clear();
          for (const state of ["cold", "warm"]) {
            const before = await source.getStats();
            const start = performance.now();
            const actual = path === "materialized"
              ? computeHistogram(await source.readBandWindow(meta, 0, 0, 0, samples, lines, 1,
                new Float32Array(samples * lines)))
              : histogramFromReduction(await source.reduceBandWindow(meta, 0, 0, 0, samples, lines, 1,
                { reductionBackend: path === "reduced-js" ? "js" : "c" }));
            timings[state].push(performance.now() - start);
            const expected = computeHistogram(Float32Array.from({ length: samples * lines }, (_, i) => data[i * bands]));
            same(actual, expected, `benchmark ${path}`);
            const after = await source.getStats();
            bytes = Object.fromEntries(["browserBytes", "copiedBytes", "outputBytes"].map(key => [key, after[key] - before[key]]));
          }
        }
        reports.push({ dataType, samples, layout, poolFits: fits, path, timings, lastWarmBytes: bytes });
      }
    } finally { source.close(); }
  }
  return reports;
}
