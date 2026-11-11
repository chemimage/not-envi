import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "@playwright/test";

const host = "127.0.0.1";
const port = Number(process.env.FMAP_BENCHMARK_PORT || 4176);
const origin = `http://${host}:${port}`;
const outputArgIndex = process.argv.indexOf("--output");
const outputPath = outputArgIndex === -1 ? "" : String(process.argv[outputArgIndex + 1] || "").trim();
if (outputArgIndex !== -1 && !outputPath) throw new Error("--output requires a report path.");
const viteCli = path.resolve("node_modules", "vite", "bin", "vite.js");
const server = spawn(process.execPath, [viteCli, "--host", host, "--port", String(port), "--strictPort"], {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"]
});

let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += String(chunk); });
server.stderr.on("data", (chunk) => { serverOutput += String(chunk); });

async function waitForServer() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (server.exitCode != null) throw new Error(`Vite exited before the benchmark started.\n${serverOutput}`);
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch (_error) {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${origin}.\n${serverOutput}`);
}

let browser = null;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`${origin}/?fmap=1`);
  const report = await page.evaluate(async () => {
    const { createFmapDataSource } = await import("/src/io/fmap/index.js");
    const { BlobDataSource, ChunkCacheDataSource } = await import("/src/core/data-source.js");
    const { EnviDataSource } = await import("/src/io/envi-data-source.js");
    const { readSpectrumAtPixel: readBaselineSpectrum } = await import("/src/render/spectrum-data.js");
    const wasmResponse = await fetch("/wasm/fmap/pkg/fmap_core.wasm");
    if (!wasmResponse.ok) throw new Error(`WASM fetch failed (${wasmResponse.status})`);
    const wasmBytes = await wasmResponse.arrayBuffer();

    const samples = 512;
    const lines = 512;
    const bands = 32;
    const headerOffset = 4093;
    const planeValues = samples * lines;
    const values = new Float32Array(planeValues * bands);
    for (let band = 0; band < bands; band += 1) {
      const planeOffset = band * planeValues;
      for (let y = 0; y < lines; y += 1) {
        const rowOffset = planeOffset + (y * samples);
        for (let x = 0; x < samples; x += 1) values[rowOffset + x] = (band * 10000) + (y * 10) + x;
      }
    }
    const file = new File([new Uint8Array(headerOffset), values], "fmap-browser-benchmark.dat");
    const meta = {
      samples,
      lines,
      bands,
      headerOffset,
      interleave: "bsq",
      dataType: 4,
      littleEndian: true,
      dataTypeInfo: { bytes: 4, ctor: Float32Array, dv: "getFloat32" }
    };
    const sourceOptions = {
      pageSize: 64 * 1024,
      poolBytes: 512 * 1024,
      maxQueuedRequests: 16,
      maxQueuedBytes: 16 * 1024 * 1024,
      maxInflightBytes: 4 * 1024 * 1024,
      maxResultBytes: 4 * 1024 * 1024,
      batchBytes: 128 * 1024,
      sparseReadThresholdBytes: 4 * 1024,
      sparseReadMaxGapBytes: 32,
      wasmBytes
    };
    const source = createFmapDataSource(file, meta, sourceOptions);
    const baselineBlob = new BlobDataSource(file);
    const baselineCache = new ChunkCacheDataSource(baselineBlob, {
      chunkSize: 64 * 1024,
      maxBytes: 512 * 1024,
      concurrency: 2
    });
    const baselineSource = new EnviDataSource(baselineCache, meta);

    const percentile = (samplesList, fraction) => {
      const sorted = [...samplesList].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
    };
    const statsKeys = [
      "requestedBytes", "browserBytes", "copiedBytes", "usefulValues", "cacheHits", "cacheMisses",
      "cacheEvictions", "sparseReads", "batches", "cancelledRequests",
      "pageFillReads", "pageFillDeduplications", "pageFillCacheHits", "pageFillCacheMisses", "pageFillCopiedBytes"
    ];
    const deltaStats = (before, after) => Object.fromEntries(statsKeys.map((key) => [
      key,
      Number(after?.[key] || 0) - Number(before?.[key] || 0)
    ]));
    const measure = async (name, operations, usefulBytes, measuredSource = source) => {
      const before = await measuredSource.getStats();
      const durations = [];
      let checksum = 0;
      for (const operation of operations) {
        const started = performance.now();
        const output = await operation();
        durations.push(performance.now() - started);
        operation.verify?.(output);
        checksum += Number(output?.[0] || 0) + Number(output?.[output.length - 1] || 0);
      }
      const after = await measuredSource.getStats();
      const stats = deltaStats(before, after);
      return {
        name,
        samples: durations.length,
        p50Ms: Number(percentile(durations, 0.50).toFixed(3)),
        p95Ms: Number(percentile(durations, 0.95).toFixed(3)),
        checksum: Number(checksum.toFixed(3)),
        usefulBytes,
        browserAmplification: Number((stats.browserBytes / Math.max(1, usefulBytes)).toFixed(3)),
        copyAmplification: Number((stats.copiedBytes / Math.max(1, usefulBytes)).toFixed(3)),
        stats
      };
    };
    const valueAt = (band, x, y) => (band * 10000) + (y * 10) + x;
    const checkedWindow = (band, x, y, width, height, step, options, measuredSource = source) => {
      const operation = () => measuredSource.readBandWindow(
        meta, band, x, y, width, height, step, null, options
      );
      operation.verify = (output) => {
        for (let outY = 0; outY < height; outY += 1) {
          for (let outX = 0; outX < width; outX += 1) {
            const index = (outY * width) + outX;
            const expected = valueAt(band, x + (outX * step), y + (outY * step));
            if (output[index] !== expected) throw new Error(`Window mismatch at ${band}:${x},${y} output ${outX},${outY}`);
          }
        }
      };
      return operation;
    };
    const checkedFmapSpectrum = () => {
      const operation = () => source.readSpectrumAtPixel(
        meta, 257, 263, { priority: "background", supersedeKey: "spectrum" }
      );
      operation.verify = (output) => {
        for (let band = 0; band < bands; band += 1) {
          if (output[band] !== valueAt(band, 257, 263)) throw new Error(`fmap spectrum mismatch in band ${band}`);
        }
      };
      return operation;
    };
    const measureBaselineSpectrum = async (count) => {
      const durations = [];
      const browserBytesBefore = baselineBlob.stats.bytesRead;
      let checksum = 0;
      for (let index = 0; index < count; index += 1) {
        const started = performance.now();
        const output = await readBaselineSpectrum({ meta, ds: baselineSource }, 257, 263, 2);
        durations.push(performance.now() - started);
        for (let band = 0; band < bands; band += 1) {
          if (output[band] !== valueAt(band, 257, 263)) throw new Error(`baseline spectrum mismatch in band ${band}`);
        }
        checksum += output[0] + output[output.length - 1];
      }
      const usefulBytes = count * bands * 4;
      const browserBytes = baselineBlob.stats.bytesRead - browserBytesBefore;
      return {
        name: "chunk-cache-repeated-sparse-spectrum",
        samples: count,
        p50Ms: Number(percentile(durations, 0.50).toFixed(3)),
        p95Ms: Number(percentile(durations, 0.95).toFixed(3)),
        checksum: Number(checksum.toFixed(3)),
        usefulBytes,
        browserAmplification: Number((browserBytes / Math.max(1, usefulBytes)).toFixed(3)),
        stats: {
          browserBytes,
          cacheHits: baselineCache.stats.cacheHits,
          cacheMisses: baselineCache.stats.cacheMisses,
          cacheEvictions: baselineCache.stats.cacheEvictions,
          residentBytes: baselineCache.cacheBytes()
        }
      };
    };

    // Wide scanlines exercise hundreds of cooperative batches, unlike the
    // small viewports above. This reflects the full-slide scheduling regression
    // without requiring a private dataset or an entire slide in browser RAM.
    const measureWideViewport = async () => {
      const width = 12812, height = 2048, step = 13;
      const input = new Float32Array(width * height);
      const valueAtWide = (x, y) => (y * 31) + x;
      for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
        input[y * width + x] = valueAtWide(x, y);
      }
      const wideMeta = { ...meta, samples: width, lines: height, bands: 1, headerOffset: 0 };
      const wide = createFmapDataSource(new File([input], "wide-viewport.dat"), wideMeta, {
        ...sourceOptions, pageSize: 256 * 1024, poolBytes: 64 * 1024 * 1024,
        batchBytes: 64 * 1024, sparseReadThresholdBytes: 32 * 1024, sparseReadMaxGapBytes: 4096
      });
      const outW = Math.ceil(width / step), outH = Math.ceil(height / step);
      const read = () => wide.readBandWindow(wideMeta, 0, 0, 0, outW, outH, step);
      read.verify = (output) => {
        for (let y = 0; y < outH; y += 1) for (let x = 0; x < outW; x += 1) {
          if (output[y * outW + x] !== valueAtWide(x * step, y * step)) {
            throw new Error(`Wide viewport value mismatch at ${x},${y}`);
          }
        }
      };
      try {
        await wide.ready;
        const coldRead = () => { wide.clear(); return read(); };
        coldRead.verify = read.verify;
        const cold = await measure("wide-strided-viewport", Array(6).fill(coldRead), 6 * outW * outH * 4, wide);
        const repeat = await measure("wide-strided-viewport-repeat", Array(6).fill(read), 6 * outW * outH * 4, wide);
        const finalStats = await wide.getStats();
        if (finalStats.pinnedBytes !== 0 || finalStats.peakInflightBytes > wide.maxInflightBytes) {
          throw new Error("Wide viewport left pins or exceeded its transport budget");
        }
        if (repeat.stats.browserBytes !== 0 || finalStats.fillActiveReads !== 0
            || finalStats.peakFillActiveReads > wide.concurrency) {
          throw new Error("Wide viewport did not reuse retained ranges or exceeded its I/O limit");
        }
        return { dimensions: [width, height, 1], step, poolBytes: wide.cacheBytes(),
          note: "Raw source reads only; the pool fits these partial pages. Repeated reads must reuse them without I/O; no pyramid cache is involved.",
          cold, repeat, finalStats };
      } finally { wide.close(); }
    };

    try {
      await source.ready;
      const coldOperations = Array.from({ length: 12 }, (_, index) => checkedWindow(
        index,
        (index * 31) % 320,
        (index * 47) % 320,
        64,
        64,
        2,
        { priority: "foreground", supersedeKey: `cold-${index}` }
      ));
      const cold = await measure("cold-distinct-viewports", coldOperations, coldOperations.length * 64 * 64 * 4);
      const pagedSource = createFmapDataSource(file, meta, { ...sourceOptions, sparseReadThresholdBytes: 0 });
      let pagedCold;
      try {
        await pagedSource.ready;
        const pagedOperations = Array.from({ length: 12 }, (_, index) => checkedWindow(
          index, (index * 31) % 320, (index * 47) % 320, 64, 64, 2,
          { priority: "foreground" }, pagedSource
        ));
        pagedCold = await measure("cold-viewports-page-policy-reference", pagedOperations,
          pagedOperations.length * 64 * 64 * 4, pagedSource);
        if (pagedCold.checksum !== cold.checksum) throw new Error("Viewport policy checksums differ");
      } finally { pagedSource.close(); }

      const warmRead = checkedWindow(
        31, 73, 91, 64, 64, 1,
        { priority: "foreground", supersedeKey: "warm-viewport" }
      );
      await warmRead();
      const warmOperations = Array.from({ length: 20 }, () => warmRead);
      const warm = await measure("warm-repeated-viewport", warmOperations, warmOperations.length * 64 * 64 * 4);

      const panOperations = Array.from({ length: 24 }, (_, index) => checkedWindow(
        31, 40 + (index * 3), 160, 64, 64, 1,
        { priority: "foreground", supersedeKey: "pan-viewport" }
      ));
      const pan = await measure("adjacent-pan", panOperations, panOperations.length * 64 * 64 * 4);

      const spectrumOperations = Array.from({ length: 24 }, () => checkedFmapSpectrum());
      const sparseSpectrum = await measure(
        "repeated-sparse-spectrum",
        spectrumOperations,
        spectrumOperations.length * bands * 4
      );
      const baselineSpectrum = await measureBaselineSpectrum(spectrumOperations.length);
      const finalStats = await source.getStats();
      if (source.cacheBytes() !== 512 * 1024) throw new Error("fmap resident pool changed size during the benchmark");
      if (warm.stats.browserBytes !== 0) throw new Error("warm viewport unexpectedly reread browser file bytes");
      if (sparseSpectrum.stats.browserBytes > sparseSpectrum.usefulBytes) {
        throw new Error("fmap sparse spectrum browser-byte amplification exceeded 1x");
      }
      if (baselineSpectrum.stats.browserBytes <= sparseSpectrum.stats.browserBytes) {
        throw new Error("fmap sparse spectrum did not reduce browser bytes versus the chunk cache");
      }
      if (baselineSpectrum.checksum !== sparseSpectrum.checksum) {
        throw new Error("fmap and chunk-cache sparse spectrum checksums differ");
      }
      if (finalStats.peakInflightBytes > 4 * 1024 * 1024) {
        throw new Error("fmap exceeded the configured in-flight byte budget");
      }
      if (finalStats.pinnedBytes !== 0) throw new Error("fmap left pages pinned after the workloads completed");
      const wideViewport = await measureWideViewport();
      return {
        disclaimer: "Browser workload report only; latency is descriptive and has no pass/fail speed threshold.",
        copyCounterScope: "fmap page/range transport only; excludes codec-internal and caller output/composition copies. Existing TIFF copy counters are unavailable.",
        userAgent: navigator.userAgent,
        config: {
          fileBytes: file.size,
          dimensions: [samples, lines, bands],
          pageBytes: 64 * 1024,
          poolBytes: 512 * 1024
        },
        workloads: { cold, pagedCold, warm, pan, sparseSpectrum, baselineSpectrum },
        sparseSpectrumComparison: { fmap: sparseSpectrum, chunkCache: baselineSpectrum },
        wideViewport,
        finalStats
      };
    } finally {
      source.close();
      baselineSource.close();
    }
  });
  report.mappingIndex = await page.evaluate(async () => {
    const bytes = await (await fetch("/wasm/fmap/pkg/fmap_core.wasm")).arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const core = instance.exports;
    const results = [];
    for (const count of [64, 1024, 16384]) {
      if (core.fmap_init(4096, 2) !== 0) throw new Error("Mapping benchmark initialization failed.");
      const base = 8n * 1024n * 1024n * 1024n;
      let start = performance.now();
      for (let i = 0; i < count; i += 1) {
        if (core.fmap_map_region(base + BigInt(i) * 8192n, 4096n, BigInt(i) * 4096n, BigInt(i + 1)) !== 0) {
          throw new Error("Mapping benchmark insertion failed.");
        }
      }
      const insertMs = performance.now() - start;
      const lookupCount = 100000;
      let checksum = 0;
      start = performance.now();
      for (let i = 0; i < lookupCount; i += 1) {
        const index = (i * 7919) % count;
        const id = Number(core.fmap_lookup_mapping(base + BigInt(index) * 8192n + 17n));
        if (id !== index + 1) throw new Error("Mapping benchmark lookup mismatch.");
        checksum += id;
      }
      const lookupMs = performance.now() - start;
      const metadataBytes = Number(core.fmap_mapping_bytes());
      start = performance.now();
      for (let i = 0; i < count; i += 1) {
        if (core.fmap_unmap_region(BigInt(i + 1)) !== 0) throw new Error("Mapping benchmark release failed.");
      }
      if (core.fmap_mapping_count() !== 0 || core.fmap_resident_bytes() !== 8192) {
        throw new Error("Mapping benchmark leaked records or changed the byte pool.");
      }
      results.push({ ranges: count, lookupCount, checksum, metadataBytes,
        insertMs: Number(insertMs.toFixed(3)), lookupMs: Number(lookupMs.toFixed(3)),
        releaseMs: Number((performance.now() - start).toFixed(3)) });
    }
    return { scope: "C/WASM mapping index only; excludes file I/O and worker messaging", results };
  });
  if (!process.argv.includes("--envi-only")) report.tiff = await page.evaluate(async () => {
    const { createBenchmarkTiff } = await import("/tests/fixtures/fmap-tiff.js");
    const { addDatasetFromFile } = await import("/src/io/tiff-loader.js");
    const { readBandWindow } = await import("/src/core/raster-io.js");
    const wasmBytes = await (await fetch("/wasm/fmap/pkg/fmap_core.wasm")).arrayBuffer();
    const results = [];
    const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
    for (const compression of [1, 32773, 5, 8]) for (const tiled of [true, false]) for (const backend of ["fmap", "existing"]) {
      const fixture = await createBenchmarkTiff(compression, tiled);
      let baselineBrowserBytes = 0;
      // The existing backend has no worker byte counter. Count the bytes of
      // its File slices; decoded-copy accounting is unavailable and stays null.
      const file = backend === "existing" ? new class extends File {
        slice(...args) {
          const blob = super.slice(...args);
          baselineBrowserBytes += blob.size;
          return blob;
        }
      }([fixture.file], fixture.file.name, { type: fixture.file.type }) : fixture.file;
      const workingLimit = 262144;
      const dataset = await addDatasetFromFile(file, {
        fmapEnabled: backend === "fmap", fmapWasmBytes: wasmBytes, cacheBytes: 8 * 1024 * 1024,
        fmapOptions: { pageSizeBytes: 65536, poolBytes: 262144, maxInflightRequests: 2,
          maxResultBytes: 65536, maxInflightBytes: 262144, maxQueuedBytes: 1048576 },
        tiffFmapOptions: { maxWorkingSetBytes: workingLimit }, createDataset: (descriptor) => descriptor
      });
      try {
        const source = dataset.cached;
        if (backend === "fmap" && !dataset.raw.fmap && !source.usesFmapRangeSource && !/fmap/i.test(source.constructor.name)) {
          throw new Error(`TIFF ${compression} ${tiled} did not use fmap`);
        }
        const ranges = source.rawSource || source;
        const stats = async () => backend === "fmap" ? ranges.getStats() : {
          ...(await source.getStats?.() || {}), browserBytes: baselineBrowserBytes
        };
        const check = (output, x0, y0) => {
          for (let y = 0; y < 32; y += 1) for (let x = 0; x < 32; x += 1) {
            if (output[y * 32 + x] !== fixture.valueAt(x0 + x, y0 + y)) {
              throw new Error(`TIFF ${compression} ${tiled} mismatch at ${x0 + x},${y0 + y}`);
            }
          }
        };
        const measure = async (cold, count) => {
          const initial = await stats();
          const durations = [];
          let checksum = 0;
          for (let index = 0; index < count; index += 1) {
            if (cold) source.clear();
            const x = cold ? (index * 197) % (fixture.width - 32) : 30;
            const y = cold ? (index * 113) % (fixture.height - 32) : 20;
            const start = performance.now();
            const output = await readBandWindow(dataset.meta, source, 0, x, y, 32, 32, 1);
            durations.push(performance.now() - start);
            check(output, x, y);
            checksum += output[0] + output.at(-1);
          }
          const final = await stats();
          const usefulBytes = count * 32 * 32;
          const elapsedMs = durations.reduce((sum, value) => sum + value, 0);
          return { samples: count, checksum, p50Ms: Number(quantile(durations, 0.5).toFixed(3)),
            p95Ms: Number(quantile(durations, 0.95).toFixed(3)),
            throughputMiBPerSecond: Number((usefulBytes * 1000 / Math.max(elapsedMs, 0.001) / 1048576).toFixed(3)),
            browserBytes: final.browserBytes - initial.browserBytes,
            copiedBytes: backend === "fmap" ? final.copiedBytes - initial.copiedBytes : null,
            browserAmplification: Number(((final.browserBytes - initial.browserBytes) / usefulBytes).toFixed(3)),
            copyAmplification: backend === "fmap" ? Number(((final.copiedBytes - initial.copiedBytes) / usefulBytes).toFixed(3)) : null,
            usefulBytes };
        };
        const cold = await measure(true, 12);
        const warmup = await readBandWindow(dataset.meta, source, 0, 30, 20, 32, 32, 1);
        check(warmup, 30, 20);
        const warm = await measure(false, 20);
        const final = await stats();
        if (warm.browserBytes !== 0) throw new Error(`TIFF warm ${compression} ${tiled} reread file bytes`);
        if (backend === "fmap" && (final.peakReservationBytes > workingLimit || final.activeReservationBytes !== 0 || final.pinnedBytes !== 0)) {
          throw new Error(`TIFF ${compression} ${tiled} leaked/exceeded a decode reservation`);
        }
        if (backend === "fmap" && (final.fillActiveReads !== 0 || final.fillQueueRequests !== 0
            || final.peakFillActiveReads > ranges.concurrency)) {
          throw new Error(`TIFF ${compression} ${tiled} leaked/exceeded page-fill work`);
        }
        results.push({ compression, tiled, backend, dimensions: [fixture.width, fixture.height],
          poolBytes: 262144, workingLimitBytes: workingLimit, decodedCacheLimitBytes: source.decodedCacheLimitBytes ?? null,
          fileBytes: fixture.file.size, cold, warm, counters: final });
      } finally { dataset.cached.close(); dataset.base?.close(); }
    }
    return results;
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  console.log(json.trimEnd());
  if (outputPath) {
    const resolved = path.resolve(outputPath);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, json, "utf8");
  }
} finally {
  if (browser) await browser.close();
  if (server.exitCode == null) server.kill();
}
