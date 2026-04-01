import { afterEach, describe, expect, test } from "vitest";
import { resolveTiffCacheBudgets } from "../../src/io/tiff/shared.js";
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
