import { Blob as NodeBlob } from "node:buffer";
import { describe, expect, test, vi } from "vitest";
import { buildTiffImageCatalog, compactTiffIntegers, createCompactBlockTable } from "../../src/io/tiff/metadata-index.js";
import { openNativeTiffBackend } from "../../src/io/tiff/backend/native-backend.js";
import { loadImageSummaries, loadSubIfdOverviewSummaries } from "../../src/io/tiff/shared.js";

function summary(width = 8, height = 8, offset = 8, extra = {}) {
  return { image: {}, width, height, samplesPerPixel: 1, bitsPerSample: [8], sampleFormats: [1],
    planarConfiguration: 1, photometricInterpretation: 1, compression: 1, rowsPerStrip: height,
    tileOffsets: [], stripOffsets: [2048], stripByteCounts: [width * height], subIFDOffsets: [],
    pageNumber: [], newSubfileType: 0, fileDirectory: { __ifdOffset: offset }, ...extra };
}

function structuralFile(specs) {
  const bytes = new Uint8Array(4096), view = new DataView(bytes.buffer);
  bytes.set([73, 73]); view.setUint16(2, 42, true); view.setUint32(4, specs[0].offset, true);
  specs.forEach((spec, imageIndex) => {
    const tags = [[254, 4, spec.reduced || 0], [256, 4, spec.width], [257, 4, spec.height],
      [258, 3, 8], [259, 3, 1], [262, 3, 1], [273, 4, 2048 + imageIndex * 64],
      [277, 3, 1], [278, 4, spec.height], [279, 4, spec.width * spec.height], [284, 3, 1]];
    if (spec.child) tags.push([330, 4, spec.child]);
    view.setUint16(spec.offset, tags.length, true);
    tags.forEach(([tag, type, value], index) => {
      const at = spec.offset + 2 + index * 12;
      view.setUint16(at, tag, true); view.setUint16(at + 2, type, true);
      view.setUint32(at + 4, 1, true); view.setUint32(at + 8, value, true);
    });
    view.setUint32(spec.offset + 2 + tags.length * 12, spec.next || 0, true);
  });
  return { bytes, file: new NodeBlob([bytes], { type: "image/tiff" }) };
}

describe("compact TIFF structural index", () => {
  test("keeps exact BigTIFF columns and constructs only accessed block descriptors", () => {
    const table = createCompactBlockTable(summary(5, 3, 8, {
      samplesPerPixel: 3, planarConfiguration: 2,
      tileOffsets: Array.from({ length: 18 }, (_v, i) => 2 ** 32 + i * 100),
      fileDirectory: { TileWidth: 2, TileLength: 2, TileByteCounts: new Uint32Array(18).fill(4) }
    }), "level0");
    expect(table.offsets).toBeInstanceOf(Float64Array);
    expect(table.byteCounts).toBeInstanceOf(Uint32Array);
    expect(table.blockCount).toBe(18);
    const group = table.group(2);
    expect(group).toBe(table.group(2));
    expect(group.length).toBe(6);
    expect(group.at(5)).toEqual({ key: "imglevel0:g2:b5", imageIndex: "level0", group: 2,
      bx: 2, by: 1, x0: 4, y0: 2, w: 1, h: 1, offset: 2 ** 32 + 1700, byteCount: 4 });
    expect(group.at(5)).not.toBe(group.at(5));
    expect(group.at(6)).toBeUndefined();
    expect(Array.isArray(group)).toBe(false);
  });

  test("reuses typed columns for a large tile index and rejects inexact addresses", () => {
    const offsets = Uint32Array.from({ length: 100_000 }, (_v, i) => 1_000_000 + i);
    const counts = new Uint32Array(offsets.length).fill(1);
    const table = createCompactBlockTable(summary(offsets.length, 1, 8, {
      tileOffsets: offsets, fileDirectory: { TileWidth: 1, TileLength: 1, TileByteCounts: counts }
    }));
    expect(table.offsets).toBe(offsets);
    expect(table.byteCounts).toBe(counts);
    expect(table.group(0).at(99_999).offset).toBe(1_099_999);
    expect(() => compactTiffIntegers([2n ** 53n + 1n])).toThrow(/Unsupported/);
    expect(() => compactTiffIntegers([1.5])).toThrow(/Unsupported/);
  });

  test("groups only compatible reduced images or descendants, preserving ordinary pages and labels", () => {
    const base = summary(100, 60, 8);
    const reduced = summary(50, 30, 256, { newSubfileType: 1 });
    const page = summary(50, 30, 512);
    const descendant = summary(25, 15, 768);
    const label = summary(10, 6, 1024, { newSubfileType: 1, fileDirectory: { __ifdOffset: 1024, ImageDescription: "label" } });
    const mask = summary(10, 6, 1280, { newSubfileType: 5 });
    const wrongAspect = summary(10, 10, 1536, { newSubfileType: 1 });
    const catalog = buildTiffImageCatalog([base, reduced, page, label],
      [base, reduced, page, descendant, label, mask, wrongAspect], new Map([[768, new Set([256])],
        [1280, new Set([8])], [1536, new Set([8])]]));
    expect(catalog.families.map((family) => family.base)).toEqual([base, page]);
    expect(catalog.families[0].levels.map((level) => level.fileDirectory.__ifdOffset)).toEqual([8, 256, 768]);
    expect(catalog.families[1].levels).toEqual([page]);
    expect(catalog.associatedImages).toEqual([label, mask, wrongAspect]);
  });

  test("eagerly indexes nested SubIFDs and chains once through bounded shared metadata reads", async () => {
    const { bytes, file } = structuralFile([
      { offset: 8, width: 8, height: 8, next: 256, child: 768 },
      { offset: 256, width: 4, height: 4, reduced: 1, next: 512 },
      { offset: 512, width: 8, height: 8 },
      { offset: 768, width: 2, height: 2, child: 1024 },
      { offset: 1024, width: 1, height: 1, next: 1280, child: 768 },
      { offset: 1280, width: 1, height: 1 }
    ]);
    const read = vi.fn(async (offset, length) => bytes.slice(offset, offset + length));
    const backend = await openNativeTiffBackend(file, { tiffFmapRangeSource: {
      read, maxLogicalResultBytes: 64, maxWorkingSetBytes: 64
    } });
    try {
      expect(await backend.getImageCount()).toBe(3);
      expect(backend.metadataIndex.allImages).toHaveLength(6);
      expect(backend.metadataIndex.families).toHaveLength(2);
      expect(backend.metadataIndex.families[0].levels.map((image) => image.width)).toEqual([8, 4, 2, 1, 1]);
      expect(read.mock.calls.every(([offset, length]) => offset + length < 2048 && length <= 32)).toBe(true);
      const calls = read.mock.calls.length;
      const summaries = await loadImageSummaries(backend);
      expect(summaries).toBe(backend.metadataIndex.mainImages);
      expect(await loadSubIfdOverviewSummaries(backend, summaries[0])).toHaveLength(4);
      const a = await backend.parseFileDirectoryAt(768), b = await backend.parseFileDirectoryAt(768);
      expect(a).toBe(b);
      expect(read).toHaveBeenCalledTimes(calls);
      expect(a.fileDirectory.StripOffsets).toBeInstanceOf(Uint32Array);
    } finally { backend.close(); }
  });

  test("associates reduced-first main-chain images with a following compatible base", () => {
    const reduced = summary(4, 4, 8, { newSubfileType: 1 });
    const smallest = summary(2, 2, 256, { newSubfileType: 1 });
    const base = summary(8, 8, 512);
    const ordinaryPage = summary(8, 8, 768);
    const catalog = buildTiffImageCatalog([reduced, smallest, base, ordinaryPage], [reduced, smallest, base, ordinaryPage]);
    expect(catalog.families.map((family) => family.base)).toEqual([base, ordinaryPage]);
    expect(catalog.families[0].levels.map((level) => level.fileDirectory.__ifdOffset)).toEqual([512, 8, 256]);
    expect(catalog.families[1].levels).toEqual([ordinaryPage]);
  });

  test("uses page provenance before nearest-base order in interleaved families", () => {
    const page0 = summary(8, 8, 8, { pageNumber: [0, 2] });
    const reduced1 = summary(4, 4, 256, { newSubfileType: 1, pageNumber: [1, 2] });
    const page1 = summary(8, 8, 512, { pageNumber: [1, 2] });
    const reduced0 = summary(4, 4, 768, { newSubfileType: 1, pageNumber: [0, 2] });
    const orphan = summary(4, 4, 1024, { newSubfileType: 1, pageNumber: [2, 3] });
    const pages = [page0, reduced1, page1, reduced0, orphan];
    const catalog = buildTiffImageCatalog(pages, pages);
    expect(catalog.families.map((family) => family.base)).toEqual([page0, page1, orphan]);
    expect(catalog.families[0].levels.map((level) => level.fileDirectory.__ifdOffset)).toEqual([8, 768]);
    expect(catalog.families[1].levels.map((level) => level.fileDirectory.__ifdOffset)).toEqual([512, 256]);
    expect(catalog.families[2].levels).toEqual([orphan]);
  });

  test("prefers the nearest preceding compatible base when page provenance is absent", () => {
    const a = summary(8, 8, 8), b = summary(8, 8, 256);
    const reduced = summary(4, 4, 512, { newSubfileType: 1 });
    const catalog = buildTiffImageCatalog([a, b, reduced], [a, b, reduced]);
    expect(catalog.families[0].levels).toEqual([a]);
    expect(catalog.families[1].levels.map((level) => level.fileDirectory.__ifdOffset)).toEqual([256, 512]);
  });

  test("rejects a main-chain cycle rather than repeatedly parsing metadata", async () => {
    const { file } = structuralFile([{ offset: 8, width: 8, height: 8, next: 8 }]);
    await expect(openNativeTiffBackend(file)).rejects.toThrow(/cyclic/);
  });

  test("deduplicates a shared SubIFD while making its level available to both parent families", () => {
    const a = summary(8, 8, 8), b = summary(16, 16, 256), shared = summary(4, 4, 512);
    const catalog = buildTiffImageCatalog([a, b], [a, b, shared], new Map([[512, new Set([8, 256])]]));
    expect(catalog.allImages).toHaveLength(3);
    expect(catalog.families[0].levels[1].image).toBe(shared.image);
    expect(catalog.families[1].levels[1].image).toBe(shared.image);
    expect(catalog.families[0].levels[1].scale).toBe(2);
    expect(catalog.families[1].levels[1].scale).toBe(4);
  });

  test("keeps the base usable when an optional SubIFD is truncated", async () => {
    const { file } = structuralFile([{ offset: 8, width: 8, height: 8, child: 4095 }]);
    const backend = await openNativeTiffBackend(file);
    try {
      expect(backend.metadataIndex.allImages).toHaveLength(1);
      expect(backend.metadataWarnings).toHaveLength(1);
    } finally { backend.close(); }
  });
});
