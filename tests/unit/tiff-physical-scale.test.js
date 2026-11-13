import { describe, expect, test } from "vitest";
import { tiffPhysicalScale } from "../../src/io/tiff/physical-scale.js";

describe("TIFF physical calibration", () => {
  test.each([
    [{ ResolutionUnit: 3, XResolution: 20000, YResolution: 10000 }, 0.5, 1],
    [{ ResolutionUnit: 2, XResolution: [50800, 1], YResolution: new Uint32Array([25400, 1]) }, 0.5, 1]
  ])("reads scalar and rational resolutions", (directory, x, y) => {
    expect(tiffPhysicalScale(directory)).toEqual({ umPerPixelX: x, umPerPixelY: y, source: "TIFF resolution" });
  });
  test.each([{}, { ResolutionUnit: 1, XResolution: 1, YResolution: 1 },
    { ResolutionUnit: 3, XResolution: 0, YResolution: 1 },
    { ResolutionUnit: 3, XResolution: [1, 0], YResolution: 1 },
    { ResolutionUnit: 3, XResolution: 1 }])("omits absent or invalid calibration", directory => {
    expect(tiffPhysicalScale(directory)).toBeNull();
  });
});
