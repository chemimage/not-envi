import { expect, test } from "@playwright/test";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("worker reads known Float32 markers beyond 4 GiB from a sparse on-disk file", async ({ page }) => {
  test.skip(process.env.FMAP_LARGE_FILE !== "1", "Run explicitly with npm run test:fmap-large.");
  const directory = mkdtempSync(path.join(tmpdir(), "hyve-fmap-"));
  const filePath = path.join(directory, "beyond-4g.dat");
  // Deliberately unaligned so the first Float32 value crosses a 4 KiB page.
  const headerOffset = (4 * 1024 * 1024 * 1024) + 4093;
  const markers = new Float32Array([1.25, -2.5, 3.75, 9.5]);
  const handle = openSync(filePath, "w");
  try {
    writeSync(handle, Buffer.from(markers.buffer), 0, markers.byteLength, headerOffset);
  } finally {
    closeSync(handle);
  }

  try {
    await page.goto("/");
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.type = "file";
      input.id = "fmap-large-fixture";
      document.body.append(input);
    });
    await page.locator("#fmap-large-fixture").setInputFiles(filePath);
    const result = await page.evaluate(async ({ headerOffset }) => {
      const file = document.querySelector("#fmap-large-fixture").files[0];
      const [{ createFmapDataSource }, wasmResponse] = await Promise.all([
        import("/src/io/fmap/index.js"),
        fetch("/wasm/fmap/pkg/fmap_core.wasm")
      ]);
      const wasmBytes = await wasmResponse.arrayBuffer();
      const meta = {
        samples: 1,
        lines: 1,
        bands: 4,
        headerOffset,
        interleave: "bsq",
        dataType: 4,
        littleEndian: true,
        dataTypeInfo: { bytes: 4 }
      };
      const source = createFmapDataSource(file, meta, {
        pageSize: 4096,
        poolBytes: 8192,
        concurrency: 1,
        wasmBytes
      });
      try {
        await source.ready;
        const first = Array.from(await source.readSpectrumAtPixel(meta, 0, 0));
        const second = Array.from(await source.readSpectrumAtPixel(meta, 0, 0));
        return { first, second, stats: await source.getStats(), residentBytes: source.cacheBytes(), fileSize: file.size };
      } finally {
        source.close();
      }
    }, { headerOffset });

    expect(result.fileSize).toBe(headerOffset + markers.byteLength);
    expect(result.first).toEqual(Array.from(markers));
    expect(result.second).toEqual(Array.from(markers));
    expect(result.stats.browserBytes).toBeLessThanOrEqual(32);
    expect(result.stats.sparseReads).toBeGreaterThan(0);
    expect(result.residentBytes).toBe(8192);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("generic numeric reads preserve exact offsets around 2 GiB and 4 GiB", async ({ page }) => {
  test.skip(process.env.FMAP_LARGE_FILE !== "1", "Run explicitly with npm run test:fmap-large.");
  const directory = mkdtempSync(path.join(tmpdir(), "hyve-fmap-numeric-"));
  const filePath = path.join(directory, "numeric-boundaries.dat");
  const offsets = [(2 ** 31) - 3, (2 ** 32) - 3, (2 ** 32) + 4093];
  const markers = [1.25, -2.5, Math.PI, (2 ** 40) + 0.125];
  const encoded = Buffer.alloc(markers.length * 8);
  markers.forEach((value, index) => encoded.writeDoubleBE(value, index * 8));
  const handle = openSync(filePath, "w");
  try {
    for (const offset of offsets) writeSync(handle, encoded, 0, encoded.byteLength, offset);
  } finally { closeSync(handle); }
  try {
    await page.goto("/");
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.type = "file";
      input.id = "fmap-boundary-fixture";
      document.body.append(input);
    });
    await page.locator("#fmap-boundary-fixture").setInputFiles(filePath);
    const actual = await page.evaluate(async ({ offsets }) => {
      const { createFmapDataSource } = await import("/src/io/fmap/index.js");
      const { DATA_TYPES } = await import("/src/core/envi-types.js");
      const wasmBytes = await (await fetch("/wasm/fmap/pkg/fmap_core.wasm")).arrayBuffer();
      const file = document.querySelector("#fmap-boundary-fixture").files[0];
      const results = [];
      for (const headerOffset of offsets) {
        const meta = { samples: 4, lines: 1, bands: 1, headerOffset, interleave: "bip",
          dataType: 5, dataTypeInfo: DATA_TYPES.get(5), littleEndian: false };
        const source = createFmapDataSource(file, meta, { wasmBytes, pageSize: 4096, poolBytes: 8192 });
        try {
          const values = await source.readBandWindow(meta, 0, 0, 0, 4, 1, 1);
          const stats = await source.getStats();
          if (stats.browserBytes > 32) throw new Error("Sparse numeric boundary read amplified beyond its exact span");
          results.push(Array.from(values));
        } finally { source.close(); }
      }
      return results;
    }, { offsets });
    expect(actual).toEqual(offsets.map(() => markers));
  } finally {
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(resolved).startsWith("hyve-fmap-numeric-")) {
      throw new Error("Refusing to remove an unexpected fixture directory");
    }
    rmSync(resolved, { recursive: true, force: true });
  }
});

test("BigTIFF decodes a strip beyond 4 GiB through the fmap source", async ({ page }) => {
  test.skip(process.env.FMAP_LARGE_FILE !== "1", "Run explicitly with npm run test:fmap-large.");
  const directory = mkdtempSync(path.join(tmpdir(), "hyve-fmap-bigtiff-"));
  const filePath = path.join(directory, "beyond-4g.tiff");
  const stripOffset = (2 ** 32) + 4093;
  const tags = [
    [256, 4, 2], [257, 4, 2], [258, 3, 16], [259, 3, 1],
    [262, 3, 1], [273, 16, stripOffset], [277, 3, 1], [278, 4, 2], [279, 16, 8]
  ];
  const header = Buffer.alloc(16 + 8 + tags.length * 20 + 8);
  header.write("II", 0);
  header.writeUInt16LE(43, 2);
  header.writeUInt16LE(8, 4);
  header.writeBigUInt64LE(16n, 8);
  header.writeBigUInt64LE(BigInt(tags.length), 16);
  tags.forEach(([tag, type, value], index) => {
    const offset = 24 + index * 20;
    header.writeUInt16LE(tag, offset);
    header.writeUInt16LE(type, offset + 2);
    header.writeBigUInt64LE(1n, offset + 4);
    header.writeBigUInt64LE(BigInt(value), offset + 12);
  });
  const values = new Uint16Array([100, 200, 300, 400]);
  const handle = openSync(filePath, "w");
  try {
    writeSync(handle, header, 0, header.length, 0);
    writeSync(handle, Buffer.from(values.buffer), 0, values.byteLength, stripOffset);
  } finally { closeSync(handle); }
  try {
    await page.goto("/?fmap=1");
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.type = "file";
      input.id = "fmap-bigtiff-fixture";
      document.body.append(input);
    });
    await page.locator("#fmap-bigtiff-fixture").setInputFiles(filePath);
    const result = await page.evaluate(async () => {
      const { addDatasetFromFile } = await import("/src/io/tiff-loader.js");
      const { readBandWindow } = await import("/src/core/raster-io.js");
      const file = document.querySelector("#fmap-bigtiff-fixture").files[0];
      const ds = await addDatasetFromFile(file, { fmapEnabled: true,
        fmapOptions: { pageSizeBytes: 4096, poolBytes: 8192, maxInflightRequests: 1 },
        createDataset: (descriptor) => descriptor });
      try {
        const values = await readBandWindow(ds.meta, ds.cached, 0, 0, 0, 2, 2, 1);
        return { values: Array.from(values), sourceClass: ds.cached.constructor.name,
          cacheBytes: ds.cached.cacheBytes(), bigTiff: ds.raw.bigTiff };
      } finally { ds.cached.close(); ds.base?.close(); }
    });
    expect(result.bigTiff).toBe(true);
    expect(result.sourceClass.toLowerCase()).toContain("fmap");
    expect(result.values).toEqual([100, 200, 300, 400]);
    expect(result.cacheBytes).toBeLessThanOrEqual(16384);
  } finally {
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(resolved).startsWith("hyve-fmap-bigtiff-")) {
      throw new Error("Refusing to remove an unexpected fixture directory");
    }
    rmSync(resolved, { recursive: true, force: true });
  }
});
