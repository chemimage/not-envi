import { writeArrayBuffer } from "geotiff";
import { encodeTIFF_MultiPage_GrayRaw, tiffSampleFormatForEnviType } from "../core/tiff-encoder.js";

export function encodeRenderedTiff({ imageData }) {
  const width = imageData.width;
  const height = imageData.height;
  const rgba = new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength);

  const ab = writeArrayBuffer(rgba, {
    width,
    height,
    BitsPerSample: [8, 8, 8, 8],
    SamplesPerPixel: [4],
    PhotometricInterpretation: 2,
    SampleFormat: [1, 1, 1, 1],
    PlanarConfiguration: 1,
    Compression: 1,
    ExtraSamples: [2]
  });
  return new Blob([ab], { type: "image/tiff" });
}

export function encodeRawMultipageTiff({ meta, width, height, pages }) {
  if (!pages || !pages.length) {
    throw new Error("No pages provided for raw TIFF export.");
  }

  // geotiff writer currently targets single-image output; keep multipage layout
  // via compatibility adapter when we need more than one page.
  if (pages.length > 1) {
    return encodeTIFF_MultiPage_GrayRaw(meta, width, height, pages);
  }

  const bits = meta.dataTypeInfo.bytes * 8;
  const sampleFormat = tiffSampleFormatForEnviType(meta.dataType);
  const first = pages[0];
  const typed = normalizeTypedPage(first);

  const ab = writeArrayBuffer(typed, {
    width,
    height,
    BitsPerSample: [bits],
    SamplesPerPixel: [1],
    PhotometricInterpretation: 1,
    SampleFormat: [sampleFormat],
    PlanarConfiguration: 1,
    Compression: 1
  });
  return new Blob([ab], { type: "image/tiff" });
}

function normalizeTypedPage(view) {
  if (ArrayBuffer.isView(view)) {
    return view;
  }
  throw new Error("Raw TIFF page must be a typed array.");
}
