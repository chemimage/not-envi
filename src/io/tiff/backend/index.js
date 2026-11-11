import { openGeotiffFallback } from "./geotiff-fallback.js";
import { openNativeTiffBackend } from "./native-backend.js";

export async function openTiffBackend(file, deps = {}) {
  const errors = [];
  try {
    return await openNativeTiffBackend(file, deps);
  } catch (err) {
    if (err?.tiffNoFallback || err?.code === "TIFF_METADATA_LIMIT") throw err;
    errors.push(err);
  }

  try {
    return await openGeotiffFallback(file);
  } catch (err) {
    errors.push(err);
  }

  const primary = errors.find(Boolean);
  const secondary = errors.find((err) => err && err !== primary);
  if (primary && secondary) {
    primary.message = `${primary.message} (fallback failed: ${secondary.message})`;
  }
  throw primary || new Error("Failed to open TIFF.");
}
