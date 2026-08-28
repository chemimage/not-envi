import { describe, expect, test, vi } from "vitest";
import { wireDrawToolInteractions } from "../../src/app/wiring/draw-tools.js";

describe("draw tool spectrum mode", () => {
  test("keeps the floating spectrum note tied to spectrum mode", () => {
    document.body.innerHTML = `
      <main id="main">
        <button id="btnToolSpectral" type="button"></button>
        <section id="specPanel" style="display:none;">
          <button id="btnSpecClose" type="button"></button>
        </section>
      </main>
    `;
    const els = {
      main: document.querySelector("#main"),
      btnToolSpectral: document.querySelector("#btnToolSpectral"),
      specPanel: document.querySelector("#specPanel"),
      btnSpecClose: document.querySelector("#btnSpecClose")
    };
    let spectrumEnabled = false;
    const closeSpectrum = vi.fn(() => {
      els.specPanel.style.display = "none";
    });
    const setSpectrumPickEnabled = vi.fn((enabled) => {
      spectrumEnabled = !!enabled;
    });
    const spectralDrag = {
      stop: vi.fn(),
      previewFromEvent: vi.fn(() => false),
      beginFromEvent: vi.fn(() => false),
      updateFromEvent: vi.fn(() => false),
      endFromEvent: vi.fn(() => false)
    };

    wireDrawToolInteractions({
      state: { selection: { enabled: false } },
      els,
      closeSpectrum,
      getDrawTool: () => "none",
      getSpectrumPickEnabled: () => spectrumEnabled,
      setSpectrumPickEnabled,
      getEffectiveAreaSelectionCount: () => 0,
      getAreaSelectionMode: () => "single",
      spectralDrag
    });

    els.btnToolSpectral.click();
    expect(spectrumEnabled).toBe(true);
    expect(els.btnToolSpectral.getAttribute("aria-pressed")).toBe("true");

    els.specPanel.style.display = "flex";
    els.btnToolSpectral.click();
    expect(spectrumEnabled).toBe(false);
    expect(closeSpectrum).toHaveBeenCalledTimes(1);
    expect(els.specPanel.style.display).toBe("none");

    els.btnToolSpectral.click();
    els.specPanel.style.display = "flex";
    els.btnSpecClose.click();
    expect(spectrumEnabled).toBe(false);
    expect(closeSpectrum).toHaveBeenCalledTimes(2);
    expect(els.btnToolSpectral.getAttribute("aria-pressed")).toBe("false");
  });
});
