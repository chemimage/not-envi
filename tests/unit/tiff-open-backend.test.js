import { describe, expect, test, vi } from "vitest";
import { encodeTIFF_MultiPage_GrayRaw } from "../../src/core/tiff-encoder.js";

function encodeFloat32Page(values) {
  const ab = new ArrayBuffer(values.length * 4);
  const dv = new DataView(ab);
  for (let index = 0; index < values.length; index += 1) {
    dv.setFloat32(index * 4, Number(values[index]), false);
  }
  return new Uint8Array(ab);
}

async function importBackendWithMockedFromBlob(fromBlobImpl) {
  vi.resetModules();
  const actual = await vi.importActual("geotiff");
  vi.doMock("geotiff", () => ({
    ...actual,
    fromBlob: fromBlobImpl
  }));
  return import("../../src/io/tiff/backend/index.js");
}

describe("openTiffBackend", () => {
  test("opens a valid TIFF through the native backend boundary", async () => {
    const meta = { dataType: 4, dataTypeInfo: { bytes: 4 } };
    const blob = encodeTIFF_MultiPage_GrayRaw(meta, 2, 2, [
      encodeFloat32Page([1.5, 2.5, 3.5, 4.5])
    ]);
    const file = new File([blob], "native-gray.tif", { type: "image/tiff" });
    const { openTiffBackend } = await import("../../src/io/tiff/backend/index.js");

    const backend = await openTiffBackend(file, { ioConcurrency: 2 });
    try {
      expect(await backend.getImageCount()).toBe(1);
      expect(backend.bigTiff).toBe(false);
      const image = await backend.getImage(0);
      expect(image.getWidth()).toBe(2);
      expect(image.getHeight()).toBe(2);
      expect(image.getSamplesPerPixel()).toBe(1);
    } finally {
      backend.close();
    }
  });

  test("falls back to geotiff when native parsing cannot open the file", async () => {
    const fakeImage = {
      getWidth: () => 3,
      getHeight: () => 1,
      getSamplesPerPixel: () => 1,
      getBitsPerSample: () => 8,
      getSampleFormat: () => 1,
      getFileDirectory: () => ({
        Compression: 1,
        RowsPerStrip: 1,
        StripOffsets: [0],
        StripByteCounts: [3],
        PhotometricInterpretation: 1
      })
    };
    const fallbackTiff = {
      littleEndian: true,
      bigTiff: false,
      getImageCount: vi.fn(async () => 1),
      getImage: vi.fn(async (index = 0) => {
        if (index !== 0) throw new Error(`No image at index ${index}`);
        return fakeImage;
      }),
      close: vi.fn()
    };
    const { openTiffBackend } = await importBackendWithMockedFromBlob(async () => fallbackTiff);

    try {
      const file = new File([new Uint8Array([0, 0, 0])], "fallback.tif", { type: "image/tiff" });
      const backend = await openTiffBackend(file, { ioConcurrency: 2 });
      try {
        expect(await backend.getImageCount()).toBe(1);
        const image = await backend.getImage(0);
        expect(image).toBe(fakeImage);
        expect(fallbackTiff.getImageCount).toHaveBeenCalledTimes(1);
      } finally {
        backend.close();
      }
    } finally {
      vi.doUnmock("geotiff");
      vi.resetModules();
    }
  });
});
