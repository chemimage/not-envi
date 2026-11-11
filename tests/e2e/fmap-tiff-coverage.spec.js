import { expect, test } from "@playwright/test";
import { deflateSync } from "node:zlib";

const SHORT = 3;
const LONG = 4;

function align2(value) {
  return (value + 1) & ~1;
}

function classicTiff(pages, { minDataOffset = 0 } = {}) {
  const normalized = pages.map((page) => ({
    ...page,
    bits: page.bits || Array.from({ length: page.samplesPerPixel || 1 }, () => 8),
    samplesPerPixel: page.samplesPerPixel || 1,
    photometric: page.photometric ?? 1,
    planarConfiguration: page.planarConfiguration || 1,
    compression: page.compression || 1,
    blocks: page.blocks.map((block) => Uint8Array.from(block))
  }));

  const descriptors = normalized.map((page) => {
    const tiled = Number.isInteger(page.tileWidth) && Number.isInteger(page.tileHeight);
    const entries = [
      { tag: 256, type: LONG, values: [page.width] },
      { tag: 257, type: LONG, values: [page.height] },
      { tag: 258, type: SHORT, values: page.bits },
      { tag: 259, type: SHORT, values: [page.compression] },
      { tag: 262, type: SHORT, values: [page.photometric] },
      { tag: tiled ? 324 : 273, type: LONG, source: "blockOffsets" },
      { tag: 277, type: SHORT, values: [page.samplesPerPixel] },
      ...(tiled
        ? [
            { tag: 322, type: LONG, values: [page.tileWidth] },
            { tag: 323, type: LONG, values: [page.tileHeight] },
            { tag: 325, type: LONG, source: "blockByteCounts" }
          ]
        : [
            { tag: 278, type: LONG, values: [page.rowsPerStrip || page.height] },
            { tag: 279, type: LONG, source: "blockByteCounts" }
          ]),
      { tag: 284, type: SHORT, values: [page.planarConfiguration] }
    ];
    if (page.newSubfileType != null) entries.push({ tag: 254, type: LONG, values: [page.newSubfileType] });
    if (page.predictor != null) entries.push({ tag: 317, type: SHORT, values: [page.predictor] });
    if (page.subIfd != null) entries.push({ tag: 330, type: LONG, source: "subIfd" });
    if (page.sampleFormat != null) {
      const values = Array.isArray(page.sampleFormat)
        ? page.sampleFormat
        : Array.from({ length: page.samplesPerPixel }, () => page.sampleFormat);
      entries.push({ tag: 339, type: SHORT, values });
    }
    entries.sort((a, b) => a.tag - b.tag);
    return entries;
  });

  const ifdOffsets = [];
  let cursor = 8;
  for (const entries of descriptors) {
    ifdOffsets.push(cursor);
    cursor += 2 + (entries.length * 12) + 4;
  }
  cursor = align2(cursor);

  for (let pageIndex = 0; pageIndex < descriptors.length; pageIndex += 1) {
    for (const entry of descriptors[pageIndex]) {
      const values = entry.values || (entry.source === "blockByteCounts"
        ? normalized[pageIndex].blocks.map((block) => block.byteLength)
        : entry.source === "blockOffsets"
          ? normalized[pageIndex].blocks.map(() => 0)
          : entry.source === "subIfd"
            ? [0]
            : []);
      const bytes = values.length * (entry.type === SHORT ? 2 : 4);
      entry.count = values.length;
      if (bytes > 4) {
        entry.auxOffset = cursor;
        cursor = align2(cursor + bytes);
      }
    }
  }
  cursor = Math.max(cursor, minDataOffset);

  for (const page of normalized) {
    page.blockOffsets = [];
    for (const block of page.blocks) {
      page.blockOffsets.push(cursor);
      cursor += block.byteLength;
    }
  }

  const buffer = new ArrayBuffer(cursor);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes[0] = 0x49;
  bytes[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffsets[0], true);

  const writeValues = (offset, type, values) => {
    for (let index = 0; index < values.length; index += 1) {
      if (type === SHORT) view.setUint16(offset + (index * 2), values[index], true);
      else view.setUint32(offset + (index * 4), values[index], true);
    }
  };

  for (let pageIndex = 0; pageIndex < normalized.length; pageIndex += 1) {
    const page = normalized[pageIndex];
    const entries = descriptors[pageIndex];
    let entryOffset = ifdOffsets[pageIndex];
    view.setUint16(entryOffset, entries.length, true);
    entryOffset += 2;
    for (const entry of entries) {
      const values = entry.source === "blockOffsets"
        ? page.blockOffsets
        : entry.source === "blockByteCounts"
          ? page.blocks.map((block) => block.byteLength)
          : entry.source === "subIfd"
            ? [ifdOffsets[page.subIfd]]
            : entry.values;
      view.setUint16(entryOffset, entry.tag, true);
      view.setUint16(entryOffset + 2, entry.type, true);
      view.setUint32(entryOffset + 4, values.length, true);
      if (entry.auxOffset != null) {
        view.setUint32(entryOffset + 8, entry.auxOffset, true);
        writeValues(entry.auxOffset, entry.type, values);
      } else {
        writeValues(entryOffset + 8, entry.type, values);
      }
      entryOffset += 12;
    }
    view.setUint32(entryOffset, page.next == null ? 0 : ifdOffsets[page.next], true);
    page.blocks.forEach((block, blockIndex) => bytes.set(block, page.blockOffsets[blockIndex]));
  }
  return new Uint8Array(buffer);
}

function horizontalPredictor8(values, width) {
  const encoded = Uint8Array.from(values);
  for (let rowStart = 0; rowStart < encoded.length; rowStart += width) {
    for (let x = width - 1; x > 0; x -= 1) {
      encoded[rowStart + x] = (encoded[rowStart + x] - encoded[rowStart + x - 1]) & 0xff;
    }
  }
  return encoded;
}

function floatingPointPredictor32(values, width) {
  const height = values.length / width;
  const output = new Uint8Array(values.length * 4);
  for (let y = 0; y < height; y += 1) {
    const row = new Uint8Array(width * 4);
    const rowView = new DataView(row.buffer);
    for (let x = 0; x < width; x += 1) rowView.setFloat32(x * 4, values[(y * width) + x], true);
    const shuffled = new Uint8Array(row.length);
    for (let x = 0; x < width; x += 1) {
      for (let byte = 0; byte < 4; byte += 1) shuffled[((3 - byte) * width) + x] = row[(x * 4) + byte];
    }
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      shuffled[index] = (shuffled[index] - shuffled[index - 1]) & 0xff;
    }
    output.set(shuffled, y * row.length);
  }
  return output;
}

test.describe("fmap TIFF advanced browser coverage", () => {
  test("reads planar RGB edge tiles through the actual file loader", async ({ page }) => {
    await page.goto("/?fmap=1");
    const fixture = classicTiff([{
      width: 3,
      height: 2,
      samplesPerPixel: 3,
      photometric: 2,
      planarConfiguration: 2,
      tileWidth: 2,
      tileHeight: 2,
      blocks: [
        [1, 2, 4, 5], [3, 0, 6, 0],
        [11, 12, 14, 15], [13, 0, 16, 0],
        [21, 22, 24, 25], [23, 0, 26, 0]
      ]
    }]);

    const result = await page.evaluate(async (fixtureBytes) => {
      const { addDatasetsFromFileList } = await import("/src/io/dataset-loader.js");
      const { readBandWindow } = await import("/src/core/raster-io.js");
      const loaded = await addDatasetsFromFileList(
        [new File([Uint8Array.from(fixtureBytes)], "planar-edge.tiff", { type: "image/tiff" })],
        { fmapEnabled: true, createDataset: ({ meta, cached }) => ({ meta, ds: cached }) }
      );
      const dataset = loaded.datasets[0];
      try {
        return {
          sourceClass: dataset.ds.constructor.name,
          isFmap: (await dataset.ds.getStats()).isFmap,
          bands: await Promise.all([0, 1, 2].map(async (band) => Array.from(
            await readBandWindow(dataset.meta, dataset.ds, band, 0, 0, 3, 2, 1)
          )))
        };
      } finally {
        dataset.ds.close();
      }
    }, Array.from(fixture));

    expect(result.sourceClass.toLowerCase()).toContain("tiff");
    expect(result.isFmap).toBe(true);
    expect(result.bands).toEqual([
      [1, 2, 3, 4, 5, 6],
      [11, 12, 13, 14, 15, 16],
      [21, 22, 23, 24, 25, 26]
    ]);
  });

  test("exposes uniform grayscale pages as bands and selects a native SubIFD overview", async ({ page }) => {
    await page.goto("/?fmap=1");
    const multipage = classicTiff([
      { width: 3, height: 2, blocks: [[1, 2, 3, 4, 5, 6]], next: 1 },
      { width: 3, height: 2, blocks: [[11, 12, 13, 14, 15, 16]] }
    ]);
    const overview = classicTiff([
      { width: 4, height: 2, tileWidth: 4, tileHeight: 2, blocks: [[1, 2, 3, 4, 5, 6, 7, 8]], subIfd: 1 },
      { width: 2, height: 1, tileWidth: 2, tileHeight: 1, blocks: [[21, 22]], newSubfileType: 1 }
    ]);

    const result = await page.evaluate(async ({ multipageBytes, overviewBytes }) => {
      const { addDatasetsFromFileList } = await import("/src/io/dataset-loader.js");
      const { readBandWindow } = await import("/src/core/raster-io.js");
      const open = async (bytes, name) => {
        const loaded = await addDatasetsFromFileList(
          [new File([Uint8Array.from(bytes)], name, { type: "image/tiff" })],
          { fmapEnabled: true, createDataset: ({ meta, cached }) => ({ meta, ds: cached }) }
        );
        return loaded.datasets[0];
      };
      const pages = await open(multipageBytes, "pages.tiff");
      const pyramid = await open(overviewBytes, "subifd.tiff");
      try {
        return {
          pageBands: pages.meta.bands,
          page0: Array.from(await readBandWindow(pages.meta, pages.ds, 0, 0, 0, 3, 2, 1)),
          page1: Array.from(await readBandWindow(pages.meta, pages.ds, 1, 0, 0, 3, 2, 1)),
          overviewCount: pyramid.ds.overviewCount,
          overview: Array.from(await readBandWindow(pyramid.meta, pyramid.ds, 0, 0, 0, 2, 1, 2)),
          overviewFmap: (await pyramid.ds.getStats()).isFmap
        };
      } finally {
        pages.ds.close();
        pyramid.ds.close();
      }
    }, { multipageBytes: Array.from(multipage), overviewBytes: Array.from(overview) });

    expect(result.pageBands).toBe(2);
    expect(result.page0).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.page1).toEqual([11, 12, 13, 14, 15, 16]);
    expect(result.overviewCount).toBe(1);
    expect(result.overview).toEqual([21, 22]);
    expect(result.overviewFmap).toBe(true);
  });

  test("decodes Deflate predictor 2 integer and predictor 3 float strips", async ({ page }) => {
    await page.goto("/?fmap=1");
    const integerValues = [10, 20, 35, 60, 5, 15, 30, 55];
    const floatValues = [1.25, -2.5, 1000.125, 0.5, Math.PI, -0.25, 64.5, 7.75];
    const predictor2 = classicTiff([{
      width: 4,
      height: 2,
      compression: 8,
      predictor: 2,
      blocks: [deflateSync(horizontalPredictor8(integerValues, 4))]
    }]);
    const predictor3 = classicTiff([{
      width: 4,
      height: 2,
      bits: [32],
      sampleFormat: 3,
      compression: 8,
      predictor: 3,
      blocks: [deflateSync(floatingPointPredictor32(floatValues, 4))]
    }]);

    const result = await page.evaluate(async ({ predictor2Bytes, predictor3Bytes }) => {
      const { addDatasetsFromFileList } = await import("/src/io/dataset-loader.js");
      const { readBandWindow } = await import("/src/core/raster-io.js");
      const read = async (bytes, name) => {
        const loaded = await addDatasetsFromFileList(
          [new File([Uint8Array.from(bytes)], name, { type: "image/tiff" })],
          { fmapEnabled: true, createDataset: ({ meta, cached }) => ({ meta, ds: cached }) }
        );
        const dataset = loaded.datasets[0];
        try {
          return {
            values: Array.from(await readBandWindow(dataset.meta, dataset.ds, 0, 0, 0, 4, 2, 1)),
            isFmap: (await dataset.ds.getStats()).isFmap
          };
        } finally {
          dataset.ds.close();
        }
      };
      return {
        predictor2: await read(predictor2Bytes, "predictor2.tiff"),
        predictor3: await read(predictor3Bytes, "predictor3.tiff")
      };
    }, { predictor2Bytes: Array.from(predictor2), predictor3Bytes: Array.from(predictor3) });

    expect(result.predictor2.isFmap).toBe(true);
    expect(result.predictor2.values).toEqual(integerValues);
    expect(result.predictor3.isFmap).toBe(true);
    expect(result.predictor3.values).toEqual(floatValues.map(Math.fround));
  });

  test("rejects an oversized decoded tile before reading its compressed block", async ({ page }) => {
    await page.goto("/?fmap=1");
    const width = 1800;
    const height = 1800;
    const fixture = classicTiff([{
      width,
      height,
      tileWidth: width,
      tileHeight: height,
      compression: 8,
      blocks: [deflateSync(new Uint8Array(width * height))]
    }], { minDataOffset: 512 * 1024 });

    const result = await page.evaluate(async (fixtureBytes) => {
      const { addDatasetsFromFileList } = await import("/src/io/dataset-loader.js");
      const { readBandWindow } = await import("/src/core/raster-io.js");
      const loaded = await addDatasetsFromFileList(
        [new File([Uint8Array.from(fixtureBytes)], "budget.tiff", { type: "image/tiff" })],
        {
          fmapEnabled: true,
          cacheBytes: 4 * 1024 * 1024,
          tiffFmapOptions: { maxWorkingSetBytes: 16 * 1024 * 1024 },
          createDataset: ({ meta, cached }) => ({ meta, ds: cached })
        }
      );
      const dataset = loaded.datasets[0];
      try {
        const before = await dataset.ds.getStats();
        let error = null;
        try {
          await readBandWindow(dataset.meta, dataset.ds, 0, 0, 0, 1, 1, 1);
        } catch (caught) {
          error = String(caught?.message || caught);
        }
        const after = await dataset.ds.getStats();
        return {
          error,
          beforeBrowserBytes: before.browserBytes,
          afterBrowserBytes: after.browserBytes,
          decodedCacheLimitBytes: after.decodedCacheLimitBytes,
          isFmap: after.isFmap
        };
      } finally {
        dataset.ds.close();
      }
    }, Array.from(fixture));

    expect(result.isFmap).toBe(true);
    expect(result.error).toMatch(/decoded-cache budget/i);
    expect(result.beforeBrowserBytes).toBeLessThan(512 * 1024);
    expect(result.afterBrowserBytes).toBe(result.beforeBrowserBytes);
  });
});
