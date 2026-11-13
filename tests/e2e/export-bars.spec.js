import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fromArrayBuffer } from "geotiff";

for (const scope of ["selection", "view"]) test(`outside export bars preserve ${scope} pixels in PNG and TIFF`, async ({ page }, testInfo) => {
  await page.goto("/");
  await page.locator("#filePicker").setInputFiles([
    { name: "bars.hdr", mimeType: "text/plain", buffer: Buffer.from("ENVI\nsamples = 400\nlines = 300\nbands = 1\ndata type = 1\ninterleave = bsq\nbyte order = 0\n") },
    { name: "bars.raw", mimeType: "application/octet-stream", buffer: Buffer.alloc(400 * 300, 128) }
  ]);
  await expect(page.locator("#displayDock")).toBeVisible();
  await page.mouse.move(400, 290);
  await page.mouse.down();
  await page.mouse.move(700, 500, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("#selectionActions")).toBeVisible();

  const download = async (format, bars) => {
    await page.locator("#btnToolExport").click();
    await page.locator(format === "png" ? "#expFormatPng" : "#expFormatTiff").check();
    if (format === "tiff") await page.locator("#expModeRendered").check();
    await page.locator(scope === "selection" ? "#expScopeSel" : "#expScopeView").check();
    await page.locator("#expIncludeAnnotations").uncheck();
    await page.locator("#expColorBarMin").fill("0");
    await page.locator("#expColorBarMax").fill("255");
    await page.locator("#expScaleBar").setChecked(bars);
    await page.locator("#expColorBar").setChecked(bars);
    await page.locator("#expScaleBarInside").uncheck();
    await page.locator("#expColorBarInside").uncheck();
    await page.locator("#expScaleBarCorner").selectOption("top-right");
    await page.locator("#expColorBarCorner").selectOption("top-right");
    const pending = page.waitForEvent("download");
    await page.locator("#btnExpGo").click();
    const file = await pending;
    const bytes = await readFile(await file.path());
    await file.saveAs(testInfo.outputPath(`${bars ? "outside-bars" : "plot"}.${format}`));
    if (format === "tiff") {
      const tiff = await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      const image = await tiff.getImage();
      return { width: image.getWidth(), height: image.getHeight(), data: Array.from(await image.readRasters({ interleave: true })).filter((_v, i) => i % image.getSamplesPerPixel() < 3) };
    }
    return page.evaluate(async (data) => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type: "image/png" }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d"); ctx.drawImage(bitmap, 0, 0);
      const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      return { width: canvas.width, height: canvas.height, data: Array.from(rgba).filter((_v, i) => i % 4 !== 3) };
    }, [...bytes]);
  };

  const plot = await download("png", false);
  for (const format of ["png", "tiff"]) {
    const output = await download(format, true);
    expect(output.width).toBeGreaterThanOrEqual(plot.width);
    expect(output.height).toBeGreaterThan(plot.height);
    const imageX = Math.floor((output.width - plot.width) / 2);
    const imageY = output.height - plot.height;
    const image = [];
    for (let row = 0; row < plot.height; row++) {
      const start = ((imageY + row) * output.width + imageX) * 3;
      image.push(...output.data.slice(start, start + plot.width * 3));
    }
    expect(image.length).toBe(plot.data.length);
    expect(image.filter((value, i) => value !== plot.data[i]).length, `${format} plot pixel differences`).toBe(0);
    const margin = output.data.slice(0, imageY * output.width * 3);
    expect(margin.some((value) => value > 0)).toBe(true);
    expect(margin.some((value) => value === 0)).toBe(true);
  }
});
