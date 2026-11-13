import { encodeTiff } from "./tiff-pyramid.js";

export function encodeRawRgbTiff(options) {
  if (options.pages?.length !== 3 || options.pages.some(page => page.length !== options.width * options.height)) {
    throw new Error("RGB TIFF export requires three equally sized channel planes.");
  }
  return encodeTiff({ ...options, composite: true });
}

export function encodeRenderedTiff({ imageData, ...options }) {
  return encodeRenderedMultipageTiff({ ...options, pages: [imageData] });
}

export function encodeRenderedMultipageTiff({ pages, ...options }) {
  if (!Array.isArray(pages) || !pages.length) throw new Error("No pages provided for rendered TIFF export.");
  const width = Number(pages[0]?.width), height = Number(pages[0]?.height);
  if (pages.some(page => !page || Number(page.width) !== width || Number(page.height) !== height)) {
    throw new Error("All rendered TIFF pages must share dimensions.");
  }
  return encodeTiff({ ...options, width, height, pages, rendered: true });
}

export function encodeRawMultipageTiff(options) {
  if (!options.pages?.length) throw new Error("No pages provided for raw TIFF export.");
  return encodeTiff(options);
}
