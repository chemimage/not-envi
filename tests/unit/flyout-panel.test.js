import { afterEach, describe, expect, test, vi } from "vitest";
import { wireFlyoutPanel } from "../../src/app/wiring/flyout-panel.js";

describe("flyout panel wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("single thumbtack button toggles pinned and auto-hide states", () => {
    document.body.innerHTML = `
      <aside id="panel" data-open="true" data-pinned="true">
        <div id="header">
          <h2>Bands</h2>
          <button id="pin" type="button">
            <i class="fa-solid fa-thumbtack" aria-hidden="true"></i>
          </button>
        </div>
      </aside>
    `;

    const panel = document.querySelector("#panel");
    const header = document.querySelector("#header");
    const btnPin = document.querySelector("#pin");

    wireFlyoutPanel({ panel, header, btnPin });

    expect(panel.dataset.pinned).toBe("true");
    expect(panel.dataset.open).toBe("true");
    expect(panel.style.getPropertyValue("--flyout-title-size")).toMatch(/px$/);
    expect(btnPin.getAttribute("aria-pressed")).toBe("true");
    expect(btnPin.dataset.pinned).toBe("true");
    expect(btnPin.querySelector("i")?.classList.contains("fa-thumbtack")).toBe(true);

    btnPin.click();
    expect(panel.dataset.pinned).toBe("false");
    expect(panel.dataset.open).toBe("true");
    expect(btnPin.getAttribute("aria-pressed")).toBe("false");
    expect(btnPin.dataset.pinned).toBe("false");
    expect(btnPin.querySelector("i")?.classList.contains("fa-thumbtack-slash")).toBe(true);

    panel.dispatchEvent(new Event("pointerleave"));
    expect(panel.dataset.open).toBe("false");

    header.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panel.dataset.open).toBe("true");

    btnPin.click();
    expect(panel.dataset.pinned).toBe("true");

    panel.dispatchEvent(new Event("pointerleave"));
    expect(panel.dataset.open).toBe("true");
  });

  test("touch-style devices collapse unpinned panels and hide on outside tap", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    document.body.innerHTML = `
      <aside id="panel" data-open="true" data-pinned="true">
        <div id="header">
          <h2>Bands</h2>
          <button id="pin" type="button">
            <i class="fa-solid fa-thumbtack" aria-hidden="true"></i>
          </button>
        </div>
      </aside>
      <button id="outside" type="button">Outside</button>
    `;

    const panel = document.querySelector("#panel");
    const header = document.querySelector("#header");
    const btnPin = document.querySelector("#pin");
    const outside = document.querySelector("#outside");

    wireFlyoutPanel({ panel, header, btnPin });

    btnPin.click();
    expect(panel.dataset.pinned).toBe("false");
    expect(panel.dataset.open).toBe("false");

    header.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
    expect(panel.dataset.open).toBe("true");

    panel.dispatchEvent(new Event("pointerleave"));
    expect(panel.dataset.open).toBe("true");

    outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(panel.dataset.open).toBe("false");
  });
});
