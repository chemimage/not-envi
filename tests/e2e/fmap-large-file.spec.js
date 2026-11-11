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
        return { first, second, stats: source.stats, residentBytes: source.cacheBytes(), fileSize: file.size };
      } finally {
        source.close();
      }
    }, { headerOffset });

    expect(result.fileSize).toBe(headerOffset + markers.byteLength);
    expect(result.first).toEqual(Array.from(markers));
    expect(result.second).toEqual(Array.from(markers));
    expect(result.stats.browserBytes).toBeLessThanOrEqual(8192);
    expect(result.stats.cacheHits).toBeGreaterThan(0);
    expect(result.residentBytes).toBe(8192);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
