import { describe, expect, test } from "vitest";
import { normalizeMeta, parseEnviHeader, parseEnviValue } from "../../src/core/envi-parser.js";
import { parseUmPerPixelFromCustomFields, parseUmPerPixelFromMapInfo } from "../../src/core/scale-parser.js";

describe("ENVI parser", () => {
  test("parseEnviValue supports scalars and lists", () => {
    expect(parseEnviValue("123")).toBe(123);
    expect(parseEnviValue("{1, 2, 3}")).toEqual([1, 2, 3]);
    expect(parseEnviValue("\"abc\"")).toBe("abc");
  });

  test("parses multiline headers and normalizes dimensions, interleave, and data type", () => {
    const hdr = `
ENVI
samples = 4
lines = 3
bands = 2
interleave = bip
data type = 4
byte order = 0
wavelength = {0.45,
 0.55}
`;
    const parsed = parseEnviHeader(hdr);
    expect(parsed.samples).toBe(4);
    expect(parsed.lines).toBe(3);
    expect(parsed.bands).toBe(2);
    expect(parsed.wavelength).toEqual([0.45, 0.55]);
    const norm = normalizeMeta(parsed);
    expect(norm.samples).toBe(4);
    expect(norm.interleave).toBe("bip");
    expect(norm.dataTypeInfo.name).toBe("float32");
    expect(norm.littleEndian).toBe(true);
  });

  test("normalizeMeta accepts numeric/alias interleave forms", () => {
    const base = {
      samples: 8,
      lines: 8,
      bands: 2,
      "data type": 4,
      "byte order": 0
    };

    expect(normalizeMeta({ ...base, interleave: 0 }).interleave).toBe("bsq");
    expect(normalizeMeta({ ...base, interleave: 1 }).interleave).toBe("bil");
    expect(normalizeMeta({ ...base, interleave: 2 }).interleave).toBe("bip");
    expect(normalizeMeta({ ...base, interleave: "bsp" }).interleave).toBe("bip");
  });

  test("normalizeMeta rejects invalid dimensions", () => {
    expect(() => normalizeMeta({ samples: 0, lines: 1, bands: 1, "data type": 4 })).toThrow();
  });

  test("scale helpers parse map info and custom fields", () => {
    expect(parseUmPerPixelFromMapInfo(["UTM", 1, 1, 0, 0, 0.5, 0.25, "units=Micrometers"])).toEqual({
      umPerPixelX: 0.5,
      umPerPixelY: 0.25,
      source: "map info"
    });

    expect(parseUmPerPixelFromCustomFields({ "pixel size": [2, 3], "pixel size units": "um" })).toEqual({
      umPerPixelX: 2,
      umPerPixelY: 3,
      source: "header:pixel size"
    });

    expect(parseUmPerPixelFromCustomFields({ "pixel size": [0.000002, 0.000003] })).toEqual({
      umPerPixelX: 2,
      umPerPixelY: 3,
      source: "header:pixel size"
    });
  });

  test("normalizeMeta restores braces for settings-like description", () => {
    const norm = normalizeMeta({
      samples: 4,
      lines: 4,
      bands: 2,
      interleave: "bsq",
      "data type": 4,
      description: ["\"laserPower\":45", "\"scan_mode\":\"fast\""]
    });
    expect(norm.desc).toBe("{\"laserPower\":45, \"scan_mode\":\"fast\"}");
  });
});
