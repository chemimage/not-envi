import { describe, expect, test } from "vitest";
import { writeArrayBuffer } from "geotiff";
import { encodeTIFF_MultiPage_GrayRaw } from "../../src/core/tiff-encoder.js";
import { readBandWindow, readBandWindowBIP } from "../../src/core/raster-io.js";
import { readSpectrumAtPixel } from "../../src/render/spectrum-data.js";
import { addDatasetFromFile } from "../../src/io/tiff-loader.js";

function createDataset({ meta, cached, base, dataFile }) {
  return {
    meta,
    ds: cached,
    baseDs: base,
    dataName: dataFile?.name || "",
    displayMode: meta.defaultDisplayMode || "gray"
  };
}

function encodeFloat32Page(values) {
  const ab = new ArrayBuffer(values.length * 4);
  const dv = new DataView(ab);
  for (let i = 0; i < values.length; i += 1) {
    dv.setFloat32(i * 4, Number(values[i]), false);
  }
  return new Uint8Array(ab);
}

describe("tiff loader", () => {
  test("loads single-image float32 grayscale TIFF through the direct read path", async () => {
    const meta = { dataType: 4, dataTypeInfo: { bytes: 4 } };
    const blob = encodeTIFF_MultiPage_GrayRaw(meta, 2, 2, [
      encodeFloat32Page([1.5, 2.5, 3.5, 4.5])
    ]);
    const file = new File([blob], "gray32.tiff", { type: "image/tiff" });
    const ds = await addDatasetFromFile(file, { createDataset, ioConcurrency: 2 });

    expect(ds.meta.samples).toBe(2);
    expect(ds.meta.lines).toBe(2);
    expect(ds.meta.bands).toBe(1);
    expect(ds.meta.dataType).toBe(4);
    expect(typeof ds.ds.read).toBe("function");

    const out = await readBandWindow(ds.meta, ds.ds, 0, 0, 0, 2, 2, 1, 2);
    expect(Array.from(out)).toEqual([1.5, 2.5, 3.5, 4.5]);
  });

  test("loads single-image RGB TIFF with RGB defaults", async () => {
    const ab = writeArrayBuffer(new Uint8Array([
      255, 0, 0,
      0, 128, 255
    ]), {
      width: 2,
      height: 1,
      BitsPerSample: [8, 8, 8],
      SamplesPerPixel: [3],
      PhotometricInterpretation: 2,
      SampleFormat: [1, 1, 1],
      PlanarConfiguration: 1,
      Compression: 1
    });
    const file = new File([ab], "rgb.tif", { type: "image/tiff" });
    const ds = await addDatasetFromFile(file, { createDataset, ioConcurrency: 2 });

    expect(ds.meta.bands).toBe(3);
    expect(ds.meta.defaultDisplayMode).toBe("rgb");
    expect(ds.displayMode).toBe("rgb");

    const red = await readBandWindowBIP(ds.meta, ds.ds, 0, 0, 0, 2, 1, 1, 2);
    const green = await readBandWindowBIP(ds.meta, ds.ds, 1, 0, 0, 2, 1, 1, 2);
    const blue = await readBandWindowBIP(ds.meta, ds.ds, 2, 0, 0, 2, 1, 1, 2);
    expect(Array.from(red)).toEqual([255, 0]);
    expect(Array.from(green)).toEqual([0, 128]);
    expect(Array.from(blue)).toEqual([0, 255]);
  });

  test("loads multipage grayscale TIFF as a band stack", async () => {
    const meta = { dataType: 4, dataTypeInfo: { bytes: 4 } };
    const blob = encodeTIFF_MultiPage_GrayRaw(meta, 2, 2, [
      encodeFloat32Page([1, 2, 3, 4]),
      encodeFloat32Page([5, 6, 7, 8])
    ]);
    const file = new File([blob], "stack.tiff", { type: "image/tiff" });
    const ds = await addDatasetFromFile(file, { createDataset, ioConcurrency: 2 });

    expect(ds.meta.bands).toBe(2);
    const spectrum = await readSpectrumAtPixel(ds, 1, 1, 2);
    expect(Array.from(spectrum)).toEqual([4, 8]);
  });
});
