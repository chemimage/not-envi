import { describe, expect, test } from "vitest";
import {
  THREE_BAND_DISPLAY_MODE_BGR,
  THREE_BAND_DISPLAY_MODE_GRAY,
  THREE_BAND_DISPLAY_MODE_RGB,
  cycleThreeBandDisplayMode,
  getThreeBandDisplayMode,
  isThreeBandColorMode,
  isThreeBandDataset,
  resolveThreeBandChannelOrder
} from "../../src/app/three-band-display.js";

describe("three-band display mode helpers", () => {
  test("cycles gray to rgb to bgr and back", () => {
    expect(cycleThreeBandDisplayMode(THREE_BAND_DISPLAY_MODE_GRAY)).toBe(THREE_BAND_DISPLAY_MODE_RGB);
    expect(cycleThreeBandDisplayMode(THREE_BAND_DISPLAY_MODE_RGB)).toBe(THREE_BAND_DISPLAY_MODE_BGR);
    expect(cycleThreeBandDisplayMode(THREE_BAND_DISPLAY_MODE_BGR)).toBe(THREE_BAND_DISPLAY_MODE_GRAY);
  });

  test("detects three-band color state and channel order", () => {
    const ds = { meta: { bands: 3 }, displayMode: THREE_BAND_DISPLAY_MODE_BGR };
    expect(isThreeBandDataset(ds)).toBe(true);
    expect(getThreeBandDisplayMode(ds)).toBe(THREE_BAND_DISPLAY_MODE_BGR);
    expect(isThreeBandColorMode(ds)).toBe(true);
    expect(resolveThreeBandChannelOrder(ds)).toEqual([2, 1, 0]);
  });
});
