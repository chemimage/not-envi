import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

console.log("Running desktop and mobile Chromium emulation profiles; this does not validate physical mobile hardware.");
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
