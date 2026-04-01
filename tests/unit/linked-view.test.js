import { describe, expect, test } from "vitest";
import { applyNormalizedViewBox, captureNormalizedViewBox, withNormalizedCenter } from "../../src/app/linked-view.js";

describe("linked-view", () => {
  test("captures a normalized view box from the current view", () => {
    const box = captureNormalizedViewBox(
      { x: 25, y: 10, scale: 2 },
      { samples: 100, lines: 50 },
      { w: 200, h: 100 },
      1
    );

    expect(box).toEqual({
      centerX: 0.75,
      centerY: 0.7,
      widthFrac: 1,
      heightFrac: 1
    });
  });

  test("applies a normalized view box to a different image size", () => {
    const next = applyNormalizedViewBox(
      { centerX: 0.5, centerY: 0.5, widthFrac: 0.25, heightFrac: 0.25 },
      { samples: 200, lines: 100 },
      { w: 200, h: 100 },
      1,
      { minScale: 0.1, maxScale: 128 }
    );

    expect(next.scale).toBe(4);
    expect(next.x).toBe(75);
    expect(next.y).toBe(37.5);
  });

  test("updates only the normalized center while keeping the same normalized extents", () => {
    const next = withNormalizedCenter(
      { centerX: 0.5, centerY: 0.5, widthFrac: 0.2, heightFrac: 0.4 },
      0.25,
      0.75
    );

    expect(next).toEqual({
      centerX: 0.25,
      centerY: 0.75,
      widthFrac: 0.2,
      heightFrac: 0.4
    });
  });
});
