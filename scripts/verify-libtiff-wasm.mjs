import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function verifyLibtiffArtifact(root = new URL("../", import.meta.url)) {
  const manifest = JSON.parse(readFileSync(new URL("wasm/libtiff/pkg/libtiff.build.json", root), "utf8"));
  for (const [name, expected] of Object.entries(manifest.files)) {
    const source = readFileSync(new URL(name, root), "utf8").replace(/\r\n/g, "\n");
    const actual = createHash("sha256").update(source).digest("hex");
    if (actual !== expected) throw new Error(`libtiff artifact/source mismatch: ${name}. Rebuild with scripts/build-libtiff-wasm.py.`);
  }
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(`Verified pinned libtiff artifact (${verifyLibtiffArtifact().wasmBytes} WASM bytes).`);
}
