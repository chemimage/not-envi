import { describe, expect, test } from "vitest";
import {
  THREE_BAND_ADJUST_BLUE,
  THREE_BAND_ADJUST_GREEN,
  THREE_BAND_ADJUST_RED,
  THREE_BAND_DISPLAY_MODE_BGR,
  THREE_BAND_DISPLAY_MODE_GRAY,
  THREE_BAND_DISPLAY_MODE_RGB,
  cycleThreeBandAdjustColor,
  cycleThreeBandDisplayMode,
  getThreeBandDisplayMode,
  resolveThreeBandAdjustBand,
  isThreeBandColorMode,
  isThreeBandDataset,
  resolveThreeBandColorBandMap,
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

  test("maps adjustment colors to displayed channel bands", () => {
    const ds = { meta: { bands: 3 }, displayMode: THREE_BAND_DISPLAY_MODE_BGR, displayAdjustColor: THREE_BAND_ADJUST_RED, activeBand: 1 };
    expect(cycleThreeBandAdjustColor(THREE_BAND_ADJUST_RED)).toBe(THREE_BAND_ADJUST_GREEN);
    expect(cycleThreeBandAdjustColor(THREE_BAND_ADJUST_GREEN)).toBe(THREE_BAND_ADJUST_BLUE);
    expect(resolveThreeBandColorBandMap(ds)).toEqual({
      [THREE_BAND_ADJUST_RED]: 2,
      [THREE_BAND_ADJUST_GREEN]: 1,
      [THREE_BAND_ADJUST_BLUE]: 0
    });
    expect(resolveThreeBandAdjustBand(ds)).toBe(2);
  });
});
