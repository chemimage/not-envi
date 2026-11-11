import { describe, expect, test } from "vitest";
import { addDatasetsFromFileList, supportsFmap, validateEnviPayload } from "../../src/io/envi-loader.js";
import { readBandWindow } from "../../src/core/raster-io.js";

const HDR_TEXT = `ENVI
samples = 2
lines = 2
bands = 1
interleave = 0
data type = 4
byte order = 0
`;

describe("envi loader", () => {
  test("validates exact payload length and rejects truncated or unsafe declarations", () => {
    const meta = {
      samples: 2,
      lines: 2,
      bands: 1,
      headerOffset: 8,
      dataTypeInfo: { bytes: 4 }
    };
    expect(validateEnviPayload(meta, 24)).toBe(24);
    expect(() => validateEnviPayload(meta, 23)).toThrow(/truncated/i);
    expect(() => validateEnviPayload({ ...meta, samples: Number.MAX_SAFE_INTEGER }, Number.MAX_SAFE_INTEGER))
      .toThrow(/exact file-offset range/i);
  });

  test("pairs files, reports missing data, and loads a readable ENVI dataset", async () => {
    const hdr = new File([HDR_TEXT], "demo.hdr", { type: "text/plain" });
    const data = new File([new Float32Array([1, 2, 3, 4])], "demo.dat");

    const orphanHdr = new File([HDR_TEXT], "orphan.hdr", { type: "text/plain" });
    const result = await addDatasetsFromFileList([hdr, data, orphanHdr], {
      ioConcurrency: 2,
      createDataset: ({ meta, cached, base, hdrFile, dataFile }) => ({
        meta,
        ds: cached,
        baseDs: base,
        id: "ds1",
        hdrName: hdrFile.name,
        dataName: dataFile.name
      })
    });

    expect(result.headersFound).toBe(2);
    expect(result.datasets).toHaveLength(1);
    expect(result.missing).toEqual(["orphan.hdr"]);
    const [ds] = result.datasets;
    expect(ds.meta.interleave).toBe("bsq");
    expect(ds.meta.samples).toBe(2);
    const pixels = await readBandWindow(ds.meta, ds.ds, 0, 0, 0, 2, 2, 1);
    expect(Array.from(pixels)).toEqual([1, 2, 3, 4]);
    ds.ds.close();
    expect(ds.hdrName).toBe("demo.hdr");
    expect(ds.dataName).toBe("demo.dat");
  });

  test("selects fmap only for the opt-in BSQ Float32 slice", async () => {
    const hdr = new File([HDR_TEXT], "large.hdr", { type: "text/plain" });
    const data = new File([new Float32Array([1, 2, 3, 4])], "large.dat");
    const fmapSource = {
      ready: Promise.resolve(),
      close() {},
      readBandWindow: async () => new Float32Array([1, 2, 3, 4])
    };
    let received = null;
    const result = await addDatasetsFromFileList([hdr, data], {
      fmapEnabled: true,
      fmapWasmBytes: new ArrayBuffer(8),
      fmapOptions: { pageSizeBytes: 4096, poolBytes: 8192, maxInflightRequests: 1 },
      createFmapDataSource(file, meta, options) {
        received = { file, meta, options };
        return fmapSource;
      },
      createDataset: (descriptor) => descriptor
    });

    expect(result.datasets[0].cached).toBe(fmapSource);
    expect(result.datasets[0].base).toBeNull();
    expect(received.file).toBe(data);
    expect(received.options.pageSize).toBe(4096);
    expect(supportsFmap(received.meta)).toBe(true);
    expect(supportsFmap({ ...received.meta, interleave: "bil" })).toBe(false);
  });
});
