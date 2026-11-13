import wasmBase64 from "../../../../wasm/libtiff/pkg/libtiff-bytes.js";

let compiled;

/** The main bundle owns one embedded payload; workers receive compiled code. */
export function loadLibtiffCompiled() {
  compiled ||= WebAssembly.compile(Uint8Array.from(atob(wasmBase64), (char) => char.charCodeAt(0)))
    .catch((error) => { compiled = null; throw error; });
  return compiled;
}
