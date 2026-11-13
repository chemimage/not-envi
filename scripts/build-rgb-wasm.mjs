import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { digest, rgbBuildUrl, rgbSourceHash, rgbWasmUrl } from "./rgb-artifact.mjs";

const clang = process.env.FMAP_CLANG || "clang";
const compiler = execFileSync(clang, ["--version"], { encoding: "utf8" }).split(/\r?\n/)[0];
if (!compiler.includes("clang version 18.1.2")) throw new Error(`RGB requires Clang 18.1.2; got ${compiler}`);
mkdirSync(new URL("../wasm/rgb/pkg/", import.meta.url), { recursive: true });
const command = ["--target=wasm32-unknown-unknown", "-std=c11", "-O3", "-msimd128", "-ffp-contract=off",
  "-ffreestanding", "-fno-builtin", "-nostdlib", "-Wall", "-Wextra", "-Werror", "wasm/rgb/src/rgb.c",
  "-Wl,--no-entry", "-Wl,--export-memory", "-Wl,--initial-memory=393216", "-Wl,--max-memory=393216", "-Wl,--strip-all", "-o", "wasm/rgb/pkg/rgb.wasm"];
execFileSync(clang, command, { stdio: "inherit" });
const bytes = readFileSync(rgbWasmUrl), module = new WebAssembly.Module(bytes);
if (WebAssembly.Module.imports(module).length) throw new Error("RGB kernel must have no runtime imports.");
writeFileSync(rgbBuildUrl, JSON.stringify({ module: "rgb", compiler, command: ["$FMAP_CLANG", ...command],
  sourceSha256: rgbSourceHash(), sha256: digest(bytes), bytes: bytes.length,
  exports: WebAssembly.Module.exports(module).map(x => x.name).sort(), scratchPixels: 16384, allocatedBytes: 393216 }, null, 2) + "\n");
console.log(`Built independent SIMD RGB kernel (${bytes.length} bytes; fixed 384 KiB memory)`);
