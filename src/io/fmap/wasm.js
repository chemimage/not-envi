import fmapWasmUrl from "../../../wasm/fmap/pkg/fmap_core.wasm?url";

let pendingBytes = null;

/** Share the verified embedded artifact across file opens without detaching it. */
export function loadFmapWasmBytes() {
  if (!pendingBytes) {
    pendingBytes = fetch(fmapWasmUrl).then((response) => {
      if (!response.ok) throw new Error(`Unable to load fmap WASM (${response.status}).`);
      return response.arrayBuffer();
    }).catch((error) => {
      pendingBytes = null;
      throw error;
    });
  }
  return pendingBytes;
}
