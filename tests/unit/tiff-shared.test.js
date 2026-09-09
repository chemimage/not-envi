import { afterEach, describe, expect, test, vi } from "vitest";
import { loadImageSummaries, readDataViewValue, resolveTiffCacheBudgets } from "../../src/io/tiff/shared.js";
import { APP_CONFIG } from "../../src/app/config.js";

const originalUserAgent = navigator.userAgent;
const originalPlatform = navigator.platform;
const originalMaxTouchPoints = navigator.maxTouchPoints;
const originalHardwareConcurrency = navigator.hardwareConcurrency;
const originalDeviceMemory = navigator.deviceMemory;

function setNavigatorValue(name, value) {
  Object.defineProperty(navigator, name, {
    configurable: true,
    value
  });
}

afterEach(() => {
  setNavigatorValue("userAgent", originalUserAgent);
  setNavigatorValue("platform", originalPlatform);
  setNavigatorValue("maxTouchPoints", originalMaxTouchPoints);
  setNavigatorValue("hardwareConcurrency", originalHardwareConcurrency);
  setNavigatorValue("deviceMemory", originalDeviceMemory);
});

function makeFakeImage() {
  return {
    getWidth: () => 2,
    getHeight: () => 1,
    getSamplesPerPixel: () => 1,
    getBitsPerSample: () => 8,
    getSampleFormat: () => 1,
    getFileDirectory: () => ({
      Compression: 1,
      RowsPerStrip: 1,
      StripOffsets: [0],
      StripByteCounts: [2],
      PhotometricInterpretation: 1
    })
  };
}

describe("resolveTiffCacheBudgets", () => {
  test.each([
    { device: "MacBook Air", platform: "Macintosh; Intel Mac OS X 10_15_7", touch: 0, cores: 10, memory: 16, profile: "standard" },
    { device: "iPad Pro", platform: "iPad; CPU OS 18_0 like Mac OS X", touch: 5, cores: 9, memory: 12, profile: "lite" },
    { device: "MacBook Neo", platform: "Macintosh; Intel Mac OS X 10_15_7", touch: 0, cores: 6, memory: 8, profile: "lite" }
  ])("uses the $profile cache profile for $device hardware", ({ platform, touch, cores, memory, profile }) => {
    setNavigatorValue("userAgent", `Mozilla/5.0 (${platform})`);
    setNavigatorValue("platform", "MacIntel");
    setNavigatorValue("maxTouchPoints", touch);
    setNavigatorValue("hardwareConcurrency", cores);
    setNavigatorValue("deviceMemory", memory);

    const budgets = resolveTiffCacheBudgets({ ioConcurrency: 4 });
    expect(budgets.profileName).toBe(profile);
    expect(budgets.rawCacheBytes).toBe(APP_CONFIG.tiff[`${profile}RawCacheBytes`]);
    expect(budgets.decodedCacheBytes).toBe(APP_CONFIG.tiff[`${profile}DecodedCacheBytes`]);
  });
});

describe("readDataViewValue", () => {
  test("returns NaN instead of throwing when the offset exceeds the DataView bounds", () => {
    const dv = new DataView(new ArrayBuffer(2));

    expect(readDataViewValue(dv, 2, { bytes: 1, dv: "getUint8" }, true)).toBeNaN();
    expect(readDataViewValue(dv, 1, { bytes: 2, dv: "getUint16" }, true)).toBeNaN();
  });
});

describe("loadImageSummaries", () => {
  test("uses geotiff image count when available instead of probing past the last image", async () => {
    const image = makeFakeImage();
    const tiff = {
      getImageCount: vi.fn(async () => 1),
      getImage: vi.fn(async (index) => {
        if (index !== 0) throw new Error(`unexpected image index ${index}`);
        return image;
      })
    };

    const summaries = await loadImageSummaries(tiff);

    expect(summaries).toHaveLength(1);
    expect(tiff.getImageCount).toHaveBeenCalledTimes(1);
    expect(tiff.getImage).toHaveBeenCalledTimes(1);
    expect(tiff.getImage).toHaveBeenCalledWith(0);
  });

  test("stops probing when geotiff throws a range error after the last readable image", async () => {
    const image = makeFakeImage();
    const tiff = {
      getImage: vi.fn(async (index) => {
        if (index === 0) return image;
        throw new RangeError("Offset is outside the bounds of the DataView");
      })
    };

    const summaries = await loadImageSummaries(tiff);

    expect(summaries).toHaveLength(1);
    expect(tiff.getImage).toHaveBeenCalledTimes(2);
  });
});
