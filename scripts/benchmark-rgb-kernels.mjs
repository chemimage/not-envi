import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import { chromium } from "@playwright/test";

const compiler = process.env.FMAP_CLANG;
if (!compiler) throw new Error("Set FMAP_CLANG to WASI SDK 24.0 clang.");
const compilerVersion = execFileSync(compiler, ["--version"], { encoding: "utf8" }).split(/\r?\n/)[0];
if (!compilerVersion.includes("clang version 18.1.2")) throw new Error(`Expected Clang 18.1.2: ${compilerVersion}`);
await mkdir("test-results", { recursive: true });
const flags = ["--target=wasm32-unknown-unknown", "-O3", "-msimd128", "-ffp-contract=off", "-nostdlib", "-fno-builtin",
  "-Wl,--no-entry", "-Wl,--export-memory", "-Wl,--export=__heap_base", "-Wl,--initial-memory=131072", "-Wl,--max-memory=268435456",
  "-o", "test-results/rgb-experiment.wasm", "scripts/rgb-experiment/rgb.c"];
execFileSync(compiler, flags, { stdio: "inherit" });
// Isolate the queue experiment: production source stays unchanged. Reuse is
// allowed only if this exact plane/revision is both acknowledged and present
// unchanged in the active job. Other cases keep the original full snapshot.
const clientBaselineCommit = "d320a5d83990b0c0eeb296bfab234b70322ffa7b";
const clientSource = execFileSync("git", ["show", `${clientBaselineCommit}:src/render/composition-worker-client.js`], { encoding: "utf8" });
const baselineClient = clientSource.replace("./workers/composition.worker.js?worker&inline", "../src/render/workers/composition.worker.js?worker&inline");
await writeFile("test-results/rgb-baseline-client.js", baselineClient);
const residentClient = baselineClient
  .replace("const previous = active ? null : known.get(planeId);", `const acknowledged = known.get(planeId);
      const inFlight = active?.planes.find(input => input.id === planeId);
      const stable = acknowledged && inFlight && !inFlight.full && !inFlight.patches.length
        && inFlight.w === raster.w && inFlight.h === raster.h
        && inFlight.revision === raster.revision && acknowledged.revision === raster.revision;
      const previous = !active || stable ? acknowledged : null;`);
if (residentClient === clientSource || !residentClient.includes("const stable = acknowledged")) throw new Error("Client experiment source no longer matches.");
await writeFile("test-results/rgb-resident-client.js", residentClient);
const origin = "http://127.0.0.1:4183";
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "4183", "--strictPort"], { windowsHide: true, stdio: "pipe" });
let log = "", browser;
server.stdout.on("data", c => { log += c; }); server.stderr.on("data", c => { log += c; });
try {
  const deadline = Date.now() + 20000;
  for (;;) {
    if (server.exitCode !== null || Date.now() > deadline) throw new Error(log);
    try { if ((await fetch(origin)).ok) break; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 100));
  }
  browser = await chromium.launch();
  const page = await browser.newPage(); await page.goto(origin);
  page.on("console", msg => { if (msg.type() === "log") console.log(msg.text()); });
  const reverse = process.env.RGB_BENCH_REVERSE === "1";
  const report = await page.evaluate(async ({ reverse }) => {
    const { reference, planar, fused } = await import("/scripts/rgb-experiment/kernels.js");
    const { createWasmKernel } = await import("/scripts/rgb-experiment/wasm.js");
    const { createCompositionWorkerClient } = await import("/test-results/rgb-baseline-client.js");
    const { createCompositionWorkerClient: residentWorkerClient } = await import("/test-results/rgb-resident-client.js");
    const bytes = await (await fetch("/test-results/rgb-experiment.wasm")).arrayBuffer();
    const scalar = await createWasmKernel(bytes, "scalar"), simd = await createWasmKernel(bytes, "simd");
    const p = () => [0, 1, 2].map(() => ({ minVal: 4, maxVal: 230, brightness: 0.03, gain: 1.1, contrast: 0.9 }));
    const summary = values => { const s = [...values].sort((a, b) => a - b); return { p50: s[Math.floor(s.length / 2)], p95: s[Math.ceil(s.length * 0.95) - 1] }; };
    let random = 1234, parityBytes = 0;
    const next = () => { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; return random >>> 0; };
    // Independent original JS oracle; Float32 bit patterns, half-byte boundaries,
    // odd tails, nonzero/odd rectangle origins and unchanged exterior sentinels.
    for (let trial = 0; trial < 64; trial++) {
      const w = 131, h = 67, n = w * h;
      const arrays = [0, 1, 2].map(() => {
        const bits = Uint32Array.from({ length: n }, () => next());
        const values = new Float32Array(bits.buffer);
        values.set([NaN, Infinity, -Infinity, -0, 0, 0.5, 255, 256]);
        for (let i = 16; i < 300; i++) values[i] = (i % 256 + 0.5) / 255;
        return values;
      });
      const rasters = arrays.map((dataF32, c) => ({ dataF32, w, h, compositionId: trial * 10 + c, revision: 1 }));
      const params = p();
      if (trial % 4 === 0) params.forEach(v => Object.assign(v, { minVal: 0, maxVal: 1, brightness: 0, gain: 1, contrast: 1 }));
      if (trial % 4 === 1) params[1].maxVal = params[1].minVal;
      if (trial % 4 === 2) Object.assign(params[2], { minVal: 230, maxVal: -100, brightness: -0.3, gain: -2, contrast: 3 });
      if (trial === 15) params[0].gain = NaN;
      if (trial >= 16) for (const tone of params) {
        Object.assign(tone, { minVal: (next() % 10000 - 5000) / 17, maxVal: (next() % 10000 - 5000) / 17,
          brightness: (next() % 2000 - 1000) / 199, gain: (next() % 2000 - 1000) / 399, contrast: (next() % 2000 - 1000) / 299 });
      }
      if (trial >= 56) Object.assign(params[trial % 3], [
        { minVal: Infinity }, { maxVal: -Infinity }, { contrast: Infinity }, { brightness: -Infinity },
        { gain: Infinity }, { minVal: NaN }, { maxVal: NaN }, { contrast: NaN }
      ][trial - 56]);
      const rect = trial % 2 ? { x: 3, y: 1, w: 125, h: 65 } : { x: 0, y: 0, w, h };
      for (const transparent of [false, true]) {
        const expected = new Uint8ClampedArray(n * 4).fill(73); reference(rasters, params, expected, w, rect, transparent);
        for (const [name, colorize] of [["planar", planar], ["fused", fused], ["scalar", scalar.colorize], ["simd", simd.colorize]]) {
          const dst = new Uint8ClampedArray(n * 4).fill(73); colorize(rasters, params, dst, w, rect, transparent);
          const mismatch = dst.findIndex((v, i) => v !== expected[i]);
          if (mismatch >= 0) throw new Error(`Parity ${name} trial=${trial} transparent=${transparent} offset=${mismatch}: ${dst[mismatch]} != ${expected[mismatch]}`);
          parityBytes += dst.length;
        }
      }
    }
    console.log(`Kernel parity passed: ${parityBytes} byte comparisons`);
    const results = [];
    for (const [w, h] of [[1024, 768], [2048, 1536]]) for (const workload of ["tone", "patch", "bgr-nodata"]) {
      const modes = ["reference", "planar", "fused", "wasm-scalar", "wasm-simd", "wasm-simd-resident"];
      if (reverse) modes.reverse();
      for (const mode of modes) {
        let metrics, wasm;
        const createClient = mode.endsWith("-resident") ? residentWorkerClient : createCompositionWorkerClient;
        const client = createClient({ fallback: () => { throw new Error("Unexpected fallback"); }, workerFactory: () => {
          const worker = new Worker(`/scripts/rgb-experiment/worker.js?mode=${mode.replace("-resident", "")}`, { type: "module" });
          worker.addEventListener("error", event => console.log(`Worker ${mode}: ${event.message}`));
          worker.addEventListener("message", ({ data }) => { metrics = data.metrics; wasm = data.wasm; });
          return worker;
        } });
        const rasters = [0, 1, 2].map(c => ({ w, h, compositionId: c + 100, revision: 1, previousRevision: 0, dirtyRects: [{ x: 0, y: 0, w, h }],
          dataF32: Float32Array.from({ length: w * h }, (_, i) => workload === "bgr-nodata" && i % 997 === 0 ? NaN : (i * 17 + c * 61) % 4096 / 16) }));
        const params = p(), opts = { transparentNoData: workload === "bgr-nodata" }, channels = workload === "bgr-nodata" ? [...rasters].reverse() : rasters;
        const samples = Object.fromEntries(["submit", "roundTrip", "ingest", "color", "upload", "bitmap", "presentation", "timerDelay"].map(k => [k, []]));
        const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d"); let cold;
        try {
          for (let frame = 0; frame < 24; frame++) {
            if (frame) {
              if (workload === "patch") for (const raster of rasters) {
                raster.previousRevision = raster.revision; raster.revision++;
                raster.dirtyRects = [{ x: 1, y: 1, w: 127, h: 95 }];
                for (let y = 1; y < 96; y++) raster.dataF32.fill(frame, y * w + 1, y * w + 128);
              } else params[1].brightness = 0.03 + frame / 1000;
            }
            const start = performance.now();
            const tick = new Promise(r => setTimeout(() => r(performance.now() - start), 0));
            const pending = client.compose(channels, params, opts);
            const submit = performance.now() - start;
            const bitmap = await pending, elapsed = performance.now() - start;
            let now = performance.now(); ctx.clearRect(0, 0, w, h); ctx.drawImage(bitmap, 0, 0); bitmap.close();
            const presentation = performance.now() - now, timerDelay = await tick;
            if (!frame) cold = { submit, roundTrip: elapsed, ...metrics };
            if (frame >= 8) {
              const values = { submit, roundTrip: elapsed, ...metrics, presentation, timerDelay };
              for (const key of Object.keys(samples)) samples[key].push(values[key]);
            }
          }
          const expected = new Uint8ClampedArray(w * h * 4); reference(channels, params, expected, w, { x: 0, y: 0, w, h }, opts.transparentNoData);
          const actual = ctx.getImageData(0, 0, w, h).data;
          if (actual.some((v, i) => v !== expected[i])) throw new Error(`Worker parity ${mode} ${workload} ${w}`);
          let burst;
          if (w === 2048 && workload === "tone") {
            const submitTimes = [], jobs = [], beforeTransfer = client.stats.transferredBytes;
            const start = performance.now();
            for (let change = 0; change < 12; change++) {
              params[1].brightness = 0.15 + change * 0.003;
              const t = performance.now();
              jobs.push(client.compose(channels, params, opts).then(bitmap => ({ bitmap }), error => ({ error: error.name })));
              submitTimes.push(performance.now() - t);
            }
            const submissionCpuMs = performance.now() - start;
            const settled = await Promise.all(jobs), elapsedMs = performance.now() - start;
            const delivered = settled.filter(job => job.bitmap);
            if (delivered.length !== 1 || settled.slice(0, -1).some(job => job.error !== "AbortError")) throw new Error("Burst stale-result handling");
            ctx.clearRect(0, 0, w, h); ctx.drawImage(settled.at(-1).bitmap, 0, 0); settled.at(-1).bitmap.close();
            reference(channels, params, expected, w, { x: 0, y: 0, w, h }, false);
            const last = ctx.getImageData(0, 0, w, h).data;
            if (last.some((v, i) => v !== expected[i])) throw new Error("Burst final pixel parity");
            burst = { changes: 12, submissionCpuMs, elapsedMs, perSubmitMs: summary(submitTimes),
              canceled: settled.filter(job => job.error === "AbortError").length,
              transferredBytes: client.stats.transferredBytes - beforeTransfer, latestResultParity: true };
            console.log(`Burst ${mode}: ${JSON.stringify(burst)}`);
          }
          const result = { w, h, workload, mode, burst, coldMs: cold, samples: 16, timingMs: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, summary(v)])), wasm,
            transferBytes: client.stats.transferredBytes, sourcePlaneBytes: w * h * 12, rgbaBytes: w * h * 4, finalPixelParity: true };
          results.push(result);
          console.log(JSON.stringify({ w, workload, mode, color: result.timingMs.color, roundTrip: result.timingMs.roundTrip }));
        } finally { client.dispose(); }
      }
    }
    return { userAgent: navigator.userAgent, parityBytes, results };
  }, { reverse });
  const output = process.argv[2] || "docs/benchmarks/rgb-kernels-intrinsics-2026-11-13.json";
  await mkdir("docs/benchmarks", { recursive: true });
  const metadata = { date: new Date().toISOString(), commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), cpu: cpus()[0].model,
    compiler: compilerVersion, flags,
    reverseCandidateOrder: reverse, clientBaselineCommit,
    clientBaselineSha256: createHash("sha256").update(clientSource).digest("hex"),
    sourceSha256: Object.fromEntries(await Promise.all(["scripts/benchmark-rgb-kernels.mjs", "scripts/rgb-experiment/rgb.c", "scripts/rgb-experiment/kernels.js",
      "scripts/rgb-experiment/compositor.js", "scripts/rgb-experiment/worker.js", "scripts/rgb-experiment/wasm.js", "src/render/composition-worker-client.js"].map(async file =>
      [file, createHash("sha256").update(await readFile(file)).digest("hex")]))),
    wasmSha256: createHash("sha256").update(await readFile("test-results/rgb-experiment.wasm")).digest("hex"),
    limitations: "Sequential worker timings: 8 startup/warmup + 16 measured. Separate synchronous 12-tone-change burst checks coalescing, obsolete promise rejection and final pixels. Explicit WASM staging and RGBA copy included. Prototype worker mirrors production protocol but omits eviction (3 planes retained). Double-precision SIMD, no relaxed math. GPU completion is not fenced; presentation measures submission only. No application-integrated WASM packaging, fallback, eviction or lifecycle validation. Candidate client reuse tested only in these synthetic workloads.", ...report };
  await writeFile(output, JSON.stringify(metadata, null, 2) + "\n");
  console.log(`Saved ${output}`);
} finally { await browser?.close(); server.kill(); }
