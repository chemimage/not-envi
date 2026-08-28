import { describe, expect, test } from "vitest";
import {
  buildBandDockEntries,
  closestBandForLinkedDataset,
  createBandDockController,
  pickBandAtFraction,
  representativeBandEntries
} from "../../src/app/band-dock.js";

describe("band dock", () => {
  test("sorts wavenumbers while preserving source band indices", () => {
    const ds = { meta: { bands: 3, wavelengths: [1500, 500, 1000] } };
    const entries = buildBandDockEntries(ds);

    expect(entries.map((entry) => entry.band)).toEqual([1, 2, 0]);
    expect(entries.map((entry) => entry.fraction)).toEqual([0, 0.5, 1]);
    expect(pickBandAtFraction(entries, 0.48)).toBe(2);
  });

  test("uses representative ticks but always retains selected and hovered bands", () => {
    const ds = { meta: { bands: 101, wavelengths: Array.from({ length: 101 }, (_unused, i) => i) } };
    const entries = buildBandDockEntries(ds);
    const visible = representativeBandEntries(entries, 12, [37, 63]);

    expect(visible[0].band).toBe(0);
    expect(visible.at(-1).band).toBe(100);
    expect(visible.some((entry) => entry.band === 37)).toBe(true);
    expect(visible.some((entry) => entry.band === 63)).toBe(true);
    expect(visible.length).toBeLessThanOrEqual(14);
  });

  test("matches a linked dataset to its nearest wavenumber", () => {
    const source = buildBandDockEntries({ meta: { bands: 3, wavelengths: [900, 1100, 1300] } })[1];
    const target = { meta: { bands: 4, wavelengths: [850, 1050, 1250, 1450] } };

    expect(closestBandForLinkedDataset(source, target, 1)).toBe(1);
  });

  test("falls back to source band index when spectral metadata is unavailable", () => {
    const source = buildBandDockEntries({ meta: { bands: 5 } })[3];
    const target = { meta: { bands: 2 } };

    expect(closestBandForLinkedDataset(source, target, 3)).toBe(1);
  });

  test("magnifies the hovered band and selects while dragging", () => {
    document.body.innerHTML = `
      <div id="dock"><div id="selector"><span id="min"></span><div id="track"></div><span id="max"></span><output id="value"></output><output id="preview"></output></div></div>
    `;
    const ds = { id: "one", activeBand: 0, meta: { bands: 3, wavelengths: [500, 1000, 1500] } };
    const selector = document.querySelector("#selector");
    const track = document.querySelector("#track");
    track.getBoundingClientRect = () => ({ left: 100, width: 200 });
    selector.getBoundingClientRect = () => ({ left: 50, width: 340 });
    const selected = [];
    const controller = createBandDockController({
      els: {
        bandDock: document.querySelector("#dock"),
        bandSelector: selector,
        bandDockTrack: track,
        bandDockMin: document.querySelector("#min"),
        bandDockMax: document.querySelector("#max"),
        bandDockValue: document.querySelector("#value"),
        bandDockPreview: document.querySelector("#preview")
      },
      getActive: () => ds,
      bandLabel: (_dataset, band) => String(band),
      onSelectBand: (_dataset, band) => selected.push(band)
    });
    controller.sync();
    expect(document.querySelector("#min").textContent).toBe("500");
    expect(document.querySelector("#max").textContent).toBe("1500");
    expect(document.querySelector("#value").textContent).toBe("500");
    expect(document.querySelector("#value").style.left).toBe("50px");
    expect(document.querySelectorAll(".band-dock-tick.hovered")).toHaveLength(0);

    const hover = new Event("pointerenter", { bubbles: true });
    Object.defineProperties(hover, { clientX: { value: 200 }, pointerId: { value: 1 } });
    selector.dispatchEvent(hover);
    expect(document.querySelector("#value").textContent).toBe("500");
    expect(document.querySelector("#preview").textContent).toBe("1000");
    expect(selector.classList.contains("previewing")).toBe(true);
    expect(document.querySelectorAll(".band-dock-tick.hovered")).toHaveLength(1);

    const down = new Event("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperties(down, { clientX: { value: 300 }, pointerId: { value: 1 } });
    selector.dispatchEvent(down);
    expect(selected).toEqual([]);

    const up = new Event("pointerup", { bubbles: true, cancelable: true });
    Object.defineProperties(up, { clientX: { value: 300 }, pointerId: { value: 1 } });
    selector.dispatchEvent(up);
    expect(selected).toEqual([2]);
  });

  test("locks selection in color mode and exposes the composite mode button", () => {
    document.body.innerHTML = `
      <div id="dock"><div id="selector"><div id="track"></div></div><button id="mode"></button></div>
    `;
    const ds = { id: "rgb", activeBand: 0, displayMode: "rgb", meta: { bands: 3 } };
    const selector = document.querySelector("#selector");
    const track = document.querySelector("#track");
    track.getBoundingClientRect = () => ({ left: 0, width: 200 });
    const selected = [];
    const cycled = [];
    const controller = createBandDockController({
      els: {
        bandDock: document.querySelector("#dock"),
        bandSelector: selector,
        bandDockTrack: track,
        bandColorMode: document.querySelector("#mode")
      },
      getActive: () => ds,
      onSelectBand: (_dataset, band) => selected.push(band),
      onCycleColorMode: () => cycled.push(true)
    });
    controller.sync();
    expect(selector.classList.contains("locked")).toBe(true);
    expect(document.querySelector("#dock").classList.contains("has-color-mode")).toBe(true);
    expect(document.querySelector("#mode").textContent).toBe("RGB");

    const down = new Event("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperties(down, { clientX: { value: 100 }, pointerId: { value: 1 } });
    selector.dispatchEvent(down);
    expect(selected).toEqual([]);
    document.querySelector("#mode").click();
    expect(cycled).toEqual([true]);
  });
});
