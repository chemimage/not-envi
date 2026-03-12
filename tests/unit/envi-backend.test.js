import { describe, expect, test } from "vitest";
import { buildEnviHeaderText, encodeEnviBandBytes } from "../../src/export/envi-backend.js";

describe("envi backend", () => {
  test("buildEnviHeaderText includes core ENVI fields", () => {
    const text = buildEnviHeaderText({
      meta: {
        dataType: 4,
        wlUnits: "cm-1",
        bandNames: ["b1", "b2"],
        wavelengths: [1000, 1010]
      },
      width: 32,
      height: 16,
      bands: 2,
      interleave: "bsq",
      littleEndian: true,
      dataFileName: "sample.dat"
    });
    expect(text).toContain("ENVI");
    expect(text).toContain("samples = 32");
    expect(text).toContain("lines = 16");
    expect(text).toContain("bands = 2");
    expect(text).toContain("data type = 4");
    expect(text).toContain("interleave = bsq");
    expect(text).toContain("byte order = 0");
    expect(text).toContain("data file = sample.dat");
    expect(text).toContain("wavelength units = cm-1");
  });

  test("encodeEnviBandBytes writes little-endian int16", () => {
    const bytes = encodeEnviBandBytes(
      { dataType: 2, dataTypeInfo: { bytes: 2 } },
      new Int16Array([0x1234, -2]),
      true
    );
    expect(Array.from(bytes)).toEqual([0x34, 0x12, 0xfe, 0xff]);
  });
});

