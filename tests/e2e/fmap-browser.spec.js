import { expect, test } from "@playwright/test";

test.describe("fmap browser integration", () => {
  test("dense RGB windows share bounded fills while spectra and explicit ranges remain sparse", async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(async () => {
      const { createFmapDataSource } = await import("/src/io/fmap/index.js");
      const wasmBytes = await (await fetch("/wasm/fmap/pkg/fmap_core.wasm")).arrayBuffer();
      const samples = 512, lines = 64, bands = 3;
      const valueAt = (band, x, y) => (x * 11 + y * 17 + band * 63) & 255;
      const bytes = Uint8Array.from({ length: samples * lines * bands }, (_, index) =>
        valueAt(index % bands, Math.floor(index / bands) % samples, Math.floor(index / (samples * bands))));
      const meta = { samples, lines, bands, interleave: "bip", dataType: 1, littleEndian: true,
        headerOffset: 0, dataTypeInfo: { bytes: 1, ctor: Uint8Array } };
      const source = createFmapDataSource(new File([bytes], "dense-rgb.dat"), meta,
        { wasmBytes, pageSize: 4096, poolBytes: 65536 });
      try {
        let firstReads;
        for (let band = 0; band < bands; band += 1) {
          const out = await source.readBandWindow(meta, band, 7, 3, 128, 8, 1);
          for (let y = 0; y < 8; y += 1) for (let x = 0; x < 128; x += 1) {
            if (out[y * 128 + x] !== valueAt(band, x + 7, y + 3)) throw new Error("Dense RGB value mismatch.");
          }
          if (band === 0) firstReads = (await source.getStats()).readCalls;
        }
        const all = await source.getStats();
        const spectrum = await source.readSpectrumAtPixel(meta, 500, 60);
        const point = await source.getStats();
        const offset = ((60 * samples + 500) * bands) + 20;
        const range = await source.readRange(offset, 1);
        return { firstReads, allReads: all.readCalls, spectrum: [...spectrum],
          expected: [0, 1, 2].map((band) => valueAt(band, 500, 60)),
          spectrumBytes: point.browserBytes - all.browserBytes,
          rangeBytes: (await source.getStats()).browserBytes - point.browserBytes,
          rangeValue: range[0], expectedRange: bytes[offset] };
      } finally { source.close(); }
    });
    expect(result.firstReads).toBeLessThanOrEqual(4);
    expect(result.allReads).toBe(result.firstReads);
    expect(result.spectrum).toEqual(result.expected);
    expect(result.spectrumBytes).toBe(3);
    expect(result.rangeBytes).toBe(1);
    expect(result.rangeValue).toBe(result.expectedRange);
  });

  test("real WASM reads unaligned BSQ Float32 windows and spectra in both byte orders", async ({ page }) => {
    await page.goto("/");

    const result = await page.evaluate(async () => {
      const { createFmapDataSource } = await import("/src/io/fmap/index.js");
      const wasmResponse = await fetch("/wasm/fmap/pkg/fmap_core.wasm");
      if (!wasmResponse.ok) throw new Error(`WASM fetch failed (${wasmResponse.status})`);
      const wasmBytes = await wasmResponse.arrayBuffer();
      const samples = 7;
      const lines = 5;
      const bands = 3;
      const headerOffset = 4093;
      const valueAt = (band, x, y) => {
        if (band === 0 && y === 0 && x === 0) return Number.NaN;
        if (band === 0 && y === 0 && x === 1) return Number.POSITIVE_INFINITY;
        if (band === 0 && y === 0 && x === 2) return Number.NEGATIVE_INFINITY;
        return (band * 1000) + (y * 100) + x + 0.25;
      };

      const run = async (littleEndian) => {
        const byteLength = headerOffset + (samples * lines * bands * 4);
        const bytes = new Uint8Array(byteLength);
        bytes.fill(0xa5, 0, headerOffset);
        const view = new DataView(bytes.buffer);
        let offset = headerOffset;
        for (let band = 0; band < bands; band += 1) {
          for (let y = 0; y < lines; y += 1) {
            for (let x = 0; x < samples; x += 1) {
              view.setFloat32(offset, valueAt(band, x, y), littleEndian);
              offset += 4;
            }
          }
        }

        const file = new File([bytes], littleEndian ? "little.dat" : "big.dat");
        const meta = {
          samples,
          lines,
          bands,
          headerOffset,
          interleave: "bsq",
          dataType: 4,
          littleEndian,
          dataTypeInfo: { bytes: 4 }
        };
        const source = createFmapDataSource(file, meta, {
          pageSize: 4096,
          poolBytes: 8192,
          maxQueuedRequests: 8,
          maxQueuedBytes: 2 * 1024 * 1024,
          maxInflightBytes: 1024 * 1024,
          maxResultBytes: 1024 * 1024,
          batchBytes: 4096,
          sparseReadThresholdBytes: 0,
          wasmBytes
        });
        try {
          await source.ready;
          const headerCrossing = await source.readBandWindow(meta, 0, 0, 0, 3, 1, 1);
          const window = Array.from(await source.readBandWindow(
            meta, 1, 1, 1, 3, 2, 2, null,
            { priority: "foreground", supersedeKey: `viewport-${littleEndian}` }
          ));
          const spectrum = Array.from(await source.readSpectrumAtPixel(
            meta, 6, 4, { priority: "foreground" }
          ));
          const stats = await source.getStats();
          return {
            headerCrossing: [
              Number.isNaN(headerCrossing[0]),
              headerCrossing[1] === Number.POSITIVE_INFINITY,
              headerCrossing[2] === Number.NEGATIVE_INFINITY
            ],
            window,
            spectrum,
            stats,
            residentBytes: source.cacheBytes()
          };
        } finally {
          source.close();
        }
      };

      let eofError = null;
      try {
        const meta = {
          samples,
          lines,
          bands,
          headerOffset,
          interleave: "bsq",
          dataType: 4,
          littleEndian: true,
          dataTypeInfo: { bytes: 4 }
        };
        createFmapDataSource(
          new File([new Uint8Array(headerOffset + (samples * lines * bands * 4) - 1)], "short.dat"),
          meta,
          { pageSize: 4096, poolBytes: 8192, wasmBytes }
        );
      } catch (error) {
        eofError = String(error?.message || error);
      }

      return { little: await run(true), big: await run(false), eofError };
    });

    const expectedWindow = [1101.25, 1103.25, 1105.25, 1301.25, 1303.25, 1305.25];
    const expectedSpectrum = [406.25, 1406.25, 2406.25];
    for (const endian of [result.little, result.big]) {
      expect(endian.headerCrossing).toEqual([true, true, true]);
      expect(endian.window).toEqual(expectedWindow);
      expect(endian.spectrum).toEqual(expectedSpectrum);
      expect(endian.stats.browserBytes).toBeGreaterThan(0);
      expect(endian.stats.copiedBytes).toBeGreaterThanOrEqual(endian.stats.browserBytes);
      expect(endian.residentBytes).toBe(8192);
    }
    expect(result.eofError).toBe("Truncated ENVI data: expected at least 4513 bytes, found 4512.");
  });

  test("ENVI loader preserves every supported type, layout, and endian path", async ({ page }) => {
    await page.goto("/");

    const results = await page.evaluate(async () => {
      const { addDatasetFromFiles } = await import("/src/io/envi-loader.js");
      const { readBandWindow, readBandWindowBIP } = await import("/src/core/raster-io.js");
      const { readSpectrumAtPixel } = await import("/src/render/spectrum-data.js");
      const wasmBytes = await (await fetch("/wasm/fmap/pkg/fmap_core.wasm")).arrayBuffer();
      const samples = 4;
      const lines = 3;
      const bands = 3;
      const headerOffset = 3;
      const types = [
        { dataType: 1, bytes: 1, setter: "setUint8" },
        { dataType: 2, bytes: 2, setter: "setInt16" },
        { dataType: 3, bytes: 4, setter: "setInt32" },
        { dataType: 4, bytes: 4, setter: "setFloat32", fractional: true },
        { dataType: 5, bytes: 8, setter: "setFloat64", fractional: true },
        { dataType: 12, bytes: 2, setter: "setUint16" },
        { dataType: 13, bytes: 4, setter: "setUint32" },
        { dataType: 14, bytes: 8, setter: "setBigInt64", bigint: true },
        { dataType: 15, bytes: 8, setter: "setBigUint64", bigint: true }
      ];
      const cases = types.flatMap((type) => ["bsq", "bil", "bip"].flatMap((interleave) => (
        [true, false].map((littleEndian) => ({ ...type, interleave, littleEndian }))
      )));
      const valueAt = (item, band, x, y) => (
        (band * 100) + (y * 10) + x + (item.fractional ? 0.25 : 0)
      );

      const encode = (item) => {
        const { interleave, bytes, setter, littleEndian, bigint } = item;
        const output = new ArrayBuffer(samples * lines * bands * bytes);
        const view = new DataView(output);
        let index = 0;
        const write = (value) => {
          const encoded = bigint ? BigInt(value) : value;
          if (bytes === 1) view[setter](index * bytes, encoded);
          else view[setter](index * bytes, encoded, littleEndian);
          index += 1;
        };
        if (interleave === "bsq") {
          for (let band = 0; band < bands; band += 1) {
            for (let y = 0; y < lines; y += 1) for (let x = 0; x < samples; x += 1) write(valueAt(item, band, x, y));
          }
        } else if (interleave === "bil") {
          for (let y = 0; y < lines; y += 1) {
            for (let band = 0; band < bands; band += 1) for (let x = 0; x < samples; x += 1) write(valueAt(item, band, x, y));
          }
        } else {
          for (let y = 0; y < lines; y += 1) {
            for (let x = 0; x < samples; x += 1) for (let band = 0; band < bands; band += 1) write(valueAt(item, band, x, y));
          }
        }
        return output;
      };

      let fmapCases = 0;
      let fallbackCases = 0;
      for (const item of cases) {
        const suffix = `${item.interleave}-${item.dataType}-${item.littleEndian ? "le" : "be"}`;
        const header = `ENVI\nsamples = ${samples}\nlines = ${lines}\nbands = ${bands}\nheader offset = ${headerOffset}\ninterleave = ${item.interleave}\ndata type = ${item.dataType}\nbyte order = ${item.littleEndian ? 0 : 1}\n`;
        const descriptor = await addDatasetFromFiles(
          new File([header], `${suffix}.hdr`, { type: "text/plain" }),
          new File([new Uint8Array(headerOffset), encode(item)], `${suffix}.dat`),
          {
            fmapEnabled: true,
            fmapWasmBytes: wasmBytes,
            fmapOptions: { pageSizeBytes: 4096, poolBytes: 8192, maxInflightRequests: 1 },
            createDataset: (value) => value
          }
        );
        try {
          const reader = item.interleave === "bip" ? readBandWindowBIP : readBandWindow;
          const values = await reader(descriptor.meta, descriptor.cached, 2, 1, 0, 2, 2, 1, 2);
          const actual = Array.from(values, Number);
          const expected = [
            valueAt(item, 2, 1, 0), valueAt(item, 2, 2, 0),
            valueAt(item, 2, 1, 1), valueAt(item, 2, 2, 1)
          ];
          if (actual.some((value, index) => value !== expected[index])) {
            throw new Error(`${suffix} parity mismatch: ${actual.join(",")}`);
          }
          const spectrum = await readSpectrumAtPixel({ meta: descriptor.meta, ds: descriptor.cached }, 3, 2);
          for (let band = 0; band < bands; band += 1) {
            if (spectrum[band] !== Math.fround(valueAt(item, band, 3, 2))) throw new Error(`${suffix} spectrum mismatch`);
          }
          const edge = await reader(descriptor.meta, descriptor.cached, 1, 3, 2, 3, 2, 2, 2);
          if (edge[0] !== valueAt(item, 1, 3, 2) || Array.from(edge).slice(1).some((value) => value !== 0)) {
            throw new Error(`${suffix} clipped window mismatch`);
          }
          const usesFmap = descriptor.cached.constructor.name === "FmapDataSource";
          if (!usesFmap) throw new Error(`${suffix} did not use fmap`);
          if (usesFmap) fmapCases += 1;
          else fallbackCases += 1;
        } finally {
          descriptor.cached.close();
        }
      }
      return { total: cases.length, fmapCases, fallbackCases };
    });

    expect(results).toEqual({ total: 54, fmapCases: 54, fallbackCases: 0 });
  });

  test("numeric windows preserve Float64 and integer precision while spectra keep Float32 semantics", async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(async () => {
      const { createFmapDataSource } = await import("/src/io/fmap/index.js");
      const { DATA_TYPES } = await import("/src/core/envi-types.js");
      const wasmBytes = await (await fetch("/wasm/fmap/pkg/fmap_core.wasm")).arrayBuffer();
      const cases = [
        { type: 5, setter: "setFloat64", values: [(2 ** 40) + 0.125, Math.PI, 1 + (2 ** -40), -0, Infinity, NaN] },
        { type: 3, setter: "setInt32", values: [-2147483648, 16777217, 2147483647] },
        { type: 13, setter: "setUint32", values: [4294967295, 16777217, 0] },
        { type: 14, setter: "setBigInt64", values: [-9007199254740993n, -(1n << 63n), 9007199254740993n, (1n << 63n) - 1n] },
        { type: 15, setter: "setBigUint64", values: [9007199254740993n, (1n << 64n) - 1n, 0n] }
      ];
      let checked = 0;
      for (const item of cases) for (const littleEndian of [true, false]) {
        const info = DATA_TYPES.get(item.type);
        const bytes = new Uint8Array(4095 + item.values.length * info.bytes);
        const view = new DataView(bytes.buffer);
        item.values.forEach((value, index) => view[item.setter](4095 + index * info.bytes, value, littleEndian));
        const meta = { samples: item.values.length, lines: 1, bands: 1, headerOffset: 4095,
          interleave: "bsq", dataType: item.type, dataTypeInfo: info, littleEndian };
        const source = createFmapDataSource(new File([bytes], `precision-${item.type}.dat`), meta,
          { pageSize: 4096, poolBytes: 8192, maxResultBytes: 24, wasmBytes });
        try {
          const values = await source.readBandWindow(meta, 0, 0, 0, item.values.length, 1, 1);
          const Ctor = info.ctor || Float64Array;
          if (!(values instanceof Ctor)) throw new Error(`Wrong output type for ${item.type}`);
          for (let index = 0; index < values.length; index += 1) {
            const expected = Number(item.values[index]);
            if (!Object.is(values[index], expected)) throw new Error(`Precision mismatch for ${item.type}:${index}`);
            const spectrum = await source.readSpectrumAtPixel(meta, index, 0);
            if (!(spectrum instanceof Float32Array) || !Object.is(spectrum[0], Math.fround(expected))) {
              throw new Error(`Spectrum conversion mismatch for ${item.type}:${index}`);
            }
            checked += 1;
          }
        } finally { source.close(); }
      }
      return checked;
    });
    expect(result).toBe(38);
  });

  test("large ENVI windows are assembled from bounded requests and cancel between chunks", async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(async () => {
      const { createFmapDataSource } = await import("/src/io/fmap/index.js");
      const { DATA_TYPES } = await import("/src/core/envi-types.js");
      const wasmBytes = await (await fetch("/wasm/fmap/pkg/fmap_core.wasm")).arrayBuffer();
      const samples = 1300, lines = 1100;
      const input = new Float32Array(samples * lines);
      for (let index = 0; index < input.length; index += 1) input[index] = (index % 8191) + 0.25;
      const meta = { samples, lines, bands: 1, headerOffset: 0, interleave: "bsq", dataType: 4,
        dataTypeInfo: DATA_TYPES.get(4), littleEndian: true };
      const source = createFmapDataSource(new File([input], "large-window.dat"), meta, {
        wasmBytes, pageSize: 65536, poolBytes: 131072, maxResultBytes: 32768,
        maxInflightBytes: 131072, maxQueuedRequests: 4
      });
      try {
        await source.ready;
        const before = await source.getStats();
        if (before.browserBytes !== 0) throw new Error("Opening read the input eagerly");
        const output = await source.readBandWindow(meta, 0, 0, 0, samples, lines, 1);
        for (let index = 0; index < input.length; index += 1) {
          if (output[index] !== input[index]) throw new Error(`Large window mismatch at ${index}`);
        }
        const controller = new AbortController();
        const pending = source.readBandWindow(meta, 0, 0, 0, samples, lines, 1, null, { signal: controller.signal });
        const outcome = pending.then(() => "resolved", (error) => error.name);
        await new Promise((resolve) => setTimeout(resolve, 10));
        controller.abort();
        const cancelled = await outcome;
        const probe = await source.readBandWindow(meta, 0, 1299, 1099, 1, 1, 1);
        const stats = await source.getStats();
        return { bytes: output.byteLength, cancelled, last: probe[0], expectedLast: input.at(-1),
          peakInflight: stats.peakInflightBytes, resident: source.cacheBytes() };
      } finally { source.close(); }
    });
    expect(result.bytes).toBeGreaterThan(4 * 1024 * 1024);
    expect(result.cancelled).toBe("AbortError");
    expect(result.last).toBe(result.expectedLast);
    expect(result.peakInflight).toBeLessThanOrEqual(131072);
    expect(result.resident).toBe(131072);
  });

  test("TIFF loading uses its fmap block path when requested", async ({ page }) => {
    await page.goto("/");

    const result = await page.evaluate(async () => {
      const { addDatasetsFromFileList } = await import("/src/io/dataset-loader.js");
      const { readBandWindowBIP } = await import("/src/core/raster-io.js");
      const pixels = new Uint8Array([
        255, 0, 0, 0, 255, 0,
        10, 20, 30, 40, 50, 60
      ]);
      const encodeRgbTiff = () => {
        const entries = [
          [256, 4, 1, 2], [257, 4, 1, 2], [258, 3, 3, 0],
          [259, 3, 1, 1], [262, 3, 1, 2], [273, 4, 2, 0],
          [277, 3, 1, 3], [278, 4, 1, 1], [279, 4, 2, 0],
          [284, 3, 1, 1]
        ];
        const ifdOffset = 8;
        const ifdBytes = 2 + (entries.length * 12) + 4;
        const bitsOffset = ifdOffset + ifdBytes;
        const stripOffsetsOffset = bitsOffset + 6;
        const stripByteCountsOffset = stripOffsetsOffset + 8;
        const pixelOffset = stripByteCountsOffset + 8;
        const buffer = new ArrayBuffer(pixelOffset + pixels.byteLength);
        const view = new DataView(buffer);
        view.setUint8(0, 0x49);
        view.setUint8(1, 0x49);
        view.setUint16(2, 42, true);
        view.setUint32(4, ifdOffset, true);
        view.setUint16(ifdOffset, entries.length, true);
        let offset = ifdOffset + 2;
        for (const [tag, type, count, originalValue] of entries) {
          let value = originalValue;
          if (tag === 258) value = bitsOffset;
          if (tag === 273) value = stripOffsetsOffset;
          if (tag === 279) value = stripByteCountsOffset;
          view.setUint16(offset, tag, true);
          view.setUint16(offset + 2, type, true);
          view.setUint32(offset + 4, count, true);
          view.setUint32(offset + 8, value, true);
          offset += 12;
        }
        view.setUint32(offset, 0, true);
        view.setUint16(bitsOffset, 8, true);
        view.setUint16(bitsOffset + 2, 8, true);
        view.setUint16(bitsOffset + 4, 8, true);
        view.setUint32(stripOffsetsOffset, pixelOffset, true);
        view.setUint32(stripOffsetsOffset + 4, pixelOffset + 6, true);
        view.setUint32(stripByteCountsOffset, 6, true);
        view.setUint32(stripByteCountsOffset + 4, 6, true);
        new Uint8Array(buffer, pixelOffset).set(pixels);
        return new Blob([buffer], { type: "image/tiff" });
      };
      const loaded = await addDatasetsFromFileList(
        [new File([encodeRgbTiff()], "fmap-regression.tiff", { type: "image/tiff" })],
        {
          fmapEnabled: true,
          createDataset: ({ meta: datasetMeta, cached, base }) => ({ meta: datasetMeta, ds: cached, base })
        }
      );
      const dataset = loaded.datasets[0];
      try {
        return {
          directFound: loaded.directFound,
          sourceFormat: dataset.meta.sourceFormat,
          sourceClass: dataset.ds.constructor.name,
          isFmap: (await dataset.ds.getStats()).isFmap,
          red: Array.from(await readBandWindowBIP(dataset.meta, dataset.ds, 0, 0, 0, 2, 2, 1, 2))
        };
      } finally {
        dataset.ds.close();
      }
    });

    expect(result.directFound).toBe(1);
    expect(result.sourceFormat).toBe("tiff");
    expect(result.sourceClass.toLowerCase()).toContain("tiff");
    expect(result.isFmap).toBe(true);
    expect(result.red).toEqual([255, 0, 10, 40]);
  });

  test("AbortSignal and supersedeKey cancel stale browser work without poisoning the source", async ({ page }) => {
    await page.goto("/");

    const result = await page.evaluate(async () => {
      const { createFmapDataSource } = await import("/src/io/fmap/index.js");
      const wasmBytes = await (await fetch("/wasm/fmap/pkg/fmap_core.wasm")).arrayBuffer();
      const samples = 1024;
      const lines = 1024;
      const meta = {
        samples,
        lines,
        bands: 1,
        headerOffset: 0,
        interleave: "bsq",
        dataType: 4,
        littleEndian: true,
        dataTypeInfo: { bytes: 4 }
      };
      const values = new Float32Array(samples * lines);
      values.fill(7.25);
      const source = createFmapDataSource(new File([values], "cancel.dat"), meta, {
        pageSize: 64 * 1024,
        poolBytes: 256 * 1024,
        maxQueuedRequests: 4,
        maxQueuedBytes: 8 * 1024 * 1024,
        maxInflightBytes: 8 * 1024 * 1024,
        maxResultBytes: 4 * 1024 * 1024,
        batchBytes: 64 * 1024,
        wasmBytes
      });
      const rejectedName = async (promise) => {
        try {
          await promise;
          return "resolved";
        } catch (error) {
          return String(error?.name || "Error");
        }
      };
      try {
        await source.ready;
        const preAborted = new AbortController();
        preAborted.abort();
        const aborted = await rejectedName(source.readBandWindow(
          meta, 0, 0, 0, 16, 16, 1, null, { signal: preAborted.signal }
        ));

        const stale = source.readBandWindow(
          meta, 0, 0, 0, 1024, 1024, 1, null,
          { priority: "background", supersedeKey: "viewport" }
        );
        const newest = source.readBandWindow(
          meta, 0, 12, 34, 1, 1, 1, null,
          { priority: "foreground", supersedeKey: "viewport" }
        );
        const [superseded, newestValue] = await Promise.all([
          rejectedName(stale),
          newest.then((output) => output[0])
        ]);

        const beforeActive = await source.getStats();
        const activeController = new AbortController();
        const active = source.readBandWindow(
          meta, 0, 0, 0, 1024, 1024, 1, null,
          { priority: "background", signal: activeController.signal }
        );
        let observedBatch = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          const progress = await source.getStats();
          if (progress.batches > beforeActive.batches) {
            observedBatch = true;
            break;
          }
        }
        activeController.abort();
        const activeCancelled = await rejectedName(active);
        const afterActive = await source.getStats();
        const probe = await source.readBandWindow(meta, 0, 91, 17, 1, 1, 1);
        const stats = await source.getStats();
        return {
          aborted,
          superseded,
          newestValue,
          observedBatch,
          activeCancelled,
          activeBrowserBytes: afterActive.browserBytes - beforeActive.browserBytes,
          workerCancellations: afterActive.workerCancelledRequests - beforeActive.workerCancelledRequests,
          probeValue: probe[0],
          stats
        };
      } finally {
        source.close();
      }
    });

    expect(result.aborted).toBe("AbortError");
    expect(result.superseded).toBe("AbortError");
    expect(result.newestValue).toBe(7.25);
    expect(result.observedBatch).toBe(true);
    expect(result.activeCancelled).toBe("AbortError");
    expect(result.activeBrowserBytes).toBeGreaterThan(0);
    expect(result.activeBrowserBytes).toBeLessThan(1024 * 1024 * 4);
    expect(result.workerCancellations).toBeGreaterThan(0);
    expect(result.probeValue).toBe(7.25);
    expect(result.stats.cancelledRequests).toBeGreaterThanOrEqual(2);
    expect(result.stats.queuedRequests).toBe(0);
    expect(result.stats.activeRequests).toBe(0);
  });
});
