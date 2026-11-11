import { describe, expect, test } from "vitest";
import { wireFlyoutPanel } from "../../src/app/wiring/flyout-panel.js";

function setup() {
  document.body.innerHTML = `
    <aside id="panel" data-open="false">
      <div id="header"><h2>Display</h2></div>
      <input id="range" type="number" />
    </aside>
    <button id="outside">Outside</button>
  `;
  const panel = document.querySelector("#panel");
  const header = document.querySelector("#header");
  wireFlyoutPanel({ panel, header });
  return { panel, header };
}

describe("flyout panel wiring", () => {
  test("title toggles the panel and pointer movement leaves it open", () => {
    const { panel, header } = setup();
    expect(panel.dataset.open).toBe("false");
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(panel.style.getPropertyValue("--flyout-title-size")).toMatch(/px$/);
    panel.dispatchEvent(new Event("pointerenter"));
    expect(panel.dataset.open).toBe("false");

    header.querySelector("h2").click();
    panel.dispatchEvent(new Event("pointerleave"));
    expect(panel.dataset.open).toBe("true");
    expect(header.getAttribute("aria-expanded")).toBe("true");

    header.querySelector("h2").click();
    expect(panel.dataset.open).toBe("false");
    panel.dispatchEvent(new Event("pointerenter"));
    expect(panel.dataset.open).toBe("false");
  });

  test("inside interaction stays open and an outside pointer press closes it", () => {
    const { panel, header } = setup();
    header.click();
    document.querySelector("#range").dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(panel.dataset.open).toBe("true");
    document.querySelector("#outside").dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(panel.dataset.open).toBe("false");
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  test.each(["Enter", " "])("keyboard %s toggles the panel", (key) => {
    const { panel, header } = setup();
    header.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    expect(panel.dataset.open).toBe("true");
    header.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    expect(panel.dataset.open).toBe("false");
  });
});
