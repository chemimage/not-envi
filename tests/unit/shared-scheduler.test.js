import { afterEach, describe, expect, test } from "vitest";
import {
  resetSharedSchedulerForTests,
  scheduleSharedTask
} from "../../src/core/shared-scheduler.js";

const originalHardwareConcurrency = navigator.hardwareConcurrency;

function setNavigatorValue(name, value) {
  Object.defineProperty(navigator, name, {
    configurable: true,
    value
  });
}

afterEach(() => {
  setNavigatorValue("hardwareConcurrency", originalHardwareConcurrency);
  resetSharedSchedulerForTests();
});

describe("shared scheduler", () => {
  test("shares concurrency fairly across owners", async () => {
    setNavigatorValue("hardwareConcurrency", 4);
    resetSharedSchedulerForTests();

    const started = [];
    let releaseA1 = null;
    let releaseB1 = null;

    const a1 = scheduleSharedTask("owner-a", () => new Promise((resolve) => {
      started.push("a1");
      releaseA1 = resolve;
    }));
    const a2 = scheduleSharedTask("owner-a", async () => {
      started.push("a2");
    });
    const b1 = scheduleSharedTask("owner-b", () => new Promise((resolve) => {
      started.push("b1");
      releaseB1 = resolve;
    }));

    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(started).toContain("a1");
    expect(started).toContain("b1");
    expect(started).not.toContain("a2");

    releaseA1?.();
    releaseB1?.();
    await Promise.all([a1, a2, b1]);

    expect(started.indexOf("b1")).toBeLessThan(started.indexOf("a2"));
  });
});
