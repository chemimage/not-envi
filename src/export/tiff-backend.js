import { encodeTIFF_MultiPage_GrayRaw, encodeTIFF_RGBA8 } from "../core/tiff-encoder.js";

export function encodeRenderedTiff({ imageData }) {
  return encodeTIFF_RGBA8(imageData);
}

export function encodeRenderedMultipageTiff({ pages }) {
  if (!Array.isArray(pages) || !pages.length) {
    throw new Error("No pages provided for rendered TIFF export.");
  }

  const width = Math.max(1, Number(pages[0]?.width) || 1);
  const height = Math.max(1, Number(pages[0]?.height) || 1);
  const pixelPages = pages.map((page) => {
    if (!page || Number(page.width) !== width || Number(page.height) !== height) {
      throw new Error("All rendered TIFF pages must share dimensions.");
    }
    return new Uint8Array(page.data.buffer, page.data.byteOffset, page.data.byteLength);
  });

  if (pixelPages.length === 1) {
    return encodeRenderedTiff({ imageData: pages[0] });
  }

  const pageCount = pixelPages.length;
  const numEntries = 11;
  const ifdSize = 2 + (numEntries * 12) + 4;
  const headerSize = 8;
  const bitsPerSampleSize = 8;
  const ifdAreaSize = pageCount * ifdSize;
  const bitsAreaOffset = headerSize + ifdAreaSize;
  const pixelAreaOffset = bitsAreaOffset + (pageCount * bitsPerSampleSize);

  const headerBuffer = new ArrayBuffer(pixelAreaOffset);
  const dv = new DataView(headerBuffer);
  dv.setUint8(0, 0x49);
  dv.setUint8(1, 0x49);
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);

  const writeEntry = (dataView, offset, tag, type, count, value) => {
    dataView.setUint16(offset + 0, tag, true);
    dataView.setUint16(offset + 2, type, true);
    dataView.setUint32(offset + 4, count, true);
    dataView.setUint32(offset + 8, value, true);
  };

  let pixelCursor = pixelAreaOffset;
  for (let i = 0; i < pageCount; i += 1) {
    const ifdOffset = 8 + (i * ifdSize);
    const bitsOffset = bitsAreaOffset + (i * bitsPerSampleSize);
    const pixelBytes = pixelPages[i];
    dv.setUint16(ifdOffset, numEntries, true);
    let o = ifdOffset + 2;

    writeEntry(dv, o, 256, 4, 1, width); o += 12;
    writeEntry(dv, o, 257, 4, 1, height); o += 12;
    writeEntry(dv, o, 258, 3, 4, bitsOffset); o += 12;
    writeEntry(dv, o, 259, 3, 1, 1); o += 12;
    writeEntry(dv, o, 262, 3, 1, 2); o += 12;
    writeEntry(dv, o, 273, 4, 1, pixelCursor); o += 12;
    writeEntry(dv, o, 277, 3, 1, 4); o += 12;
    writeEntry(dv, o, 278, 4, 1, height); o += 12;
    writeEntry(dv, o, 279, 4, 1, pixelBytes.byteLength); o += 12;
    writeEntry(dv, o, 284, 3, 1, 1); o += 12;
    writeEntry(dv, o, 338, 3, 1, 2); o += 12;

    dv.setUint32(ifdOffset + 2 + (numEntries * 12), (i === pageCount - 1) ? 0 : (8 + ((i + 1) * ifdSize)), true);
    dv.setUint16(bitsOffset + 0, 8, true);
    dv.setUint16(bitsOffset + 2, 8, true);
    dv.setUint16(bitsOffset + 4, 8, true);
    dv.setUint16(bitsOffset + 6, 8, true);
    pixelCursor += pixelBytes.byteLength;
  }

  const out = new Uint8Array(pixelCursor);
  out.set(new Uint8Array(headerBuffer), 0);
  let at = pixelAreaOffset;
  for (const bytes of pixelPages) {
    out.set(bytes, at);
    at += bytes.byteLength;
  }
  return new Blob([out], { type: "image/tiff" });
}

export function encodeRawMultipageTiff({ meta, width, height, pages }) {
  if (!pages || !pages.length) {
    throw new Error("No pages provided for raw TIFF export.");
  }

  return encodeTIFF_MultiPage_GrayRaw(meta, width, height, pages);
}
