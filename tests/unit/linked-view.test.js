import { describe, expect, test } from "vitest";
import { linkedDatasetsShareDisplaySize, scaleViewAboutCurrentCenter } from "../../src/app/linked-view.js";

describe("linked-view", () => {
  test("reports mixed-size linked datasets as incompatible for cursor-anchor sync", () => {
    const same = [
      { dataset: { meta: { samples: 100, lines: 80 } } },
      { dataset: { meta: { samples: 100, lines: 80 } } }
    ];
    const mixed = [
      { dataset: { meta: { samples: 100, lines: 80 } } },
      { dataset: { meta: { samples: 200, lines: 80 } } }
    ];

    expect(linkedDatasetsShareDisplaySize(same)).toBe(true);
    expect(linkedDatasetsShareDisplaySize(mixed)).toBe(false);
  });

  test("scales a view around its current center", () => {
    const next = scaleViewAboutCurrentCenter(
      { x: 10, y: 20, scale: 2 },
      { w: 200, h: 100 },
      4,
      1
    );

    expect(next.scale).toBe(4);
    expect(next.x).toBe(35);
    expect(next.y).toBe(32.5);
  });
});
