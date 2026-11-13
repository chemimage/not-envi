import { describe, expect, test } from "vitest";
import { encodeTIFF_MultiPage_GrayRaw } from "../../src/core/tiff-encoder.js";

function encodeFloat32Page(values) {
  const ab = new ArrayBuffer(values.length * 4);
  const dv = new DataView(ab);
  for (let index = 0; index < values.length; index += 1) {
    dv.setFloat32(index * 4, Number(values[index]), false);
  }
  return new Uint8Array(ab);
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

  test("rejects an invalid TIFF without retrying another metadata parser", async () => {
    const { openTiffBackend } = await import("../../src/io/tiff/backend/index.js");
    await expect(openTiffBackend(new File([new Uint8Array([0, 0, 0])], "invalid.tif"))).rejects.toThrow();
  });
});
