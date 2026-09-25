import { afterEach, describe, expect, test, vi } from "vitest";
import { wireFlyoutPanel } from "../../src/app/wiring/flyout-panel.js";

describe("flyout panel wiring", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("initial collapsed auto-hide state stays hidden until opened", () => {
    document.body.innerHTML = `
      <aside id="panel" data-open="false" data-pinned="false">
        <div id="header">
          <h2>Bands</h2>
          <button id="pin" type="button">
            <i class="fa-solid fa-thumbtack-slash" aria-hidden="true"></i>
          </button>
        </div>
      </aside>
    `;

    const panel = document.querySelector("#panel");
    const header = document.querySelector("#header");
    const btnPin = document.querySelector("#pin");

    wireFlyoutPanel({ panel, header, btnPin });

    expect(panel.dataset.pinned).toBe("false");
    expect(panel.dataset.open).toBe("false");
    expect(btnPin.getAttribute("aria-pressed")).toBe("false");
    expect(btnPin.dataset.pinned).toBe("false");

    header.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panel.dataset.open).toBe("true");
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

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    panel.dispatchEvent(new Event("pointerleave"));
    vi.advanceTimersByTime(160);
    expect(panel.dataset.open).toBe("false");

    header.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panel.dataset.open).toBe("true");

    btnPin.click();
    expect(panel.dataset.pinned).toBe("true");

    panel.dispatchEvent(new Event("pointerleave"));
    vi.advanceTimersByTime(160);
    expect(panel.dataset.open).toBe("true");
  });

  test("desktop hover stays open in the right gutter instead of rapidly toggling", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1000
    });
    document.body.innerHTML = `
      <aside id="panel" data-open="true" data-pinned="false">
        <div id="header">
          <h2>Bands</h2>
          <button id="pin" type="button">
            <i class="fa-solid fa-thumbtack-slash" aria-hidden="true"></i>
          </button>
        </div>
      </aside>
    `;

    const panel = document.querySelector("#panel");
    const header = document.querySelector("#header");
    const btnPin = document.querySelector("#pin");
    panel.getBoundingClientRect = () => ({ left: 610, right: 990, top: 100, bottom: 400, width: 380, height: 300 });

    wireFlyoutPanel({ panel, header, btnPin });

    panel.dispatchEvent(new MouseEvent("pointerleave", {
      bubbles: true,
      clientX: 996,
      clientY: 180
    }));
    vi.advanceTimersByTime(500);
    expect(panel.dataset.open).toBe("true");

    window.dispatchEvent(new MouseEvent("pointermove", {
      bubbles: true,
      clientX: 800,
      clientY: 520
    }));
    vi.advanceTimersByTime(160);
    expect(panel.dataset.open).toBe("false");
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
