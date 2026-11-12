import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { collectFmapSources } from "./fmap-sources.mjs";

const pinnedClang = "18.1.2";
const clang = process.env.FMAP_CLANG || "clang";
const root = process.cwd();
const sourceDirectory = path.join(root, "wasm", "fmap");
const sourceManifest = collectFmapSources(sourceDirectory, ["src", "include"]);
const sources = sourceManifest.sources.filter((entry) => /\.c$/i.test(entry.path))
  .map((entry) => path.join(sourceDirectory, entry.path));
const buildDir = path.join(root, "wasm", "fmap", "build");
const outputDir = path.join(root, "wasm", "fmap", "pkg");
const output = path.join(outputDir, "fmap_core.wasm");

const clangVersion = execFileSync(clang, ["--version"], { encoding: "utf8" }).trim();
if (!clangVersion.includes(`clang version ${pinnedClang}`)) {
  throw new Error(`fmap requires Clang ${pinnedClang}; got ${clangVersion.split(/\r?\n/, 1)[0]}`);
}

mkdirSync(buildDir, { recursive: true });
mkdirSync(outputDir, { recursive: true });
const command = [
  "--target=wasm32-unknown-unknown",
  "-std=c11",
  "-O2",
  "-flto",
  "-ffreestanding",
  "-fno-builtin",
  "-fno-exceptions",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-nostdlib",
  "-I", path.join(sourceDirectory, "include"),
  "-x", "c",
  ...sources,
  "-Wl,--no-entry",
  "-Wl,--export-memory",
  "-Wl,--initial-memory=131072",
  "-Wl,--max-memory=4294901760",
  "-Wl,--strip-all",
  "-o",
  output
];
execFileSync(clang, command, { cwd: root, stdio: "inherit" });

const bytes = readFileSync(output);
if (bytes.length < 8 || !bytes.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) {
  throw new Error("Clang output is not a valid WebAssembly module.");
}
const module = new WebAssembly.Module(bytes);
const imports = WebAssembly.Module.imports(module);
if (imports.length) throw new Error(`fmap core must be standalone; found imports: ${JSON.stringify(imports)}`);
const exports = WebAssembly.Module.exports(module).map((entry) => entry.name).sort();
const sha256 = createHash("sha256").update(bytes).digest("hex");
const build = {
  module: "fmap_core",
  language: "C11",
  ...sourceManifest,
  compiler: clangVersion.split(/\r?\n/, 1)[0],
  target: "wasm32-unknown-unknown",
  optimization: "-O2 -flto",
  command: ["$FMAP_CLANG", ...command.map((item) => path.isAbsolute(item) ? path.relative(root, item) : item)],
  bytes: bytes.length,
  sha256,
  exports
};
writeFileSync(path.join(outputDir, "fmap_core.build.json"), `${JSON.stringify(build, null, 2)}\n`, "utf8");

execFileSync(process.execPath, [path.join(root, "scripts", "test-fmap-core.mjs"), output], {
  cwd: root,
  stdio: "inherit"
});
console.log(`Built ${path.relative(root, output)} (${bytes.length} bytes, sha256 ${sha256})`);
