import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    stdio: "inherit"
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, [path.resolve("node_modules", "vite", "bin", "vite.js"), "build"]);
run(process.execPath, [path.resolve("scripts", "inline-dist.mjs")]);
run(process.execPath, [path.resolve("scripts", "assert-single-file.mjs")]);
const cli = path.resolve("node_modules", "@playwright", "test", "cli.js");
run(process.execPath, [
  cli,
  "test",
  "--config=playwright.fmap-packaged.config.js"
], { ...process.env, FMAP_PACKAGED: "1" });
