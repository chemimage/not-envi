import { describe, expect, test } from "vitest";
import { addDatasetsFromFileList } from "../../src/io/envi-loader.js";
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
});
