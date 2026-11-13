import wasmUrl from "../../wasm/rgb/pkg/rgb.wasm?url&inline";
import { createRgbSimdKernel } from "./rgb-simd.js";

/** Unsupported SIMD/blocked WASM keeps the same worker and JS compositor. */
export async function loadRgbSimdKernel({ fetchBytes = async () => {
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error("RGB kernel unavailable.");
  return response.arrayBuffer();
}, create = createRgbSimdKernel } = {}) {
  try { return await create(await fetchBytes()); } catch { return null; }
}
