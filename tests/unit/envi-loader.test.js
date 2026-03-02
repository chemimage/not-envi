import { describe, expect, test } from "vitest";
import { addDatasetFromFiles, addDatasetsFromFileList } from "../../src/io/envi-loader.js";

const HDR_TEXT = `ENVI
samples = 2
lines = 2
bands = 1
interleave = 0
data type = 4
byte order = 0
`;

describe("envi loader", () => {
  test("addDatasetFromFiles parses header and creates dataset object via deps", async () => {
    const hdr = new File([HDR_TEXT], "demo.hdr", { type: "text/plain" });
    const data = new File([new Float32Array([1, 2, 3, 4])], "demo.dat");

    const ds = await addDatasetFromFiles(hdr, data, {
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

    expect(ds.meta.interleave).toBe("bsq");
    expect(ds.meta.samples).toBe(2);
    expect(typeof ds.ds.read).toBe("function");
    expect(ds.hdrName).toBe("demo.hdr");
    expect(ds.dataName).toBe("demo.dat");
  });

  test("addDatasetsFromFileList pairs hdr and data files", async () => {
    const hdr = new File([HDR_TEXT], "a.hdr", { type: "text/plain" });
    const dat = new File([new Uint8Array(16)], "a.dat");
    const orphanHdr = new File([HDR_TEXT], "b.hdr", { type: "text/plain" });

    const res = await addDatasetsFromFileList([hdr, dat, orphanHdr], {
      createDataset: ({ meta }) => ({ meta })
    });

    expect(res.headersFound).toBe(2);
    expect(res.datasets).toHaveLength(1);
    expect(res.missing).toEqual(["b.hdr"]);
  });
});
