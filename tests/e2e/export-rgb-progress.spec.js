import { expect, test } from "@playwright/test";
import { exportImage, loadColorFixture } from "./helpers/export-fixture.js";

for (const fmap of [0, 1]) {
  test(`RGB and BGR downloads preserve channel order, selections and explicit scalar (fmap=${fmap})`, async ({ page }) => {
    test.setTimeout(90_000);
    await loadColorFixture(page, fmap);
    const rgb = new Map();
    for (const mode of ["RGB", "BGR"]) {
      if (mode === "BGR") await page.locator("#bandColorMode").click();
      await expect(page.locator("#bandColorMode")).toHaveText(mode);
      for (const selection of [false, true]) for (const [format, rendered] of [["tiff", false], ["tiff", true], ["png", true]]) {
        const output = await exportImage(page, { format, rendered, selection });
        expect(output.samples).toBeGreaterThanOrEqual(3);
        expect(output.channels[0]).not.toEqual(output.channels[1]);
        const key = `${selection}:${format}:${rendered}`;
        if (!rendered) {
          expect(output.photometric).toBe(2);
          if (!selection) { expect(output.width).toBe(100); expect(output.height).toBe(80); }
          expect(output.channels[0].every((value, i) => value + output.channels[2][i] === 255)).toBe(true);
          expect(output.channels[1].every(value => value >= 20 && value <= 178 && value % 2 === 0)).toBe(true);
          const red = output.channels[mode === "RGB" ? 0 : 2];
          expect(red.every(value => value >= 10 && value <= 208 && value % 2 === 0)).toBe(true);
          if (!selection) {
            expect(red.every((value, i) => value === 10 + (i % 100) * 2)).toBe(true);
            expect(output.channels[1].every((value, i) => value === 20 + Math.floor(i / 100) * 2)).toBe(true);
          }
        }
        if (mode === "RGB") rgb.set(key, output);
        else {
          const original = rgb.get(key);
          expect([output.width, output.height]).toEqual([original.width, original.height]);
          expect(output.channels[0], `${key}: BGR red must match RGB blue`).toEqual(original.channels[2]);
          expect(output.channels[1], `${key}: green must stay unchanged`).toEqual(original.channels[1]);
          expect(output.channels[2], `${key}: BGR blue must match RGB red`).toEqual(original.channels[0]);
        }
      }
    }
    const scalar = await exportImage(page, { format: "tiff", rendered: false, selection: true, scalar: true });
    expect(scalar.samples).toBe(1);
    expect(scalar.photometric).toBe(1);
  });
}

test("export progress stays visible across slow work, blocks duplicates, and recovers after failures", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const { createExportService } = await import("/src/export/export-service.js");
    const { encodeExportJob } = await import("/src/export/encode-job.js");
    const button = document.createElement("button");
    document.body.append(button);
    const state = { selection: { imgRect: null } };
    const ds = { name: "progress", activeBand: 0, view: { x: 0, y: 0, scale: 1 }, ds: {},
      meta: { samples: 2, lines: 2, bands: 1, interleave: "bsq", dataType: 1, dataTypeInfo: { bytes: 1, ctor: Uint8Array } } };
    const harness = window.exportHarness = { state, button, reads: 0, encodes: 0, downloads: 0, failure: null };
    const service = createExportService({ state,
      els: { btnExpGo: button, cpuCanvas: { width: 2, height: 2 }, exportDlg: { close() {} }, expModeRaw: { checked: true } },
      getActive: () => ds, setStatus() {}, humanBytes: String, fmt: String, bandLabel: () => "band",
      clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)), confirmFn: () => true, alertFn() {},
      readBandWindow: async () => {
        harness.reads++;
        await new Promise(resolve => { harness.releaseRead = resolve; });
        if (harness.failure === "read") throw new Error("Injected read failure");
        return new Uint8Array([1, 2, 3, 4]);
      },
      encodeExport: async (job) => {
        harness.encodes++;
        await new Promise(resolve => { harness.releaseEncode = resolve; });
        if (harness.failure === "encode") throw new Error("Injected encode failure");
        return encodeExportJob(job);
      },
      downloadBlob() { harness.downloads++; }
    });
    harness.start = () => {
      harness.error = null;
      harness.promise = service.runExportFromDialog().catch(error => { harness.error = error.message; });
    };
    harness.duplicate = () => service.runExportFromDialog();
    harness.start();
  });
  for (const failure of ["read", "encode", null]) {
    if (failure !== "read") await page.evaluate((value) => { window.exportHarness.failure = value; window.exportHarness.start(); }, failure);
    else await page.evaluate(() => { window.exportHarness.failure = "read"; });
    await expect.poll(() => page.evaluate(() => typeof window.exportHarness.releaseRead)).toBe("function");
    await expect(page.locator(".export-progress")).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "Export work" })).toBeVisible();
    expect(await page.evaluate(() => window.exportHarness.button.disabled)).toBe(true);
    const reads = await page.evaluate(() => window.exportHarness.reads);
    await page.evaluate(() => window.exportHarness.duplicate());
    expect(await page.evaluate(() => window.exportHarness.reads)).toBe(reads);
    await page.evaluate(() => { const h = window.exportHarness; const release = h.releaseRead; delete h.releaseRead; release(); });
    if (failure !== "read") {
      await expect.poll(() => page.evaluate(() => typeof window.exportHarness.releaseEncode)).toBe("function");
      await expect(page.locator(".export-progress [role=status]")).toContainText("Encoding");
      if (failure === "encode") await page.locator(".export-progress").screenshot({ path: testInfo.outputPath("export-progress.png") });
      expect(await page.getByRole("progressbar", { name: "Export work" }).getAttribute("aria-valuenow")).toBeNull();
      await page.evaluate(() => { const h = window.exportHarness; const release = h.releaseEncode; delete h.releaseEncode; release(); });
    }
    await page.evaluate(() => window.exportHarness.promise);
    await expect(page.locator(".export-progress")).toHaveCount(0);
    expect(await page.evaluate(() => window.exportHarness.state.exportRunning)).toBe(false);
    expect(await page.evaluate(() => window.exportHarness.button.disabled)).toBe(false);
    expect(await page.evaluate(() => window.exportHarness.error)).toBe(failure ? `Injected ${failure} failure` : null);
  }
  expect(await page.evaluate(() => window.exportHarness.downloads)).toBe(1);
});

test("keyboard save cannot duplicate an export while PNG encoding is pending", async ({ page }) => {
  await loadColorFixture(page, 1);
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (...args) {
      window.releasePngEncoding = () => original.apply(this, args);
    };
  });
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.locator("#btnToolExport").click();
  await page.locator("#expFormatPng").check();
  await page.locator("#expIncludeAnnotations").uncheck();
  await page.locator("#btnExpGo").click();
  await expect.poll(() => page.evaluate(() => typeof window.releasePngEncoding)).toBe("function");
  await expect(page.locator(".export-progress")).toBeVisible();
  await expect(page.locator(".export-progress [role=status]")).toContainText("Encoding PNG");
  await page.keyboard.press("Control+s");
  await page.keyboard.press("Control+s");
  await expect(page.locator("#exportDlg")).toBeHidden();
  await expect(page.locator(".export-progress")).toHaveCount(1);
  expect(downloads).toBe(0);
  const download = page.waitForEvent("download");
  await page.evaluate(() => window.releasePngEncoding());
  await download;
  await expect(page.locator(".export-progress")).toHaveCount(0);
  expect(downloads).toBe(1);
});
