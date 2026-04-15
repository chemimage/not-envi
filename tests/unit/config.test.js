import { afterEach, describe, expect, test } from "vitest";
import {
  APP_CONFIG,
  detectDeviceMemoryGiB,
  detectHardwareCores,
  resolveHardwareConcurrencyLimit,
  resolvePreviewOverviewLongEdge
} from "../../src/app/config.js";

const originalHardwareConcurrency = navigator.hardwareConcurrency;
const originalDeviceMemory = navigator.deviceMemory;

afterEach(() => {
  Object.defineProperty(navigator, "hardwareConcurrency", {
    configurable: true,
    value: originalHardwareConcurrency
  });
  Object.defineProperty(navigator, "deviceMemory", {
    configurable: true,
    value: originalDeviceMemory
  });
});

describe("config hardware concurrency", () => {
  test("detectHardwareCores reads navigator.hardwareConcurrency", () => {
    Object.defineProperty(navigator, "hardwareConcurrency", {
      configurable: true,
      value: 12
    });
    expect(detectHardwareCores()).toBe(12);
  });

  test("resolveHardwareConcurrencyLimit applies configurable fractions", () => {
    Object.defineProperty(navigator, "hardwareConcurrency", {
      configurable: true,
      value: 12
    });
    expect(resolveHardwareConcurrencyLimit({
      fraction: APP_CONFIG.io.hardwareCoreFraction,
      min: APP_CONFIG.io.hardwareParallelMin,
      max: APP_CONFIG.io.maxConcurrency
    })).toBe(9);
  });

  test("detectDeviceMemoryGiB reads navigator.deviceMemory", () => {
    Object.defineProperty(navigator, "deviceMemory", {
      configurable: true,
      value: 8
    });
    expect(detectDeviceMemoryGiB()).toBe(8);
  });

  test("resolvePreviewOverviewLongEdge keeps deferred size as the default", () => {
    Object.defineProperty(navigator, "hardwareConcurrency", {
      configurable: true,
      value: 10
    });
    Object.defineProperty(navigator, "deviceMemory", {
      configurable: true,
      value: 16
    });
    expect(resolvePreviewOverviewLongEdge()).toBe(APP_CONFIG.previewOverview.standardDeferredLongEdge);
    expect(resolvePreviewOverviewLongEdge({ deferred: false })).toBe(APP_CONFIG.previewOverview.standardInitialLongEdge);
    expect(resolvePreviewOverviewLongEdge({ deferred: false, bootstrap: true })).toBe(APP_CONFIG.previewOverview.standardBootstrapLongEdge);
  });

  test("resolvePreviewOverviewLongEdge uses lite initial/deferred sizes on lite hardware", () => {
    Object.defineProperty(navigator, "hardwareConcurrency", {
      configurable: true,
      value: 8
    });
    Object.defineProperty(navigator, "deviceMemory", {
      configurable: true,
      value: 8
    });
    expect(resolvePreviewOverviewLongEdge()).toBe(APP_CONFIG.previewOverview.liteDeferredLongEdge);
    expect(resolvePreviewOverviewLongEdge({ deferred: false })).toBe(APP_CONFIG.previewOverview.liteInitialLongEdge);
    expect(resolvePreviewOverviewLongEdge({ deferred: false, bootstrap: true })).toBe(APP_CONFIG.previewOverview.liteBootstrapLongEdge);
  });

  test("spectrum discrete bar threshold is configurable in app config", () => {
    expect(APP_CONFIG.spectrum.discreteBarMaxBands).toBe(20);
  });
});
