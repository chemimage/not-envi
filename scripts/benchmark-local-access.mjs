import { spawn, execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, stat, open } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "@playwright/test";

const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const manifestPath = argument("--manifest", "");
if (!manifestPath) throw new Error("Provide --manifest with SSD/HDD fp32Header, fp32Data, and color file paths.");
const manifest = JSON.parse((await readFile(manifestPath, "utf8")).replace(/^\uFEFF/, ""));
const output = argument("--output", "test-results/local-browser-access.json");
const port = Number(argument("--port", "4181"));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let serverLog = "", browser;
server.stdout.on("data", (chunk) => { serverLog += chunk; });
server.stderr.on("data", (chunk) => { serverLog += chunk; });
const report = { timestamp: new Date().toISOString(), commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  method: "Actual disk-backed File objects selected through Playwright, production ENVI/TIFF loaders and fmap configuration. No source writes.",
  cacheCaveat: "Browser reads use the Windows file cache. First-pass means only first pass in this benchmark, not cold physical storage. fmap-cold clears only fmap's cache. Warm repeats use identical requests.",
  results: [], ui: [] };

const save = async () => { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + "\n"); };

async function runFile(device, kind) {
  const files = kind === "fp32" ? [device.fp32Header, device.fp32Data] : [device.color];
  const before = await Promise.all(files.map(async (file) => { const info = await stat(file); return { name: path.basename(file), size: info.size, mtimeMs: info.mtimeMs }; }));
  const page = await browser.newPage();
  page.setDefaultTimeout(180000);
  page.on("console", (message) => { if (message.type() === "log" && message.text().startsWith("{\"device\"")) console.log(message.text()); });
  await page.goto(origin);
  await page.evaluate(() => {
    const input = document.createElement("input"); input.id = "benchmarkFiles"; input.type = "file"; input.multiple = true;
    input.hidden = true; document.body.append(input);
  });
  await page.locator("#benchmarkFiles").setInputFiles(files);
  const result = await page.evaluate(async ({ kind, label }) => {
    const { APP_CONFIG, resolveHardwareConcurrencyLimit } = await import("/src/app/config.js");
    const { addDatasetFromFiles } = await import("/src/io/envi-loader.js");
    const { addDatasetFromFile } = await import("/src/io/tiff-loader.js");
    const { readBandWindow, readBandWindowBIP, pixelOffset } = await import("/src/core/raster-io.js");
    const { readSpectrumAtPixel } = await import("/src/render/spectrum-data.js");
    const files = Array.from(document.querySelector("#benchmarkFiles").files);
    const file = files.at(-1);
    const rows = [];
    const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
    const summarize = (name, phase, durations, usefulBytes, extra = {}) => ({ name, phase, samples: durations.length, durationsMs: durations,
      p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95), totalMs: durations.reduce((a, b) => a + b, 0), usefulBytes, ...extra });
    let seed = 0x34d92bc1;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    for (const [name, bytes, count, sequential] of [["file-random-64KiB", 65536, 64, false], ["file-sequential-8MiB", 8388608, 32, true]]) {
      const offsets = Array.from({ length: count }, (_, i) => sequential ? 1024 * 1024 * 768 + i * bytes : Math.floor(random() * (file.size - bytes)));
      for (const phase of ["first-pass-os-cache-unknown", "repeat-os-cache-warm"]) {
        const durations = []; let checksum = 0;
        for (const offset of offsets) {
          const start = performance.now();
          const data = new Uint8Array(await file.slice(offset, offset + bytes).arrayBuffer());
          durations.push(performance.now() - start);
          if (data.length !== bytes) throw new Error("Short File read");
          checksum += data[0] + data.at(-1);
        }
        rows.push(summarize(name, phase, durations, bytes * count, { offsets, checksum }));
      }
    }
    const ioConcurrency = resolveHardwareConcurrencyLimit({ fraction: APP_CONFIG.io.hardwareCoreFraction,
      min: APP_CONFIG.io.hardwareParallelMin, max: APP_CONFIG.io.maxConcurrency });
    const wasm = await (await fetch("/wasm/fmap/pkg/fmap_core.wasm")).arrayBuffer();
    const deps = { fmapEnabled: true, fmapOptions: APP_CONFIG.fmap, fmapWasmBytes: wasm, ioConcurrency,
      createDataset: (descriptor) => descriptor };
    const openStart = performance.now();
    const descriptor = kind === "fp32" ? await addDatasetFromFiles(files[0], files[1], deps) : await addDatasetFromFile(file, deps);
    const openMs = performance.now() - openStart;
    const { meta, cached: source } = descriptor;
    await source.ready;
    const read = meta.interleave === "bip" ? readBandWindowBIP : readBandWindow;
    const bands = kind === "fp32" ? [0] : [2, 1, 0]; // Same planes, BGR display ordering.
    const verify = async (output, window, selectedBands = bands) => {
      let checked = 0;
      for (let b = 0; b < selectedBands.length; b++) {
        for (const index of [0, Math.floor(output[b].length / 2), output[b].length - 1]) {
          const x = window.x + (index % window.w) * window.step;
          const y = window.y + Math.floor(index / window.w) * window.step;
          const offset = pixelOffset(meta, x, y, selectedBands[b]);
          const view = new DataView(await file.slice(offset, offset + meta.dataTypeInfo.bytes).arrayBuffer());
          const expected = kind === "fp32" ? view.getFloat32(0, meta.littleEndian) : view.getUint8(0);
          const actual = output[b][index];
          if (!(Object.is(actual, expected) || (Number.isNaN(actual) && Number.isNaN(expected)))) throw new Error(`Value mismatch: ${actual} vs ${expected}`);
          checked++;
        }
      }
      return checked;
    };
    const statDelta = (before, after) => Object.fromEntries(Object.keys(after).filter((key) => Number.isFinite(after[key]) && Number.isFinite(before[key]))
      .map((key) => [key, after[key] - before[key]]));
    const overviewStep = Math.ceil(meta.samples / 512);
    const scenarios = [
      { name: "native-tile-128", windows: Array.from({ length: 16 }, () => ({ x: Math.floor(random() * (meta.samples - 128)), y: Math.floor(random() * (meta.lines - 128)), w: 128, h: 128, step: 1 })) },
      { name: "native-roi-512", windows: Array.from({ length: 8 }, () => ({ x: Math.floor(random() * (meta.samples - 512)), y: Math.floor(random() * (meta.lines - 512)), w: 512, h: 512, step: 1 })) },
      { name: "whole-image-overview-512", windows: [{ x: 0, y: 0, w: Math.ceil(meta.samples / overviewStep), h: Math.ceil(meta.lines / overviewStep), step: overviewStep }] }
    ];
    let verifiedValues = 0;
    for (const scenario of scenarios) {
      source.clear(); await source.getStats();
      for (const phase of ["fmap-cold-os-cache-unknown", "fmap-warm-1", "fmap-warm-2"]) {
        const before = await source.getStats();
        const durations = [], outputs = [];
        let usefulBytes = 0, returnedBytes = 0;
        for (const window of scenario.windows) {
          const start = performance.now();
          const output = await Promise.all(bands.map((band) => read(meta, source, band,
            window.x, window.y, window.w, window.h, window.step, ioConcurrency)));
          durations.push(performance.now() - start);
          usefulBytes += window.w * window.h * bands.length * meta.dataTypeInfo.bytes;
          returnedBytes += output.reduce((sum, data) => sum + data.byteLength, 0);
          outputs.push(output);
        }
        const after = await source.getStats();
        const delta = statDelta(before, after);
        const record = summarize(scenario.name, phase, durations, usefulBytes, {
          returnedBytes, stats: delta, browserAmplification: delta.browserBytes / usefulBytes, windows: scenario.windows });
        // Validation is outside the measured time/counters and happens after
        // the cold phase, so it cannot prime that phase's requested ranges.
        for (let i = 0; i < outputs.length; i++) verifiedValues += await verify(outputs[i], scenario.windows[i]);
        rows.push(record);
        console.log(JSON.stringify({ device: label, kind, name: record.name, phase, p50Ms: record.p50Ms, browserBytes: delta.browserBytes }));
      }
    }
    source.clear(); await source.getStats();
    const points = Array.from({ length: 24 }, () => ({ x: Math.floor(random() * meta.samples), y: Math.floor(random() * meta.lines) }));
    for (const phase of ["fmap-cold-os-cache-unknown", "fmap-warm"]) {
      const before = await source.getStats(), durations = [];
      let checksum = 0;
      for (const point of points) {
        const start = performance.now();
        const values = await readSpectrumAtPixel({ meta, ds: source }, point.x, point.y, ioConcurrency);
        durations.push(performance.now() - start);
        for (const value of values) if (Number.isFinite(value)) checksum += value;
      }
      rows.push(summarize("point-all-bands", phase, durations, points.length * meta.bands * meta.dataTypeInfo.bytes,
        { stats: statDelta(before, await source.getStats()), points, checksum }));
    }
    const finalStats = await source.getStats();
    source.close();
    return { device: label, kind, file: { name: file.name, size: file.size, lastModified: file.lastModified },
      meta: { samples: meta.samples, lines: meta.lines, bands: meta.bands, dataType: meta.dataType, interleave: meta.interleave,
        headerOffset: meta.headerOffset, bytesPerValue: meta.dataTypeInfo.bytes },
      openMs, ioConcurrency, config: APP_CONFIG.fmap, verifiedValues, finalStats, rows,
      browser: { userAgent: navigator.userAgent, cores: navigator.hardwareConcurrency, memoryGiB: navigator.deviceMemory } };
  }, { kind, label: device.label });
  const after = await Promise.all(files.map(async (file) => { const info = await stat(file); return { name: path.basename(file), bytes: info.size, mtimeMs: info.mtimeMs }; }));
  result.sourceUnchanged = before.every((info, i) => info.size === after[i].bytes && info.mtimeMs === after[i].mtimeMs);
  if (!result.sourceUnchanged) throw new Error("Source metadata changed during benchmark");
  report.results.push(result); await save(); await page.close();
}

async function runUi(device, kind) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  await page.addInitScript(() => {
    window.__accessUi = { started: 0, windowReplies: 0, paints: [], errors: [] };
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args); const requests = new Map();
        const post = this.postMessage.bind(this);
        this.postMessage = (message, ...rest) => { requests.set(message.id, message.type); return post(message, ...rest); };
        this.addEventListener("message", ({ data }) => {
          const type = requests.get(data.id); requests.delete(data.id);
          if (data.error) window.__accessUi.errors.push(data.error.message);
          if (type === "window" && data.result) window.__accessUi.windowReplies++;
        });
      }
    };
    const painted = (canvas, method) => {
      const state = window.__accessUi;
      if (state.started && state.windowReplies && ["cpuCanvas", "gpuCanvas"].includes(canvas?.id)) {
        state.paints.push({ ms: performance.now() - state.started, canvas: canvas.id, method });
      }
    };
    for (const method of ["drawImage", "putImageData"]) {
      const original = CanvasRenderingContext2D.prototype[method];
      CanvasRenderingContext2D.prototype[method] = function (...args) { const result = original.apply(this, args); painted(this.canvas, method); return result; };
    }
    for (const prototype of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
      const original = prototype.drawArrays;
      prototype.drawArrays = function (...args) { const result = original.apply(this, args); painted(this.canvas, "drawArrays"); return result; };
    }
  });
  await page.goto(origin);
  await page.evaluate(() => { window.__accessUi.started = performance.now(); });
  await page.locator("#filePicker").setInputFiles(kind === "fp32" ? [device.fp32Header, device.fp32Data] : [device.color]);
  await page.waitForFunction(() => window.__accessUi.paints.length > 0, null, { timeout: 180000 });
  const result = await page.evaluate(() => ({ ...window.__accessUi, input: document.querySelector("#filePicker").value }));
  report.ui.push({ device: device.label, kind, cache: "fresh viewer; Windows cache uncontrolled and possibly warm from earlier access tests", ...result });
  console.log(JSON.stringify({ device: device.label, kind, firstPaintMs: result.paints[0].ms }));
  await save(); await page.close();
}

try {
  const deadline = Date.now() + 20000;
  for (;;) {
    if (server.exitCode !== null || Date.now() > deadline) throw new Error(serverLog);
    try { if ((await fetch(origin)).ok) break; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true });
  report.chromium = browser.version();
  for (const kind of ["fp32", "color"]) for (const device of manifest) {
    console.log(`Access benchmark: ${device.label} ${kind}`);
    await runFile(device, kind);
  }
  for (const kind of ["fp32", "color"]) for (const device of manifest) await runUi(device, kind);
  // Small disjoint fingerprints establish correspondence without reading every
  // gigabyte or populating the entire OS cache before the measured operations.
  report.correspondence = [];
  const { createHash } = await import("node:crypto");
  for (const kind of ["fp32Data", "color"]) {
    const fingerprints = [];
    for (const device of manifest) {
      const handle = await open(device[kind], "r");
      const info = await handle.stat(); const hash = createHash("sha256");
      try {
        for (let i = 0; i < 32; i++) {
          const buffer = Buffer.alloc(4096), position = Math.floor(i / 32 * (info.size - 4096));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          if (bytesRead !== buffer.length) throw new Error("Short fingerprint read"); hash.update(buffer);
        }
      } finally { await handle.close(); }
      fingerprints.push({ device: device.label, bytes: info.size, sampledSha256: hash.digest("hex") });
    }
    report.correspondence.push({ kind, sampledRegions: 32, bytesPerRegion: 4096, fingerprints,
      sampledBytesMatch: fingerprints.every((value) => value.sampledSha256 === fingerprints[0].sampledSha256) });
  }
  await save(); console.log(`Report: ${output}`);
} finally { await browser?.close(); server.kill(); }
