import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const pinnedRust = "1.85.1";
const cargo = process.env.FMAP_CARGO || "cargo";
const root = process.cwd();
const manifest = path.join(root, "wasm", "fmap", "Cargo.toml");
const outputDir = path.join(root, "wasm", "fmap", "pkg");
const compiled = path.join(root, "wasm", "fmap", "target", "wasm32-unknown-unknown", "release", "fmap_core.wasm");
const output = path.join(outputDir, "fmap_core.wasm");
const cargoEnv = { ...process.env, RUSTUP_TOOLCHAIN: pinnedRust };

function run(args, options = {}) {
  return execFileSync(cargo, args, { cwd: root, stdio: "inherit", env: cargoEnv, ...options });
}

const rustcVersion = execFileSync(cargo, ["rustc", "--manifest-path", manifest, "--", "--version"], {
  cwd: root,
  env: cargoEnv,
  encoding: "utf8"
}).trim();
if (!rustcVersion.startsWith(`rustc ${pinnedRust} `)) {
  throw new Error(`fmap requires rustc ${pinnedRust}; got ${rustcVersion}`);
}

run(["test", "--manifest-path", manifest]);
run(["build", "--release", "--target", "wasm32-unknown-unknown", "--manifest-path", manifest]);

const bytes = readFileSync(compiled);
if (bytes.length < 8 || !bytes.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) {
  throw new Error("Cargo output is not a valid WebAssembly module.");
}

mkdirSync(outputDir, { recursive: true });
copyFileSync(compiled, output);
const module = new WebAssembly.Module(bytes);
const exports = WebAssembly.Module.exports(module).map((entry) => entry.name).sort();
const instance = await WebAssembly.instantiate(module, {});
const wasm = instance.exports;
if (wasm.fmap_init(64, 2) !== 0 || wasm.fmap_resident_bytes() !== 128) {
  throw new Error("fmap WASM smoke test could not initialize the fixed pool.");
}
const smokeSlot = wasm.fmap_acquire_page(0x1_0000_0001n);
if (smokeSlot < 0 || wasm.fmap_slot_page(smokeSlot) !== 0x1_0000_0001n) {
  throw new Error("fmap WASM smoke test lost a page index beyond 4 GiB.");
}
const smokePtr = wasm.fmap_slot_ptr(smokeSlot);
new DataView(wasm.memory.buffer).setFloat32(smokePtr, 12.5, true);
if (wasm.fmap_commit_page(smokeSlot, 4) !== 0 || wasm.fmap_extract_f32_le(smokeSlot, 0, 1, 4) !== 1) {
  throw new Error("fmap WASM smoke test could not extract Float32 data.");
}
const smokeValue = new Float32Array(wasm.memory.buffer, wasm.fmap_output_ptr(), 1)[0];
if (smokeValue !== 12.5 || wasm.fmap_release_page(smokeSlot) !== 0) {
  throw new Error("fmap WASM smoke test returned incorrect data or pin state.");
}
const sha256 = createHash("sha256").update(bytes).digest("hex");
const build = {
  crate: "fmap_core",
  rustc: rustcVersion,
  target: "wasm32-unknown-unknown",
  profile: "release",
  bytes: bytes.length,
  sha256,
  exports
};
writeFileSync(path.join(outputDir, "fmap_core.build.json"), `${JSON.stringify(build, null, 2)}\n`, "utf8");
console.log(`Built ${path.relative(root, output)} (${bytes.length} bytes, sha256 ${sha256})`);
