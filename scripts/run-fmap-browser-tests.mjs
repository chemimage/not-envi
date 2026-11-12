import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

console.log("Running desktop Chromium and WebKit profiles; WebKit is engine coverage, not a physical Safari or iPad test.");
const cli = path.resolve("node_modules", "@playwright", "test", "cli.js");
const result = spawnSync(process.execPath, [
  cli,
  "test",
  "--config=playwright.fmap.config.js"
], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit"
});
process.exit(result.status ?? 1);
