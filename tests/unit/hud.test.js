import { describe, expect, test, vi } from "vitest";
import { createHudController } from "../../src/render/hud.js";

describe("hud controller", () => {
  test("updateHud shows placeholders when no active dataset", () => {
    const els = {
      hudPos: { textContent: "", title: "" },
      hudVal: { textContent: "" }
    };
    const hud = createHudController({
      els,
      state: { mouse: { x: 0, y: 0 } },
      getActive: () => null,
      screenToImage: () => ({ x: 0, y: 0 }),
      bandLabel: () => "B0",
      probeValueAtBand: async () => 0
    });
    hud.updateHud();
    expect(els.hudPos.textContent).toContain("—");
    expect(els.hudVal.textContent).toContain("—");
  });

  test("updateHud schedules and formats probe value", async () => {
    vi.useFakeTimers();
    const els = {
      hudPos: { textContent: "", title: "" },
      hudVal: { textContent: "" }
    };
    const ds = {
      activeBand: 2,
      meta: { scale: null }
    };
    const hud = createHudController({
      els,
      state: { mouse: { x: 1, y: 2 } },
      getActive: () => ds,
      screenToImage: () => ({ x: 10, y: 20 }),
      bandLabel: (_ds, b) => `B${b}`,
      probeValueAtBand: async () => 12.3456
    });

    hud.updateHud();
    await vi.advanceTimersByTimeAsync(50);
    expect(els.hudPos.textContent).toContain("x:");
    expect(els.hudVal.textContent).toContain("B2:");
    vi.useRealTimers();
  });
});
