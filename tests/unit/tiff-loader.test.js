import { describe, expect, test, vi } from "vitest";
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

async function importLoaderWithMockedFromBlob(fromBlobImpl) {
  vi.resetModules();
  const actual = await vi.importActual("geotiff");
  vi.doMock("geotiff", () => ({
    ...actual,
    fromBlob: fromBlobImpl
  }));
  return import("../../src/io/tiff-loader.js");
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

  test("loads palette TIFF through RGB conversion when raw grayscale assumptions do not apply", async () => {
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
        PhotometricInterpretation: 3
      }),
      readRGB: vi.fn(async () => new Uint8Array([
        255, 0, 0,
        0, 255, 0,
        0, 0, 255
      ]))
    };
    const close = vi.fn();
    const { addDatasetFromFile: addDatasetFromMockedTiff } = await importLoaderWithMockedFromBlob(async () => ({
      getImageCount: async () => 1,
      getImage: async (index = 0) => {
        if (index === 0) return fakeImage;
        throw new Error(`No image at index ${index}`);
      },
      littleEndian: true,
      bigTiff: false,
      close
    }));

    try {
      const file = new File([new Uint8Array([0, 0, 0])], "palette.tif", { type: "image/tiff" });
      const ds = await addDatasetFromMockedTiff(file, { createDataset, ioConcurrency: 2 });

      expect(ds.meta.bands).toBe(3);
      expect(ds.meta.defaultDisplayMode).toBe("rgb");

      const red = await readBandWindowBIP(ds.meta, ds.ds, 0, 0, 0, 3, 1, 1, 2);
      const green = await readBandWindowBIP(ds.meta, ds.ds, 1, 0, 0, 3, 1, 1, 2);
      const blue = await readBandWindowBIP(ds.meta, ds.ds, 2, 0, 0, 3, 1, 1, 2);
      expect(Array.from(red)).toEqual([255, 0, 0]);
      expect(Array.from(green)).toEqual([0, 255, 0]);
      expect(Array.from(blue)).toEqual([0, 0, 255]);
      expect(fakeImage.readRGB).toHaveBeenCalled();
    } finally {
      vi.doUnmock("geotiff");
      vi.resetModules();
    }
  });

  test("shares in-flight RGB block decodes across channel reads", async () => {
    const fakeImage = {
      getWidth: () => 2,
      getHeight: () => 1,
      getSamplesPerPixel: () => 1,
      getBitsPerSample: () => 8,
      getSampleFormat: () => 1,
      getFileDirectory: () => ({
        Compression: 1,
        RowsPerStrip: 1,
        StripOffsets: [0],
        StripByteCounts: [2],
        PhotometricInterpretation: 3
      }),
      readRGB: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Uint8Array([255, 0, 0, 0, 255, 0]);
      })
    };
    const close = vi.fn();
    const { addDatasetFromFile: addDatasetFromMockedTiff } = await importLoaderWithMockedFromBlob(async () => ({
      getImageCount: async () => 1,
      getImage: async (index = 0) => {
        if (index === 0) return fakeImage;
        throw new Error(`No image at index ${index}`);
      },
      littleEndian: true,
      bigTiff: false,
      close
    }));

    try {
      const file = new File([new Uint8Array([0, 0])], "palette-shared.tif", { type: "image/tiff" });
      const ds = await addDatasetFromMockedTiff(file, { createDataset, ioConcurrency: 3 });
      const [red, green, blue] = await Promise.all([
        readBandWindowBIP(ds.meta, ds.ds, 0, 0, 0, 2, 1, 1, 3),
        readBandWindowBIP(ds.meta, ds.ds, 1, 0, 0, 2, 1, 1, 3),
        readBandWindowBIP(ds.meta, ds.ds, 2, 0, 0, 2, 1, 1, 3)
      ]);
      expect(Array.from(red)).toEqual([255, 0]);
      expect(Array.from(green)).toEqual([0, 255]);
      expect(Array.from(blue)).toEqual([0, 0]);
      expect(fakeImage.readRGB).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock("geotiff");
      vi.resetModules();
    }
  });

  test("reads TIFF RGB composite windows in one block pass", async () => {
    const fakeImage = {
      getWidth: () => 2,
      getHeight: () => 1,
      getSamplesPerPixel: () => 1,
      getBitsPerSample: () => 8,
      getSampleFormat: () => 1,
      getFileDirectory: () => ({
        Compression: 1,
        RowsPerStrip: 1,
        StripOffsets: [0],
        StripByteCounts: [2],
        PhotometricInterpretation: 3
      }),
      readRGB: vi.fn(async () => new Uint8Array([255, 0, 0, 0, 255, 0]))
    };
    const close = vi.fn();
    const { addDatasetFromFile: addDatasetFromMockedTiff } = await importLoaderWithMockedFromBlob(async () => ({
      getImageCount: async () => 1,
      getImage: async (index = 0) => {
        if (index === 0) return fakeImage;
        throw new Error(`No image at index ${index}`);
      },
      littleEndian: true,
      bigTiff: false,
      close
    }));

    try {
      const file = new File([new Uint8Array([0, 0])], "palette-composite.tif", { type: "image/tiff" });
      const ds = await addDatasetFromMockedTiff(file, { createDataset, ioConcurrency: 2 });
      const composite = await ds.ds.readCompositeWindow(ds.meta, 0, 0, 2, 1, 1);
      expect(Array.from(composite.bands[0])).toEqual([255, 0]);
      expect(Array.from(composite.bands[1])).toEqual([0, 255]);
      expect(Array.from(composite.bands[2])).toEqual([0, 0]);
      expect(fakeImage.readRGB).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock("geotiff");
      vi.resetModules();
    }
  });

  test("uses native JPEG tile decode for JPEG-compressed YCbCr TIFF blocks when available", async () => {
    const fakeImage = {
      getWidth: () => 1,
      getHeight: () => 1,
      getSamplesPerPixel: () => 3,
      getBitsPerSample: () => 8,
      getSampleFormat: () => 1,
      getFileDirectory: () => ({
        Compression: 7,
        PhotometricInterpretation: 6,
        PlanarConfiguration: 1,
        TileWidth: 1,
        TileLength: 1,
        TileOffsets: [0],
        TileByteCounts: [4]
      }),
      readRGB: vi.fn(async () => new Uint8Array([99, 88, 77])),
      tiles: {}
    };
    const close = vi.fn();
    const { addDatasetFromFile: addDatasetFromMockedTiff } = await importLoaderWithMockedFromBlob(async () => ({
      getImageCount: async () => 1,
      getImage: async (index = 0) => {
        if (index === 0) return fakeImage;
        throw new Error(`No image at index ${index}`);
      },
      littleEndian: true,
      bigTiff: false,
      close
    }));

    const prevCreateImageBitmap = globalThis.createImageBitmap;
    const bitmapClose = vi.fn();
    const createImageBitmapMock = vi.fn(async () => ({ width: 1, height: 1, close: bitmapClose }));
    globalThis.createImageBitmap = createImageBitmapMock;
    const originalCreateElement = document.createElement.bind(document);
    const drawImage = vi.fn();
    const getImageData = vi.fn(() => ({ data: Uint8ClampedArray.from([11, 22, 33, 255]) }));
    const createElementSpy = vi.spyOn(document, "createElement").mockImplementation((tagName, options) => {
      if (String(tagName).toLowerCase() === "canvas") {
        return {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage, getImageData })
        };
      }
      return originalCreateElement(tagName, options);
    });

    try {
      const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "jpeg-tile.tif", { type: "image/tiff" });
      const ds = await addDatasetFromMockedTiff(file, { createDataset, ioConcurrency: 3 });
      const [red, green, blue] = await Promise.all([
        readBandWindowBIP(ds.meta, ds.ds, 0, 0, 0, 1, 1, 1, 3),
        readBandWindowBIP(ds.meta, ds.ds, 1, 0, 0, 1, 1, 1, 3),
        readBandWindowBIP(ds.meta, ds.ds, 2, 0, 0, 1, 1, 1, 3)
      ]);
      expect(Array.from(red)).toEqual([11]);
      expect(Array.from(green)).toEqual([22]);
      expect(Array.from(blue)).toEqual([33]);
      expect(createImageBitmapMock).toHaveBeenCalledTimes(1);
      expect(fakeImage.readRGB).not.toHaveBeenCalled();
      expect(bitmapClose).toHaveBeenCalledTimes(1);
    } finally {
      createElementSpy.mockRestore();
      if (prevCreateImageBitmap === undefined) {
        delete globalThis.createImageBitmap;
      } else {
        globalThis.createImageBitmap = prevCreateImageBitmap;
      }
      vi.doUnmock("geotiff");
      vi.resetModules();
    }
  });

  test("falls back to the geotiff windowed reader when the raw shortcut does not match decoded values", async () => {
    const fakeImage = {
      getWidth: () => 1,
      getHeight: () => 1,
      getSamplesPerPixel: () => 1,
      getBitsPerSample: () => 8,
      getSampleFormat: () => 1,
      getFileDirectory: () => ({
        Compression: 1,
        RowsPerStrip: 1,
        StripOffsets: [0],
        StripByteCounts: [1],
        PhotometricInterpretation: 1
      }),
      readRasters: vi.fn(async () => new Uint8Array([42]))
    };
    const close = vi.fn();
    const { addDatasetFromFile: addDatasetFromMockedTiff } = await importLoaderWithMockedFromBlob(async () => ({
      getImageCount: async () => 1,
      getImage: async (index = 0) => {
        if (index === 0) return fakeImage;
        throw new Error(`No image at index ${index}`);
      },
      littleEndian: true,
      bigTiff: false,
      close
    }));

    try {
      const file = new File([new Uint8Array([7])], "mismatch.tif", { type: "image/tiff" });
      const ds = await addDatasetFromMockedTiff(file, { createDataset, ioConcurrency: 1 });
      const out = await readBandWindow(ds.meta, ds.ds, 0, 0, 0, 1, 1, 1, 1);
      expect(Array.from(out)).toEqual([42]);
      expect(fakeImage.readRasters).toHaveBeenCalled();
    } finally {
      vi.doUnmock("geotiff");
      vi.resetModules();
    }
  });

  test("composes multi-strip grayscale TIFF through the block-indexed path and reuses decoded blocks", async () => {
    const fakeImage = {
      getWidth: () => 2,
      getHeight: () => 2,
      getSamplesPerPixel: () => 1,
      getBitsPerSample: () => 8,
      getSampleFormat: () => 1,
      getFileDirectory: () => ({
        Compression: 1,
        RowsPerStrip: 1,
        StripOffsets: [0, 2],
        StripByteCounts: [2, 2],
        PhotometricInterpretation: 1
      }),
      tiles: {}
    };
    const close = vi.fn();
    const { addDatasetFromFile: addDatasetFromMockedTiff } = await importLoaderWithMockedFromBlob(async () => ({
      getImageCount: async () => 1,
      getImage: async (index = 0) => {
        if (index === 0) return fakeImage;
        throw new Error(`No image at index ${index}`);
      },
      littleEndian: true,
      bigTiff: false,
      close
    }));

    try {
      const file = new File([new Uint8Array([1, 2, 3, 4])], "striped.tif", { type: "image/tiff" });
      const ds = await addDatasetFromMockedTiff(file, { createDataset, ioConcurrency: 1, cacheBytes: 16 * 1024 * 1024 });
      const first = await readBandWindow(ds.meta, ds.ds, 0, 0, 0, 2, 2, 1, 1);
      const second = await readBandWindow(ds.meta, ds.ds, 0, 0, 0, 2, 2, 1, 1);

      expect(Array.from(first)).toEqual([1, 2, 3, 4]);
      expect(Array.from(second)).toEqual([1, 2, 3, 4]);
      expect(ds.ds.stats.decodeCalls).toBe(0);
      expect(ds.ds.stats.decodedCacheHits).toBeGreaterThanOrEqual(2);
    } finally {
      vi.doUnmock("geotiff");
      vi.resetModules();
    }
  });

  test("samples uncompressed tiled TIFF sparsely for downsampled windows", async () => {
    const fakeImage = {
      getWidth: () => 4,
      getHeight: () => 4,
      getSamplesPerPixel: () => 1,
      getBitsPerSample: () => 8,
      getSampleFormat: () => 1,
      getFileDirectory: () => ({
        Compression: 1,
        TileWidth: 2,
        TileLength: 2,
        TileOffsets: [0, 4, 8, 12],
        TileByteCounts: [4, 4, 4, 4],
        PhotometricInterpretation: 1
      }),
      tiles: {}
    };
    const close = vi.fn();
    const { addDatasetFromFile: addDatasetFromMockedTiff } = await importLoaderWithMockedFromBlob(async () => ({
      getImageCount: async () => 1,
      getImage: async (index = 0) => {
        if (index === 0) return fakeImage;
        throw new Error(`No image at index ${index}`);
      },
      littleEndian: true,
      bigTiff: false,
      close
    }));

    try {
      const file = new File([new Uint8Array([
        1, 2, 3, 4,
        5, 6, 7, 8,
        9, 10, 11, 12,
        13, 14, 15, 16
      ])], "tiled-sparse.tif", { type: "image/tiff" });
      const ds = await addDatasetFromMockedTiff(file, { createDataset, ioConcurrency: 1, cacheBytes: 16 * 1024 * 1024 });
      const out = await readBandWindow(ds.meta, ds.ds, 0, 0, 0, 2, 2, 2, 1);
      expect(Array.from(out)).toEqual([1, 5, 9, 13]);
      expect(ds.ds.stats.decodeCalls).toBe(0);
    } finally {
      vi.doUnmock("geotiff");
      vi.resetModules();
    }
  });

  test("skips raw validation reads for large single-strip TIFF fast paths", async () => {
    const fakeImage = {
      getWidth: () => 8192,
      getHeight: () => 8192,
      getSamplesPerPixel: () => 1,
      getBitsPerSample: () => 32,
      getSampleFormat: () => 3,
      getFileDirectory: () => ({
        Compression: 1,
        RowsPerStrip: 8192,
        StripOffsets: [0],
        StripByteCounts: [8192 * 8192 * 4],
        PhotometricInterpretation: 1
      }),
      readRasters: vi.fn(async () => {
        throw new Error("validation should have been skipped");
      })
    };
    const close = vi.fn();
    const { addDatasetFromFile: addDatasetFromMockedTiff } = await importLoaderWithMockedFromBlob(async () => ({
      getImageCount: async () => 1,
      getImage: async (index = 0) => {
        if (index === 0) return fakeImage;
        throw new Error(`No image at index ${index}`);
      },
      littleEndian: true,
      bigTiff: false,
      close
    }));

    try {
      const file = new File([new Uint8Array(32 * 1024)], "large-linear.tif", { type: "image/tiff" });
      Object.defineProperty(file, "size", { value: 64 * 1024 * 1024 });
      const ds = await addDatasetFromMockedTiff(file, { createDataset, ioConcurrency: 1 });
      expect(ds.meta.bands).toBe(1);
      expect(fakeImage.readRasters).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("geotiff");
      vi.resetModules();
    }
  });

  test("keeps block-indexed TIFF handles open after dataset creation", async () => {
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
        PhotometricInterpretation: 3
      }),
      readRGB: vi.fn(async () => new Uint8Array([
        255, 0, 0,
        0, 255, 0,
        0, 0, 255
      ]))
    };
    const close = vi.fn();
    const { addDatasetFromFile: addDatasetFromMockedTiff } = await importLoaderWithMockedFromBlob(async () => ({
      getImageCount: async () => 1,
      getImage: async (index = 0) => {
        if (index === 0) return fakeImage;
        throw new Error(`No image at index ${index}`);
      },
      littleEndian: true,
      bigTiff: false,
      close
    }));

    try {
      const file = new File([new Uint8Array([0, 0, 0])], "palette-open.tif", { type: "image/tiff" });
      const ds = await addDatasetFromMockedTiff(file, { createDataset, ioConcurrency: 1 });
      expect(close).not.toHaveBeenCalled();
      await readBandWindowBIP(ds.meta, ds.ds, 0, 0, 0, 3, 1, 1, 1);
      expect(fakeImage.readRGB).toHaveBeenCalled();
      ds.ds.close();
      expect(close).toHaveBeenCalled();
    } finally {
      vi.doUnmock("geotiff");
      vi.resetModules();
    }
  });

  test("raises on huge compressed single-strip TIFF", async () => {
    const fakeImage = {
      getWidth: () => 32768,
      getHeight: () => 32768,
      getSamplesPerPixel: () => 1,
      getBitsPerSample: () => 16,
      getSampleFormat: () => 1,
      getFileDirectory: () => ({
        Compression: 5,
        RowsPerStrip: 32768,
        StripOffsets: [0],
        StripByteCounts: [8 * 1024 * 1024],
        PhotometricInterpretation: 1
      }),
      tiles: {}
    };
    const close = vi.fn();
    const { addDatasetFromFile: addDatasetFromMockedTiff } = await importLoaderWithMockedFromBlob(async () => ({
      getImageCount: async () => 1,
      getImage: async (index = 0) => {
        if (index === 0) return fakeImage;
        throw new Error(`No image at index ${index}`);
      },
      littleEndian: true,
      bigTiff: false,
      close
    }));

    try {
      const file = new File([new Uint8Array([0])], "huge-compressed.tif", { type: "image/tiff" });
      await expect(addDatasetFromMockedTiff(file, { createDataset, ioConcurrency: 1 }))
        .rejects
        .toThrow(/compressed-strip TIFF is not supported/i);
    } finally {
      vi.doUnmock("geotiff");
      vi.resetModules();
    }
  });
});
