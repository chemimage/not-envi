import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "@playwright/test";

// Controlled queue/service benchmark, not a drive-throughput benchmark. Actual
// production modules and C/WASM run in Chromium. A fixed provider delay makes
// cancellation observable before a read completes; pyramid reads are held until
// explicitly released. Known unsupported focus cancellation is reported, not
// silently counted as a successful abort. No source modules are changed on disk.
const origin = `http://127.0.0.1:${Number(process.env.FMAP_QUEUE_BENCHMARK_PORT || 4177)}`;
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex < 0 ? null : process.argv[outputIndex + 1];
if (outputIndex >= 0 && !output) throw new Error("--output requires a report path.");
const server = spawn(process.execPath, [path.resolve("node_modules/vite/bin/vite.js"),
  "--host", "127.0.0.1", "--port", new URL(origin).port, "--strictPort"], { stdio: "pipe" });
let logs = "";
server.stdout.on("data", (bytes) => { logs += bytes; });
server.stderr.on("data", (bytes) => { logs += bytes; });
let browser;
try {
  const deadline = Date.now() + 20000;
  while (true) {
    if (server.exitCode != null || Date.now() > deadline) throw new Error(`Queue benchmark server failed.\n${logs}`);
    try { if ((await fetch(origin)).ok) break; } catch { /* Server startup. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch();
  const context = await browser.newContext();
  const providerDelayMs = 100;
  await context.route("**/src/io/fmap/fmap.worker.js*", async (route) => {
    if (!route.request().url().includes("worker_file")) return route.continue();
    const response = await route.fetch();
    let body = await response.text();
    const needle = "async function readFile(file, pageSize, stats, offset, length) {";
    if (!body.includes(needle)) throw new Error("Provider timing instrumentation did not match.");
    body = body.replace(needle, `${needle}\n await new Promise(resolve => setTimeout(resolve, ${providerDelayMs}));`);
    await route.fulfill({ response, body });
  });
  await context.route("**/src/render/pyramid-cache.js*", async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    const replacements = [
      ['function clearQueuedFocusTasks(pyr) {', 'function clearQueuedFocusTasks(pyr) { const benchStart = performance.now(); const benchCount=pyr.qHi.length+pyr.qLo.length;'],
      ['clearTaskQueue(pyr, "qLo");', 'clearTaskQueue(pyr, "qLo"); globalThis.__queueMetrics.push({kind:"clear",ms:performance.now()-benchStart,count:benchCount});'],
      ['function enqueueViewportTasks(ds, band, minLevel, eff, viewportW, viewportH) {', 'function enqueueViewportTasks(ds, band, minLevel, eff, viewportW, viewportH) { const benchStart = performance.now();'],
      ['return levels;\n  }', 'globalThis.__queueMetrics.push({kind:"enqueue",ms:performance.now()-benchStart,count:levels.reduce((sum,level)=>sum+level.tasks.length,0)}); return levels;\n  }'],
      ['pyr.foregroundDirty = false;', 'const benchStart = performance.now(); pyr.foregroundDirty = false;'],
      ['pyr.qHi = ranked.map(({ task }) => task);', 'pyr.qHi = ranked.map(({ task }) => task); globalThis.__queueMetrics.push({kind:"sort",ms:performance.now()-benchStart,count:ranked.length});']
    ];
    for (const [needle, replacement] of replacements) {
      if (!body.includes(needle)) throw new Error(`Queue instrumentation did not match: ${needle}`);
      body = body.replace(needle, replacement);
    }
    await route.fulfill({ response, body });
  });
  const page = await context.newPage();
  await page.addInitScript(() => { globalThis.__queueMetrics = []; });
  await page.goto(`${origin}/?fmap=1`);
  const report = await page.evaluate(async ({ providerDelayMs }) => {
    const { createFmapRangeDataSource } = await import("/src/io/fmap/index.js");
    const { FmapPageFillQueue } = await import("/src/io/fmap/page-fill-queue.js");
    const { createPyramidController } = await import("/src/render/pyramid-cache.js");
    const wasmBytes = await (await fetch("/wasm/fmap/pkg/fmap_core.wasm")).arrayBuffer();
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const until = async (condition) => {
      const end = performance.now() + 5000;
      while (!await condition()) { check(performance.now() < end, "Queue benchmark timed out."); await tick(); }
    };
    const settle = (promise) => promise.then(() => "fulfilled", (error) => error.name);
    const summary = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      return { samples: sorted.length, p50Ms: Number(sorted[Math.floor(sorted.length * 0.5)].toFixed(3)),
        p95Ms: Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))].toFixed(3)) };
    };
    const sourceFor = (logicalBytes = 1048576) => createFmapRangeDataSource(
      new File([new Uint8Array(1048576).fill(7)], "queue-probe.bin"), {
        wasmBytes, pageSize: 4096, poolBytes: 16384, concurrency: 1,
        maxResultBytes: 4096, maxInflightBytes: 16384, maxQueuedRequests: 2,
        maxQueuedBytes: 16384, maxLogicalResultBytes: 4096, maxLogicalBytes: logicalBytes
      });
    const counters = (source) => ({ active: source.active, queued: source.queue.length,
      waiting: source.waitingRequests.length, logicalWaiters: source.logicalWaiters.length });
    const drained = (s) => s.activeRequests === 0 && s.queuedRequests === 0 && s.waitingRequests === 0
      && s.waitingLogicalRequests === 0 && s.fillActiveReads === 0 && s.fillQueueRequests === 0
      && s.fillParkedRequests === 0 && s.pinnedBytes === 0 && s.logicalBytesReserved === 0;
    const client = [];
    for (const { logicalLimit, cancellation } of [
      { logicalLimit: 1048576, cancellation: "AbortSignal" },
      { logicalLimit: 4096, cancellation: "AbortSignal" },
      { logicalLimit: 1048576, cancellation: "callback" },
      { logicalLimit: 4096, cancellation: "callback" }
    ]) {
      const rounds = [];
      for (let round = 0; round < 5; round += 1) {
        const source = sourceFor(logicalLimit);
        try {
          await source.ready;
          const controllers = Array.from({ length: 16 }, () => new AbortController());
          const obsolete = Array(16).fill(false);
          const promises = controllers.map((controller, index) => settle(source.readRange(index * 4096, 4096, null,
            cancellation === "AbortSignal" ? { signal: controller.signal } : { cancelled: () => obsolete[index] })));
          await until(() => source.active === 1 && source.queue.length + source.logicalWaiters.length > 0);
          const before = counters(source);
          const start = performance.now();
          controllers.slice(1).forEach((controller, index) => {
            if (cancellation === "AbortSignal") controller.abort();
            else obsolete[index + 1] = true;
          });
          const cancelled = await Promise.all(promises.slice(1));
          const cancelMs = performance.now() - start;
          check(cancelled.every((status) => status === "AbortError"), "Queued cancellation returned data.");
          const after = counters(source);
          check(after.queued + after.waiting + after.logicalWaiters === 0, "Cancelled client descriptors retained.");
          check(await promises[0] === "fulfilled", "Uncancelled read failed.");
          let final;
          await until(async () => { final = await source.getStats(); return drained(final); });
          check(final.readCalls === 1, "Cancelled queued work reached the provider.");
          rounds.push({ before, after, cancelled: cancelled.length, cancelMs, providerReads: final.readCalls });
        } finally { source.close(); }
      }
      client.push({ cancellation, stage: logicalLimit === 4096 ? "logical-output-waiters" : "execution-queue-and-admission-waiters",
        latency: summary(rounds.map((row) => row.cancelMs)), rounds });
    }
    const source = sourceFor();
    let activeCancellation;
    try {
      await source.ready;
      const abort = new AbortController();
      const pending = settle(source.readRange(0, 4096, null, { signal: abort.signal }));
      await until(async () => (await source.getStats()).fillActiveReads === 1);
      const start = performance.now(); abort.abort();
      check(await pending === "AbortError", "Active job did not cancel.");
      const rejectionMs = performance.now() - start;
      const acknowledged = await source.getStats();
      const nextStart = performance.now();
      const value = await source.readRange(4096, 4096);
      check(value[0] === 7 && value.length === 4096, "Foreground read after cancel returned wrong data.");
      const nextReadMs = performance.now() - nextStart;
      let final;
      await until(async () => { final = await source.getStats(); return drained(final); });
      activeCancellation = { rejectionMs, providerReads: final.readCalls, nextReadMs,
        afterAcknowledgement: { activeRequests: acknowledged.activeRequests,
          activeProviderReads: acknowledged.fillActiveReads, pinnedBytes: acknowledged.pinnedBytes },
        drained: drained(final), physicalReadAborted: false };
    } finally { source.close(); }

    const pages = [];
    for (const count of [128, 512, 2048]) {
      for (let round = 0; round < 5; round += 1) {
        const { instance } = await WebAssembly.instantiate(wasmBytes, {});
        const core = instance.exports;
        check(core.fmap_init(4096, 4) === 0, "Page pool initialization failed.");
        const tasks = [], reads = [];
        const queue = new FmapPageFillQueue({ core, fileSize: count * 4096, pageSize: 4096,
          concurrency: 1, maxQueuedRequests: 2, maxQueuedBytes: 8192,
          postTask: (task) => tasks.push(task), readFile: (offset, length) => new Promise((resolve) => reads.push({ offset, length, resolve })) });
        try {
          const start = performance.now();
          const requests = Array.from({ length: count }, (_, index) => queue.request({
            pageIndex: index, offset: 0, length: 64, requestId: index }));
          const promises = requests.map((request) => request.promise.then((lease) => lease, (error) => error.name));
          const enqueueMs = performance.now() - start;
          tasks.shift()(); await tick();
          check(reads.length === 1, "Provider did not start exactly one held read.");
          const before = queue.getStats();
          const cancelStart = performance.now();
          requests.slice(1).forEach((request) => request.cancel());
          const cancelled = await Promise.all(promises.slice(1));
          const cancelMs = performance.now() - cancelStart;
          check(cancelled.every((status) => status === "AbortError"), "Parked/admitted page cancellation failed.");
          reads[0].resolve(new Uint8Array(reads[0].length).fill(7));
          const lease = await promises[0]; lease.release(); await tick();
          check(reads.length === 1 && core.fmap_pinned_bytes() === 0, "Cancelled page work issued I/O or leaked pins.");
          pages.push({ count, round, enqueueMs, cancelMs, queuedBefore: before.fillQueueRequests,
            parkedBefore: before.fillParkedRequests, cancelled: cancelled.length,
            providerReads: reads.length, final: queue.getStats() });
        } finally { queue.close(); }
      }
    }

    const makePyramid = (held, idle, hold) => createPyramidController({ now: () => performance.now(),
      requestIdle: (task) => { idle.push(task); return idle.length; }, cancelIdle: () => {},
      getActiveDatasetId: () => 1, getIOConcurrency: () => 1,
      readBandWindow: async (_meta, _source, band, x, y, w, h, step, _out, options) => {
        if (!hold.value) return new Float32Array(w * h);
        return new Promise((resolve) => held.push({ band, x, y, step, options,
          resolve: () => resolve(new Float32Array(w * h)) }));
      }, readBandWindowBIP: async () => { throw new Error("Unexpected interleave."); },
      onPerfUpdate: () => {}, onProgressiveRender: () => {} });
    const held = [], idle = [], hold = { value: false };
    const controller = makePyramid(held, idle, hold);
    const ds = { id: 1, meta: { samples: 8192, lines: 8192, bands: 1, interleave: "bsq" },
      ds: {}, view: { x: 1024, y: 1024, scale: 0.25 } };
    let pyramidCancellation;
    try {
      await controller.tryRasterFromPyramid(ds, 0, 0.25, 384, 384);
      const pyr = ds.pyramid;
      pyr.readAdmission.setLimit(1); hold.value = true;
      let cursor = 0;
      await until(async () => { if (idle[cursor]) idle[cursor++](); await tick();
        return held.length === 1 && pyr.readAdmission.waiting === 1; });
      const oldQueued = new Set(pyr.qHi.map((task) => task.key));
      let oldSettled = 0;
      const oldPending = [...pyr.pending.values()].map((promise) => promise.then(
        () => { oldSettled += 1; }, () => { oldSettled += 1; }));
      ds.view.x = 6144; ds.view.y = 6144;
      await controller.tryRasterFromPyramid(ds, 0, 0.25, 384, 384);
      const afterFocus = { oldQueuedRemaining: pyr.qHi.filter((task) => oldQueued.has(task.key)).length,
        active: pyr.readAdmission.active, admissionWaiters: pyr.readAdmission.waiting,
        activeReadMarkedCancelled: held[0].options.cancelled() };
      held[0].resolve();
      // A future fix may cancel the admission waiter before it starts. Report
      // that as supported rather than making the benchmark require this bug.
      await until(() => held.length === 2 || oldSettled === oldPending.length);
      pyramidCancellation = { oldQueuedCount: oldQueued.size, afterFocus,
        oldWaitingReadStartedAfterFocusChange: !!held[1] && held[1].x < 6144 && held[1].y < 6144,
        waitingReadMarkedCancelled: held[1]?.options.cancelled() ?? null,
        globalDisposeCancelsActive: null };
      controller.disposePyramid(pyr);
      pyramidCancellation.globalDisposeCancelsActive = held.at(-1).options.cancelled();
      held.forEach((read) => read.resolve());
      await until(() => pyr.readAdmission.active === 0);
      await Promise.all(oldPending);
    } finally { controller.disposePyramid(ds.pyramid); held.forEach((read) => read.resolve()); }

    globalThis.__queueMetrics.length = 0;
    const coldPlanning = [], focusPlanning = [];
    const measuredCpu = (start) => globalThis.__queueMetrics.slice(start).reduce((sum, row) => sum + row.ms, 0);
    for (let repeat = 0; repeat < 12; repeat += 1) {
      const idle = [], controller = makePyramid([], idle, { value: false });
      const dataset = { id: 1, meta: { samples: 37136, lines: 26626, bands: 3, interleave: "bsq" },
        ds: {}, view: { x: -366, y: 0, scale: 0.03380154735972358 } };
      try {
        const start = globalThis.__queueMetrics.length;
        for (const band of [0, 1, 2]) await controller.tryRasterFromPyramid(dataset, band,
          dataset.view.scale, 1280, 900, { bands: [0, 1, 2] });
        coldPlanning.push(measuredCpu(start));
        const changeStart = globalThis.__queueMetrics.length;
        dataset.view.x = 20000; dataset.view.y = 10000;
        await controller.tryRasterFromPyramid(dataset, 0, dataset.view.scale, 1280, 900, { bands: [0, 1, 2] });
        focusPlanning.push(measuredCpu(changeStart));
      } finally { controller.disposePyramid(dataset.pyramid); }
    }
    const metrics = globalThis.__queueMetrics;
    return { providerDelayMs, client, activeCancellation,
      pageFaultQueues: [128, 512, 2048].map((count) => {
        const rounds = pages.filter((row) => row.count === count);
        return { count, enqueue: summary(rounds.map((row) => row.enqueueMs)),
          cancellation: summary(rounds.map((row) => row.cancelMs)), rounds };
      }), pyramidCancellation,
      queuePlanning: { coldVisibleRgbCpu: summary(coldPlanning), focusChangeCpu: summary(focusPlanning),
        ...Object.fromEntries(["enqueue", "sort", "clear"].map((kind) => [kind,
        { ...summary(metrics.filter((row) => row.kind === kind).map((row) => row.ms)),
          maxTasks: Math.max(0, ...metrics.filter((row) => row.kind === kind).map((row) => row.count || 0)) }])) } };
  }, { providerDelayMs });
  const document = { browser: browser.version(), platform: process.platform,
    description: "Controlled admission/cancellation and isolated queue CPU timings; not disk throughput.", ...report };
  const json = `${JSON.stringify(document, null, 2)}\n`;
  console.log(json.trimEnd());
  if (output) { await mkdir(path.dirname(path.resolve(output)), { recursive: true }); await writeFile(output, json); }
} finally {
  await browser?.close();
  if (server.exitCode == null) server.kill();
}
