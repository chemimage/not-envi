// Current production worker versus the shared synchronous JS compositor.
import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";

const origin = "http://127.0.0.1:4182";
const output = process.argv[2] || "test-results/rgb-composition.json";
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "4182", "--strictPort"],
  { windowsHide: true, stdio: "pipe" });
let browser;
let log = "";
server.stdout.on("data", chunk => { log += chunk; });
server.stderr.on("data", chunk => { log += chunk; });
try {
  const deadline = Date.now() + 20000;
  for (;;) {
    if (server.exitCode !== null || Date.now() > deadline) throw new Error(log);
    try { if ((await fetch(origin)).ok) break; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(origin);
  const results = await page.evaluate(async () => {
    const { createRgbCompositor } = await import("/src/render/rgb-composition.js");
    const { createCompositionWorkerClient } = await import("/src/render/composition-worker-client.js");
    const { tone01 } = await import("/src/render/display-math.js");
    const summary = values => {
      const sorted = [...values].sort((a, b) => a - b);
      return { p50: sorted[Math.floor(sorted.length * 0.5)], p95: sorted[Math.ceil(sorted.length * 0.95) - 1] };
    };
    const results = [];
    for (const [w, h] of [[512, 384], [1024, 768], [2048, 1536]]) {
      for (const mode of ["tone", "patch", "bgr-nodata"]) {
        let uploadMs = 0;
        const reference = createRgbCompositor({ tone01, createImageData: (w, h) => new ImageData(w, h),
          createCanvas: () => {
            const canvas = document.createElement("canvas");
            const native = canvas.getContext.bind(canvas);
            canvas.getContext = (...args) => {
              const ctx = native(...args), put = ctx.putImageData.bind(ctx);
              ctx.putImageData = (...values) => { const t = performance.now(); put(...values); uploadMs += performance.now() - t; };
              return ctx;
            };
            return canvas;
          } });
        const client = createCompositionWorkerClient({ fallback: () => { throw new Error("Worker fallback"); } });
        const rasters = [0, 1, 2].map(band => ({ compositionId: band + 1, revision: 1, previousRevision: 0, w, h,
          dataF32: Float32Array.from({ length: w * h }, (_, i) => mode === "bgr-nodata" && i % 997 === 0 ? NaN : ((i * 17 + band * 61) % 4096) / 16),
          dirtyRects: [{ x: 0, y: 0, w, h }] }));
        const params = [0, 1, 2].map(() => ({ minVal: 4, maxVal: 230, brightness: 0.03, gain: 1.1, contrast: 0.9 }));
        const channels = mode === "bgr-nodata" ? [...rasters].reverse() : rasters;
        const opts = { transparentNoData: mode === "bgr-nodata" };
        const presentation = document.createElement("canvas"); presentation.width = w; presentation.height = h;
        const ctx = presentation.getContext("2d");
        const timings = Object.fromEntries(["kernelAndBookkeeping", "canvasUpload", "bitmap", "present", "submit", "workerRoundTrip", "timerDelay"].map(key => [key, []]));
        let cold, canvas, burst;
        try {
          for (let frame = 0; frame < 26; frame++) {
            if (frame) {
              if (mode === "patch") for (const raster of rasters) {
                raster.previousRevision = raster.revision; raster.revision++;
                raster.dirtyRects = [{ x: 0, y: 0, w: 128, h: 96 }];
                for (let y = 0; y < 96; y++) raster.dataF32.fill(frame, y * w, y * w + 128);
              }
              else params[1].brightness = 0.03 + frame / 1000;
            }
            uploadMs = 0;
            let t = performance.now(); canvas = reference.compose(channels, params, opts);
            const compose = performance.now() - t;
            t = performance.now(); const bitmap = await createImageBitmap(canvas);
            const bitmapMs = performance.now() - t;
            t = performance.now(); ctx.clearRect(0, 0, w, h); ctx.drawImage(bitmap, 0, 0); bitmap.close();
            const present = performance.now() - t;
            const start = performance.now();
            const tick = new Promise(resolve => setTimeout(() => resolve(performance.now() - start), 0));
            const pending = client.compose(channels, params, opts);
            const submit = performance.now() - start;
            const drawable = await pending;
            const elapsed = performance.now() - start;
            const timerDelay = await tick;
            if (!frame) cold = { composeMs: compose, workerRoundTripMs: elapsed, submitMs: submit };
            if (frame >= 6) {
              const values = [compose - uploadMs, uploadMs, bitmapMs, present, submit, elapsed, timerDelay];
              Object.keys(timings).forEach((key, i) => timings[key].push(values[i]));
            }
            if (frame === 25) {
              ctx.clearRect(0, 0, w, h); ctx.drawImage(drawable, 0, 0);
              const actual = ctx.getImageData(0, 0, w, h).data;
              const expected = canvas.getContext("2d").getImageData(0, 0, w, h).data;
              if (actual.some((v, i) => v !== expected[i])) throw new Error(`Pixel mismatch: ${w} ${mode}`);
            }
            drawable.close();
          }
          if (!client.usingWorker()) throw new Error("Not using worker");
          if (w === 2048 && mode === "tone") {
            const jobs = [], beforePacked = client.stats.packedBytes, beforeTransfer = client.stats.transferredBytes;
            const start = performance.now();
            for (let change = 0; change < 12; change++) {
              params[1].brightness = 0.15 + change * 0.003;
              jobs.push(client.compose(channels, params, opts).then(bitmap => ({ bitmap }), error => ({ error: error.name })));
            }
            const submissionCpuMs = performance.now() - start;
            const settled = await Promise.all(jobs), elapsedMs = performance.now() - start;
            if (settled.slice(0, -1).some(job => job.error !== "AbortError") || !settled.at(-1).bitmap) throw new Error("Burst cancellation failed");
            ctx.clearRect(0, 0, w, h); ctx.drawImage(settled.at(-1).bitmap, 0, 0); settled.at(-1).bitmap.close();
            const actual = ctx.getImageData(0, 0, w, h).data;
            const expected = reference.compose(channels, params, opts).getContext("2d").getImageData(0, 0, w, h).data;
            if (actual.some((v, i) => v !== expected[i])) throw new Error("Burst pixel mismatch");
            burst = { changes: 12, submissionCpuMs, elapsedMs, canceled: settled.filter(job => job.error === "AbortError").length,
              packedBytes: client.stats.packedBytes - beforePacked, transferredBytes: client.stats.transferredBytes - beforeTransfer, latestResultParity: true };
          }
          results.push({ w, h, mode, burst, samples: 20, cold, timingsMs: Object.fromEntries(Object.entries(timings).map(([key, values]) => [key, summary(values)])),
            sourcePlaneBytes: w * h * 12, rgbaBytes: w * h * 4, workerStats: { ...client.stats }, finalFramePixelParity: true });
        } finally { client.dispose(); reference.clear(); }
      }
    }
    return { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, results };
  });
  const report = { date: new Date().toISOString(), commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceSha256: Object.fromEntries(await Promise.all(["scripts/benchmark-rgb-composition.mjs", "src/render/rgb-simd.js", "src/render/workers/composition.worker.js", "src/render/composition-worker-client.js", "wasm/rgb/pkg/rgb.wasm"].map(async file => [file, createHash("sha256").update(await readFile(file)).digest("hex")]))),
    scope: "Production worker versus synchronous JS compositor. Sequential synthetic frames: 6 cold/warmup + 20 measured; separate 12-tone-change burst. Kernel timing is synchronous JS including bookkeeping; worker RTT includes actual SIMD staging and delivery. Canvas presentation is submission, not GPU-fenced completion. Memory counters describe owned allocations, not browser/process memory.", ...results };
  await mkdir(output.replace(/[/\\][^/\\]+$/, ""), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); server.kill(); }
