import { describe, expect, test } from "vitest";
import { createHudController } from "../../src/render/hud.js";

describe("hud controller", () => {
  test("updateHud shows placeholders when no active dataset", () => {
    const els = {
      hudPos: { textContent: "", innerHTML: "", title: "" }
    };
    const hud = createHudController({
      els,
      state: { mouse: { x: 0, y: 0 } },
      getActive: () => null,
      screenToImage: () => ({ x: 0, y: 0 })
    });
    hud.updateHud();
    expect(els.hudPos.innerHTML).toContain("—");
    expect(els.hudPos.innerHTML).toContain("&nu;");
  });

  test("updateHud formats x y and nu with one decimal", () => {
    const els = {
      hudPos: { textContent: "", innerHTML: "", title: "" }
    };
    const ds = {
      activeBand: 2,
      meta: { scale: null, wavelengths: [500, 501.234, 612.987], wlUnits: "nm" }
    };
    const hud = createHudController({
      els,
      state: { mouse: { x: 1, y: 2 } },
      getActive: () => ds,
      screenToImage: () => ({ x: 10, y: 20 })
    });

    hud.updateHud();
    expect(els.hudPos.innerHTML).toContain("x</b>:");
    expect(els.hudPos.innerHTML).toContain("y</b>:");
    expect(els.hudPos.innerHTML).toContain("&nu;</b>:");
    expect(els.hudPos.innerHTML).toContain("613.0 nm");
  });
});
