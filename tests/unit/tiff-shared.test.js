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
  test("uses standard profile for MacBook Air class hardware", () => {
    setNavigatorValue("userAgent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    setNavigatorValue("platform", "MacIntel");
    setNavigatorValue("maxTouchPoints", 0);
    setNavigatorValue("hardwareConcurrency", 10);
    setNavigatorValue("deviceMemory", 16);

    const budgets = resolveTiffCacheBudgets({ ioConcurrency: 4 });

    expect(budgets.profileName).toBe("standard");
    expect(budgets.rawCacheBytes).toBe(APP_CONFIG.tiff.standardRawCacheBytes);
    expect(budgets.decodedCacheBytes).toBe(APP_CONFIG.tiff.standardDecodedCacheBytes);
  });

  test("uses lite profile for iPad Pro class hardware", () => {
    setNavigatorValue("userAgent", "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)");
    setNavigatorValue("platform", "MacIntel");
    setNavigatorValue("maxTouchPoints", 5);
    setNavigatorValue("hardwareConcurrency", 9);
    setNavigatorValue("deviceMemory", 12);

    const budgets = resolveTiffCacheBudgets({ ioConcurrency: 4 });

    expect(budgets.profileName).toBe("lite");
    expect(budgets.rawCacheBytes).toBe(APP_CONFIG.tiff.liteRawCacheBytes);
    expect(budgets.decodedCacheBytes).toBe(APP_CONFIG.tiff.liteDecodedCacheBytes);
  });

  test("uses lite profile for MacBook Neo class hardware", () => {
    setNavigatorValue("userAgent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    setNavigatorValue("platform", "MacIntel");
    setNavigatorValue("maxTouchPoints", 0);
    setNavigatorValue("hardwareConcurrency", 6);
    setNavigatorValue("deviceMemory", 8);

    const budgets = resolveTiffCacheBudgets({ ioConcurrency: 4 });

    expect(budgets.profileName).toBe("lite");
    expect(budgets.rawCacheBytes).toBe(APP_CONFIG.tiff.liteRawCacheBytes);
    expect(budgets.decodedCacheBytes).toBe(APP_CONFIG.tiff.liteDecodedCacheBytes);
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
