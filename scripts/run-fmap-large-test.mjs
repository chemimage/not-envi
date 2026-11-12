import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const cli = path.resolve("node_modules", "@playwright", "test", "cli.js");
const result = spawnSync(process.execPath, [cli, "test", "tests/e2e/fmap-large-file.spec.js"], {
  cwd: process.cwd(),
  env: { ...process.env, FMAP_LARGE_FILE: "1" },
  stdio: "inherit"
});
process.exit(result.status ?? 1);
