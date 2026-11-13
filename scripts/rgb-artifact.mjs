import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const rgbSourceUrl = new URL("../wasm/rgb/src/rgb.c", import.meta.url);
export const rgbWasmUrl = new URL("../wasm/rgb/pkg/rgb.wasm", import.meta.url);
export const rgbBuildUrl = new URL("../wasm/rgb/pkg/rgb.build.json", import.meta.url);
export const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export const rgbSourceHash = () => digest(readFileSync(rgbSourceUrl, "utf8").replace(/\r\n/g, "\n"));

export function verifyRgbArtifact() {
  const bytes = readFileSync(rgbWasmUrl), build = JSON.parse(readFileSync(rgbBuildUrl, "utf8"));
  if (digest(bytes) !== build.sha256 || bytes.length !== build.bytes || rgbSourceHash() !== build.sourceSha256) {
    throw new Error("RGB source/WASM artifact mismatch. Run npm run build:rgb.");
  }
  return bytes;
}
