import { loadLibtiffCompiled } from "../../src/io/tiff/libtiff/compiled.js";
import { Blob as NodeBlob } from "node:buffer";
import { inflateSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { fromArrayBuffer, GeoTIFFImage } from "geotiff";
import { encodePyramidalTiff, shouldPyramidTiff, tiffStoragePixels } from "../../src/export/tiff-pyramid.js";
import { encodeRawMultipageTiff, encodeRawRgbTiff, encodeRenderedMultipageTiff } from "../../src/export/tiff-backend.js";
import { openNativeTiffBackend } from "../../src/io/tiff/backend/native-backend.js";
import { addDatasetFromFile } from "../../src/io/tiff-loader.js";
import { tiffPhysicalScale } from "../../src/io/tiff/physical-scale.js";

const readBlob = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error);
  reader.readAsArrayBuffer(blob);
});
const values = value => typeof value === "number" ? [value] : Array.from(value || []);
function decodedTile(buffer, image) {
  const fd = image.fileDirectory;
  const bytes = inflateSync(new Uint8Array(buffer, fd.TileOffsets[0], fd.TileByteCounts[0]));
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
async function children(tiff, image) {
  return Promise.all(values(image.fileDirectory.SubIFDs).map(async offset => {
    const parsed = await tiff.parseFileDirectoryAt(offset);
    return new GeoTIFFImage(parsed.fileDirectory, parsed.geoKeyDirectory, tiff.dataView,
      tiff.littleEndian, false, tiff.source);
  }));
}

describe("pyramidal TIFF export", () => {
  test("automatic policy depends on spatial image size", () => {
    expect(shouldPyramidTiff(2048, 2048)).toBe(true);
    expect(shouldPyramidTiff(4096, 1024)).toBe(true);
    expect(shouldPyramidTiff(2047, 2048)).toBe(false);
    expect(shouldPyramidTiff(1024, 1024)).toBe(false);
    expect(shouldPyramidTiff(Infinity, 2)).toBe(false);
    expect(tiffStoragePixels(2048, 2048)).toBe(2048 ** 2 + 1024 ** 2 + 512 ** 2);
    expect(tiffStoragePixels(1024, 1024)).toBe(1024 ** 2);
  });

  test.each([[1, Uint8Array], [2, Int16Array], [3, Int32Array], [4, Float32Array], [5, Float64Array], [12, Uint16Array], [13, Uint32Array]])(
    "preserves type %s base samples and averages odd-sized overviews", async (dataType, Ctor) => {
      const width = 33, height = 17, page = Ctor.from({ length: width * height }, (_, i) => i % width + Math.floor(i / width) * 2);
      const blob = await encodePyramidalTiff({ compiled: await loadLibtiffCompiled(), width, height, pages: [page], meta: { dataType }, tileSize: 16, overviewMaxEdge: 16 });
      const tiff = await fromArrayBuffer(await readBlob(blob)), image = await tiff.getImage();
      expect(await tiff.getImageCount()).toBe(1);
      expect(image.fileDirectory.TileWidth).toBe(16);
      expect((await image.readRasters({ interleave: true })).every((value, i) => value === page[i])).toBe(true);
      const levels = await children(tiff, image);
      expect(levels.map(level => [level.getWidth(), level.getHeight()])).toEqual([[17, 9], [9, 5]]);
      expect(levels.every(level => level.fileDirectory.NewSubfileType === 1)).toBe(true);
      const raster = await levels[0].readRasters({ interleave: true });
      const floating = dataType === 4 || dataType === 5;
      expect(raster[0]).toBe(floating ? 1.5 : 2);
      expect(raster[16]).toBe(33);
      expect(raster[8 * 17]).toBe(floating ? 32.5 : 33);
      expect(raster[8 * 17 + 16]).toBe(64);
    }
  );

  test("preserves NaN payload bits at full resolution and ignores invalid preview samples", async () => {
    const page = new Float32Array([NaN, 2, 4, 6]);
    new DataView(page.buffer).setUint32(0, 0x7fc01234, true);
    const buffer = await readBlob(await encodePyramidalTiff({ compiled: await loadLibtiffCompiled(), width: 2, height: 2, pages: [page], meta: { dataType: 4 }, overviewMaxEdge: 1 }));
    const tiff = await fromArrayBuffer(buffer), image = await tiff.getImage();
    expect(decodedTile(buffer, image).getUint32(0, true)).toBe(0x7fc01234);
    expect((await (await children(tiff, image))[0].readRasters({ interleave: true }))[0]).toBe(4);
  });

  test("finite Float64 averages do not overflow when their sum would", async () => {
    const tiff = await fromArrayBuffer(await readBlob(await encodePyramidalTiff({ compiled: await loadLibtiffCompiled(), width: 2, height: 2,
      pages: [new Float64Array([1e308, 1e308, 1e308, 1e308])], meta: { dataType: 5 }, overviewMaxEdge: 1 })));
    const image = await tiff.getImage();
    expect((await (await children(tiff, image))[0].readRasters({ interleave: true }))[0]).toBe(1e308);
  });

  test.each([[14, BigInt64Array, -9007199254740997n], [15, BigUint64Array, 9007199254740997n]])(
    "keeps 64-bit type %s exact in base tiles and previews", async (dataType, Ctor, first) => {
      const page = new Ctor([first, first + 2n, first + 4n, first + 6n]);
      const buffer = await readBlob(await encodePyramidalTiff({ compiled: await loadLibtiffCompiled(), width: 2, height: 2, pages: [page], meta: { dataType }, overviewMaxEdge: 1 }));
      const tiff = await fromArrayBuffer(buffer), image = await tiff.getImage(), child = (await children(tiff, image))[0];
      const read = async image => {
        const view = decodedTile(buffer, image);
        return dataType === 14 ? view.getBigInt64(0, true) : view.getBigUint64(0, true);
      };
      expect(await read(image)).toBe(first);
      expect(await read(child)).toBe(first + 3n);
    }
  );

  test("planar RGB pyramids preserve channels and 16-bit numeric samples", async () => {
    const pages = [Uint16Array.of(100, 200, 300, 400), Uint16Array.of(1000, 2000, 3000, 4000), Uint16Array.of(60000, 61000, 62000, 63000)];
    const tiff = await fromArrayBuffer(await readBlob(await encodePyramidalTiff({ compiled: await loadLibtiffCompiled(), width: 2, height: 2, pages, composite: true,
      meta: { dataType: 12 }, overviewMaxEdge: 1 })));
    const image = await tiff.getImage();
    expect(await tiff.getImageCount()).toBe(1);
    expect(image.fileDirectory.PlanarConfiguration).toBe(2);
    const rasters = await image.readRasters();
    expect(rasters.map(raster => [...raster])).toEqual(pages.map(page => [...page]));
    expect([...(await (await children(tiff, image))[0].readRasters({ interleave: true }))]).toEqual([250, 2500, 61500]);
  });

  test("RGBA previews average color with alpha without changing full-resolution pixels", async () => {
    const data = Uint8ClampedArray.of(255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 0, 0, 0, 255, 0);
    const tiff = await fromArrayBuffer(await readBlob(await encodePyramidalTiff({ compiled: await loadLibtiffCompiled(), width: 2, height: 2, rendered: true,
      pages: [{ width: 2, height: 2, data }], overviewMaxEdge: 1 })));
    const image = await tiff.getImage();
    expect([...(await image.readRasters({ interleave: true }))]).toEqual([...data]);
    expect([...(await (await children(tiff, image))[0].readRasters({ interleave: true }))]).toEqual([128, 128, 0, 128]);
  });

  test("native reader discovers independent band pyramids rather than extra bands", async () => {
    const pages = [new Float32Array(33 * 17).fill(2), new Float32Array(33 * 17).fill(7)];
    const buffer = await readBlob(await encodePyramidalTiff({ compiled: await loadLibtiffCompiled(), width: 33, height: 17, pages, meta: { dataType: 4 }, overviewMaxEdge: 16 }));
    const backend = await openNativeTiffBackend(new NodeBlob([buffer]));
    try {
      expect(await backend.getImageCount()).toBe(2);
      expect(backend.metadataIndex.families.map(family => family.levels.length)).toEqual([3, 3]);
    } finally { backend.close(); }
  });

  test("large raw, RGB, and rendered export entry points add pyramids automatically", async () => {
    const width = 2048, height = 2048, pixels = width * height;
    const page = Uint8Array.from({ length: pixels }, (_, i) => i % 251);
    const raw = await fromArrayBuffer(await readBlob(await encodeRawMultipageTiff({ compiled: await loadLibtiffCompiled(), width, height, pages: [page, page], meta: { dataType: 1, dataTypeInfo: { bytes: 1 } } })));
    expect(await raw.getImageCount()).toBe(2);
    for (let i = 0; i < 2; i++) {
      const image = await raw.getImage(i);
      expect((await image.readRasters({ interleave: true })).every((value, p) => value === page[p])).toBe(true);
      expect((await children(raw, image)).map(level => level.getWidth())).toEqual([1024, 512]);
    }
    const rgb = await fromArrayBuffer(await readBlob(await encodeRawRgbTiff({ compiled: await loadLibtiffCompiled(), width, height, pages: [page, page, page], meta: { dataType: 1, dataTypeInfo: { bytes: 1 } } })));
    expect(await rgb.getImageCount()).toBe(1);
    expect((await children(rgb, await rgb.getImage())).length).toBe(2);
    const rgba = new Uint8ClampedArray(pixels * 4).fill(255);
    const rendered = await fromArrayBuffer(await readBlob(await encodeRenderedMultipageTiff({ compiled: await loadLibtiffCompiled(), pages: [{ width, height, data: rgba }] })));
    expect((await children(rendered, await rendered.getImage())).length).toBe(2);
  });

  test("preserves anisotropic physical size in odd-sized levels and after reopening", async () => {
    const meta = { dataType: 1, scale: { umPerPixelX: 0.5, umPerPixelY: 1.25 } };
    const pages = [new Uint8Array(33 * 17).fill(3), new Uint8Array(33 * 17).fill(7)];
    const blob = await encodePyramidalTiff({ compiled: await loadLibtiffCompiled(), width: 33, height: 17,
      pages, meta, overviewMaxEdge: 16 });
    const tiff = await fromArrayBuffer(await readBlob(blob));
    for (let page = 0; page < 2; page++) {
      const base = await tiff.getImage(page);
      expect(base.fileDirectory.Compression).toBe(8);
      expect(base.fileDirectory.Software).toMatch(/^not-envi/);
      for (const image of [base, ...await children(tiff, base)]) {
        const scale = tiffPhysicalScale(image.fileDirectory);
        expect(scale.umPerPixelX * image.getWidth()).toBeCloseTo(33 * 0.5, 5);
        expect(scale.umPerPixelY * image.getHeight()).toBeCloseTo(17 * 1.25, 5);
      }
    }
    const ds = await addDatasetFromFile(new File([blob], "calibrated.tiff"), {
      createDataset: ({ meta, cached }) => ({ meta, ds: cached })
    });
    try {
      expect(ds.meta.bands).toBe(2);
      expect(ds.meta.scale.umPerPixelX).toBeCloseTo(0.5);
      expect(ds.meta.scale.umPerPixelY).toBeCloseTo(1.25);
    } finally { ds.ds.close(); }
  });

  test("unknown physical size stays unspecified", async () => {
    const blob = await encodeRawMultipageTiff({ compiled: await loadLibtiffCompiled(), width: 2, height: 2,
      meta: { dataType: 1 }, pages: [new Uint8Array(4)] });
    const image = await (await fromArrayBuffer(await readBlob(blob))).getImage();
    expect(image.fileDirectory.XResolution).toBeUndefined();
    expect(image.fileDirectory.YResolution).toBeUndefined();
  });

  test("rejects invalid plane dimensions and unsupported raw types", async () => {
    await expect(encodePyramidalTiff({ compiled: await loadLibtiffCompiled(), width: 2, height: 2, pages: [new Uint8Array(3)], meta: { dataType: 1 } })).rejects.toThrow("share dimensions");
    await expect(encodePyramidalTiff({ compiled: await loadLibtiffCompiled(), width: 2, height: 2, pages: [new Float32Array(4)], meta: { dataType: 6 } })).rejects.toThrow("Invalid image data");
  });
});
