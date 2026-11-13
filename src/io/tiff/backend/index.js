import { openNativeTiffBackend } from "./native-backend.js";

/** libtiff owns parsing; format-specific pixel fallbacks live behind the adapter. */
export function openTiffBackend(file, deps = {}) {
  return openNativeTiffBackend(file, deps);
}
