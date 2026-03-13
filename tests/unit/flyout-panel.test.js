import { describe, expect, test } from "vitest";
import { wireFlyoutPanel } from "../../src/app/wiring/flyout-panel.js";

describe("flyout panel wiring", () => {
  test("single thumbtack button toggles pinned and auto-hide states", () => {
    document.body.innerHTML = `
      <aside id="panel" data-open="true" data-pinned="true">
        <div id="header">
          <button id="pin" type="button">
            <span class="panel-pin-icon" aria-hidden="true">
              <i class="fa-solid fa-thumbtack" aria-hidden="true"></i>
              <span class="panel-pin-slash"></span>
            </span>
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
    expect(btnPin.getAttribute("aria-pressed")).toBe("true");
    expect(btnPin.dataset.pinned).toBe("true");
    expect(btnPin.querySelector("i")?.classList.contains("fa-thumbtack")).toBe(true);

    btnPin.click();
    expect(panel.dataset.pinned).toBe("false");
    expect(panel.dataset.open).toBe("true");
    expect(btnPin.getAttribute("aria-pressed")).toBe("false");
    expect(btnPin.dataset.pinned).toBe("false");

    panel.dispatchEvent(new Event("pointerleave"));
    expect(panel.dataset.open).toBe("false");

    header.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panel.dataset.open).toBe("true");

    btnPin.click();
    expect(panel.dataset.pinned).toBe("true");

    panel.dispatchEvent(new Event("pointerleave"));
    expect(panel.dataset.open).toBe("true");
  });
});
