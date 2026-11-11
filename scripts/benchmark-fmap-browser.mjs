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
    const source = createFmapDataSource(file, meta, {
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
    });
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
      "cacheEvictions", "sparseReads", "batches", "cancelledRequests"
    ];
    const deltaStats = (before, after) => Object.fromEntries(statsKeys.map((key) => [
      key,
      Number(after?.[key] || 0) - Number(before?.[key] || 0)
    ]));
    const measure = async (name, operations, usefulBytes) => {
      const before = await source.getStats();
      const durations = [];
      let checksum = 0;
      for (const operation of operations) {
        const started = performance.now();
        const output = await operation();
        durations.push(performance.now() - started);
        operation.verify?.(output);
        checksum += Number(output?.[0] || 0) + Number(output?.[output.length - 1] || 0);
      }
      const after = await source.getStats();
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
    const checkedWindow = (band, x, y, width, height, step, options) => {
      const operation = () => source.readBandWindow(
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
      return {
        disclaimer: "Browser workload report only; latency is descriptive and has no pass/fail speed threshold.",
        userAgent: navigator.userAgent,
        config: {
          fileBytes: file.size,
          dimensions: [samples, lines, bands],
          pageBytes: 64 * 1024,
          poolBytes: 512 * 1024
        },
        workloads: { cold, warm, pan, sparseSpectrum, baselineSpectrum },
        sparseSpectrumComparison: { fmap: sparseSpectrum, chunkCache: baselineSpectrum },
        finalStats
      };
    } finally {
      source.close();
      baselineSource.close();
    }
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
