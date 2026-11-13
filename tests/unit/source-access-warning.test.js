import { describe, expect, test } from "vitest";
import { createSourceAccessWarning } from "../../src/app/source-access-warning.js";

test("dismissal follows the file across cache clears and dataset switches", () => {
  document.body.innerHTML = '<div id="warning" hidden><span></span><button></button></div>';
  const box = document.querySelector("#warning");
  const els = { sourceAccessWarning: box, sourceAccessWarningText: box.querySelector("span"),
    btnDismissSourceAccessWarning: box.querySelector("button") };
  const stats = { sourceReadQualifiedSamples: 40, sourceReadWarning: 1 };
  const file = new File([], "first.dat");
  const first = { dataFile: file, name: "First", ds: { stats } };
  const second = { dataFile: new File([], "second.dat"), name: "Second", ds: { stats: { ...stats } } };
  let active = first;
  const controller = createSourceAccessWarning({ els, getActive: () => active });
  controller.refresh(); expect(box.hidden).toBe(false); expect(box.textContent).toContain("First");
  const textNode = els.sourceAccessWarningText.firstChild;
  controller.refresh(); expect(els.sourceAccessWarningText.firstChild).toBe(textNode); // Avoid repeating live announcements.
  els.btnDismissSourceAccessWarning.click();
  controller.refresh(); expect(box.hidden).toBe(true);
  active = second; controller.refresh(); expect(box.hidden).toBe(false);
  active = { ...first, ds: { stats: { ...stats, sourceReadQualifiedSamples: 0 } } };
  controller.refresh(); expect(box.hidden).toBe(true);
  active = null; controller.refresh(); expect(box.hidden).toBe(true);
});

describe("quiet states", () => {
  test("fast and unsupported sources do not display a warning", () => {
    const box = document.createElement("div");
    let active = { ds: { stats: { sourceReadQualifiedSamples: 40, sourceReadWarning: 0 } } };
    const controller = createSourceAccessWarning({ els: { sourceAccessWarning: box }, getActive: () => active });
    controller.refresh(); expect(box.hidden).toBe(true);
    active = { ds: {} }; controller.refresh(); expect(box.hidden).toBe(true);
  });
});
