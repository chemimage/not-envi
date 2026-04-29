import { describe, expect, test } from "vitest";
import { fromArrayBuffer } from "geotiff";
import { encodeRawMultipageTiff, encodeRenderedMultipageTiff, encodeRenderedTiff } from "../../src/export/tiff-backend.js";

async function blobToArrayBuffer(blob) {
  if (blob && typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  if (typeof FileReader !== "undefined") {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(fr.error || new Error("Failed reading blob"));
      fr.onload = () => resolve(fr.result);
      fr.readAsArrayBuffer(blob);
    });
  }
  if (typeof Response !== "undefined") {
    return new Response(blob).arrayBuffer();
  }
  throw new Error("No blob reader available in this runtime.");
}

describe("tiff backend", () => {
  test("encodeRenderedTiff creates a valid TIFF", async () => {
    const imageData = {
      width: 2,
      height: 1,
      data: Uint8ClampedArray.from([255, 0, 0, 255, 0, 255, 0, 255])
    };
    const blob = encodeRenderedTiff({ imageData });
    const ab = await blobToArrayBuffer(blob);
    const u8 = new Uint8Array(ab);
    const sig = String.fromCharCode(u8[0], u8[1]);
    expect(sig === "II" || sig === "MM").toBe(true);
    const tiff = await fromArrayBuffer(ab);
    expect(await tiff.getImageCount()).toBe(1);
    const img = await tiff.getImage(0);
    expect(Array.from(img.fileDirectory.BitsPerSample)).toEqual([8, 8, 8, 8]);
    expect(img.fileDirectory.StripByteCounts[0]).toBe(8);
    const raster = await img.readRasters({ interleave: true });
    expect(Array.from(raster)).toEqual(Array.from(imageData.data));
  });

  test("encodeRawMultipageTiff preserves multipage raw stack fallback", async () => {
    const meta = { dataType: 4, dataTypeInfo: { bytes: 4 } };
    const pages = [new Float32Array([1, 2, 3, 4]), new Float32Array([5, 6, 7, 8])];
    const blob = encodeRawMultipageTiff({ meta, width: 2, height: 2, pages });
    const ab = await blobToArrayBuffer(blob);
    const tiff = await fromArrayBuffer(ab);
    expect(await tiff.getImageCount()).toBe(2);
  });

  test("encodeRenderedMultipageTiff creates multiple rendered pages", async () => {
    const pages = [
      {
        width: 2,
        height: 1,
        data: Uint8ClampedArray.from([255, 0, 0, 255, 0, 255, 0, 255])
      },
      {
        width: 2,
        height: 1,
        data: Uint8ClampedArray.from([0, 0, 255, 255, 255, 255, 0, 255])
      }
    ];
    const blob = encodeRenderedMultipageTiff({ pages });
    const ab = await blobToArrayBuffer(blob);
    const tiff = await fromArrayBuffer(ab);
    expect(await tiff.getImageCount()).toBe(2);
  });

  test("encodeRawMultipageTiff writes float sample format for single-page Float32", async () => {
    const meta = { dataType: 4, dataTypeInfo: { bytes: 4 } };
    const pages = [new Float32Array([1.5, 2.5, 3.5, 4.5])];
    const blob = encodeRawMultipageTiff({ meta, width: 2, height: 2, pages });
    const ab = await blobToArrayBuffer(blob);
    const tiff = await fromArrayBuffer(ab);
    const img = await tiff.getImage(0);
    const sf = img.fileDirectory.SampleFormat;
    const first = Array.isArray(sf) || ArrayBuffer.isView(sf) ? sf[0] : sf;
    expect(first).toBe(3);
    expect(img.fileDirectory.BitsPerSample[0]).toBe(32);
    expect(img.fileDirectory.StripByteCounts[0]).toBe(16);
    expect(ab.byteLength).toBeGreaterThanOrEqual(16);

    const raster = await img.readRasters({ samples: [0] });
    const values = ArrayBuffer.isView(raster) ? raster : raster[0];
    expect(Array.from(values)).toEqual([1.5, 2.5, 3.5, 4.5]);
  });

  test("encodeRawMultipageTiff writes full byte payload for single-page UInt16", async () => {
    const meta = { dataType: 12, dataTypeInfo: { bytes: 2 } };
    const pages = [new Uint16Array([1, 258, 4096, 65535])];
    const blob = encodeRawMultipageTiff({ meta, width: 2, height: 2, pages });
    const ab = await blobToArrayBuffer(blob);
    const tiff = await fromArrayBuffer(ab);
    const img = await tiff.getImage(0);

    expect(img.fileDirectory.BitsPerSample[0]).toBe(16);
    expect(img.fileDirectory.StripByteCounts[0]).toBe(8);

    const raster = await img.readRasters({ samples: [0] });
    const values = ArrayBuffer.isView(raster) ? raster : raster[0];
    expect(Array.from(values)).toEqual([1, 258, 4096, 65535]);
  });
});
