import { describe, expect, test } from "vitest";
import {
  annotationsShareImageSpace,
  remapAnnotationPoint,
  remapAnnotationState
} from "../../src/app/linked-annotations.js";

describe("linked annotations", () => {
  test("maps points by normalized image position", () => {
    const point = remapAnnotationPoint(
      { x: 63, y: 31 },
      { samples: 64, lines: 32 },
      { samples: 96, lines: 48 }
    );
    expect(point).toEqual({ x: 95, y: 47 });
  });

  test("remaps an annotation state and preserves selection ids", () => {
    const state = remapAnnotationState(
      {
        drawings: [{ id: 7, tool: "rect", points: [{ x: 0, y: 0 }, { x: 63, y: 31 }] }],
        selectedAreaId: 7
      },
      { samples: 64, lines: 32 },
      { samples: 96, lines: 48 }
    );
    expect(state.selectedAreaId).toBe(7);
    expect(state.drawings[0].points).toEqual([{ x: 0, y: 0 }, { x: 95, y: 47 }]);
  });

  test("detects when two datasets already share image space", () => {
    expect(annotationsShareImageSpace({ samples: 64, lines: 32 }, { samples: 64, lines: 32 })).toBe(true);
    expect(annotationsShareImageSpace({ samples: 64, lines: 32 }, { samples: 96, lines: 48 })).toBe(false);
  });
});
