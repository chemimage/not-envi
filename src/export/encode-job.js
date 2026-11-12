import { encodeRawMultipageTiff, encodeRawRgbTiff, encodeRenderedMultipageTiff } from "./tiff-backend.js";
import { encodeEnviBandBytes } from "./envi-backend.js";

export function encodeExportJob({ kind, meta, width, height, pages, composite, ranges }) {
  if (kind === "envi") return encodeEnviBandBytes(meta, pages[0], true);
  if (kind === "rendered") return encodeRenderedMultipageTiff({ pages });
  if (kind === "scaled8") {
    pages = pages.map((page, i) => scalePageToUint8(page, ranges[i]));
  }
  return composite
    ? encodeRawRgbTiff({ meta, width, height, pages })
    : encodeRawMultipageTiff({ meta, width, height, pages });
}

function scalePageToUint8(values, range) {
  const n = Number(values?.length) || 0;
  const out = new Uint8Array(n);
  if (!n) return out;

  const minVal = Number(range?.minVal);
  const maxVal = Number(range?.maxVal);
  if (!Number.isFinite(minVal) || !Number.isFinite(maxVal) || maxVal <= minVal) return out;

  const scale = 255 / (maxVal - minVal);
  for (let i = 0; i < n; i += 1) {
    const v = Number(values[i]);
    out[i] = Number.isFinite(v)
      ? Math.max(0, Math.min(255, Math.round((v - minVal) * scale)))
      : 0;
  }
  return out;
}
