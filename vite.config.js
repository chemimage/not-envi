import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
);

const fmapWasmUrl = new URL("./wasm/fmap/pkg/fmap_core.wasm", import.meta.url);
const fmapBuildUrl = new URL("./wasm/fmap/pkg/fmap_core.build.json", import.meta.url);

function verifiedFmapWasm() {
  const bytes = readFileSync(fmapWasmUrl);
  const build = JSON.parse(readFileSync(fmapBuildUrl, "utf8"));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== build.sha256 || bytes.length !== build.bytes) {
    throw new Error("The committed fmap WASM artifact does not match its build manifest. Run npm run build:fmap.");
  }
  if (!bytes.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) {
    throw new Error("The committed fmap artifact is not WebAssembly.");
  }
  return bytes;
}

verifiedFmapWasm();

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version)
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    minify: "esbuild",
    assetsInlineLimit: Number.MAX_SAFE_INTEGER
  }
});
