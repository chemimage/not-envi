import { afterEach, describe, expect, test } from "vitest";
import { APP_CONFIG, detectHardwareCores, resolveHardwareConcurrencyLimit } from "../../src/app/config.js";

const originalHardwareConcurrency = navigator.hardwareConcurrency;

afterEach(() => {
  Object.defineProperty(navigator, "hardwareConcurrency", {
    configurable: true,
    value: originalHardwareConcurrency
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
    })).toBe(6);
  });
});
