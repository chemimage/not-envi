import { spawn, execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "@playwright/test";

const port = Number(process.env.FMAP_BENCHMARK_PORT || 4178);
const origin = `http://127.0.0.1:${port}`;
const index = process.argv.indexOf("--output");
const output = index >= 0 ? process.argv[index + 1] : "test-results/fmap-reductions.json";
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let serverLog = "";
server.stdout.on("data", chunk => { serverLog += String(chunk); });
server.stderr.on("data", chunk => { serverLog += String(chunk); });
let browser;
try {
  const deadline = Date.now() + 20000;
  for (;;) {
    if (server.exitCode !== null || Date.now() > deadline) throw new Error(`Benchmark server unavailable: ${serverLog}`);
    try { if ((await fetch(origin)).ok) break; } catch { /* server starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(origin);
  const report = await page.evaluate(async () => {
    const { benchmarkReductions } = await import("/tests/fixtures/fmap-reduction-workload.js");
    const wasm = await (await fetch("/wasm/fmap/pkg/fmap_core.wasm")).arrayBuffer();
    return { userAgent: navigator.userAgent, results: await benchmarkReductions(wasm) };
  });
  report.browser = browser.version();
  report.platform = process.platform;
  report.arch = process.arch;
  report.commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  report.workingTreeDirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
  report.wasmSha256 = JSON.parse(await readFile("wasm/fmap/pkg/fmap_core.build.json", "utf8")).sha256;
  report.timestamp = new Date().toISOString();
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  for (const result of report.results) {
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    console.log(JSON.stringify({ ...result, timings: Object.fromEntries(Object.entries(result.timings)
      .map(([state, values]) => [state, { medianMs: median(values), samples: values.length }])) }));
  }
  console.log(`Checked report: ${output}`);
} finally { await browser?.close(); server.kill(); }
