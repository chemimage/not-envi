import { describe, expect, test } from "vitest";
import { fromArrayBuffer } from "geotiff";
import { LibtiffWriter } from "../../src/io/tiff/libtiff/writer.js";
import { loadLibtiffCompiled } from "../../src/io/tiff/libtiff/compiled.js";

function readBlob(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

describe("libtiff export writer", () => {
  test.each([false, true])("writes and patches multiple directories across output chunks (BigTIFF=%s)", async bigTiff => {
    const writer = await LibtiffWriter.open(await loadLibtiffCompiled(), bigTiff);
    const pixels = Uint8Array.from({ length: 300000 }, (_, i) => i % 251);
    let blob;
    try {
      for (let page = 0; page < 2; page++) {
        await writer.call("ne_tiff_write_image", [pixels.length, 1, 8, 1, 1, 1, 0, 0, 0, 1, 1, 0, 0, 20000, 10000]);
        await writer.block(0, pixels);
        await writer.call("ne_tiff_write_directory");
      }
      blob = await writer.finish();
    } finally { writer.close(); }
    const buffer = await readBlob(blob), tiff = await fromArrayBuffer(buffer);
    expect(new DataView(buffer).getUint16(2, true)).toBe(bigTiff ? 43 : 42);
    expect(await tiff.getImageCount()).toBe(2);
    for (let page = 0; page < 2; page++) {
      const image = await tiff.getImage(page);
      expect(image.fileDirectory.ResolutionUnit).toBe(3);
      expect(image.fileDirectory.XResolution[0] / image.fileDirectory.XResolution[1]).toBe(20000);
      const raster = await image.readRasters({ interleave: true });
      expect(raster.length).toBe(pixels.length);
      expect(raster.every((value, i) => value === pixels[i])).toBe(true);
    }
  });

  test("surfaces libtiff failures and releases a failed writer", async () => {
    const writer = await LibtiffWriter.open(await loadLibtiffCompiled());
    try {
      await expect(writer.call("ne_tiff_write_image", [2, 2, 8, 1, 1, 1, 0, 17, 16, 0, 8, 0, 0, 0, 0])).rejects.toThrow(/TileWidth/);
      await expect(writer.block(0, new Uint8Array(0))).rejects.toThrow(/32 MiB/);
    } finally { writer.close(); }
    const retry = await LibtiffWriter.open(await loadLibtiffCompiled());
    retry.close();
  });
});
