import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { verifyFmapArtifact, FMAP_SOURCE_SCOPES } from "./scripts/fmap-sources.mjs";
import { verifyLibtiffArtifact } from "./scripts/verify-libtiff-wasm.mjs";
import { verifyRgbArtifact } from "./scripts/rgb-artifact.mjs";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
);

const fmapWasmUrl = new URL("./wasm/fmap/pkg/fmap_core.wasm", import.meta.url);
const fmapBuildUrl = new URL("./wasm/fmap/pkg/fmap_core.build.json", import.meta.url);

function verifiedFmapWasm() {
  const bytes = readFileSync(fmapWasmUrl);
  const build = JSON.parse(readFileSync(fmapBuildUrl, "utf8"));
  return verifyFmapArtifact(bytes, build, new URL("./wasm/", import.meta.url), FMAP_SOURCE_SCOPES);
}

verifiedFmapWasm();
verifyLibtiffArtifact();
verifyRgbArtifact();

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version)
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    minify: "esbuild",
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    // Codec imports must survive after the single-file packager removes assets.
    rollupOptions: { output: { inlineDynamicImports: true } }
  }
});
