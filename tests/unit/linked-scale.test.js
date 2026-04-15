import { describe, expect, test } from "vitest";
import {
  clampLinkedSourceScale,
  resolveLinkedSourceMinScale,
  resolveSourceScaleForLinkedEntry
} from "../../src/app/linked-scale.js";

describe("linked scale", () => {
  test("converts a target panel minimum scale into the source panel scale space", () => {
    const required = resolveSourceScaleForLinkedEntry(
      { samples: 1000, lines: 500 },
      { w: 1000, h: 500 },
      { samples: 2000, lines: 1000 },
      { w: 1000, h: 500 },
      0.5
    );

    expect(required).toBe(1);
  });

  test("uses the strongest linked lower bound in source scale space", () => {
    const sourceEntry = {
      panel: { slot: 1 },
      dataset: { id: "source", meta: { samples: 1000, lines: 500 } }
    };
    const entries = [
      sourceEntry,
      { panel: { slot: 2 }, dataset: { id: "target", meta: { samples: 2000, lines: 1000 } } }
    ];
    const minScaleFor = (ds) => (ds.id === "source" ? 1 : 0.5);
    const getViewport = () => ({ w: 1000, h: 500 });

    expect(resolveLinkedSourceMinScale(sourceEntry, entries, minScaleFor, getViewport)).toBe(1);
  });

  test("clamps linked zoom-out when another panel would hit its boundary first", () => {
    const sourceEntry = {
      panel: { slot: 1 },
      dataset: { id: "source", meta: { samples: 1000, lines: 500 } }
    };
    const entries = [
      sourceEntry,
      { panel: { slot: 2 }, dataset: { id: "target", meta: { samples: 2000, lines: 1000 } } }
    ];
    const minScaleFor = (ds) => (ds.id === "source" ? 1 : 0.5);
    const getViewport = () => ({ w: 1000, h: 500 });

    expect(clampLinkedSourceScale(0.8, sourceEntry, entries, minScaleFor, getViewport, 128)).toEqual({
      minScale: 1,
      scale: 1
    });
  });
});
