import { expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fromArrayBuffer } from "geotiff";

export async function loadColorFixture(page, fmap, url = `/?fmap=${fmap}`) {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(url);
  const pixels = 100 * 80;
  const data = Buffer.alloc(pixels * 3);
  for (let y = 0; y < 80; y++) for (let x = 0; x < 100; x++) {
    const i = y * 100 + x;
    data[i] = 10 + x * 2;
    data[pixels + i] = 20 + y * 2;
    data[2 * pixels + i] = 255 - data[i];
  }
  await page.locator("#filePicker").setInputFiles([
    { name: "color.hdr", mimeType: "text/plain", buffer: Buffer.from("ENVI\nsamples = 100\nlines = 80\nbands = 3\ndata type = 1\ninterleave = bsq\nbyte order = 0\nband names = {Red, Green, Blue}\n") },
    { name: "color.raw", mimeType: "application/octet-stream", buffer: data }
  ]);
  await expect(page.locator("#bandColorMode")).toHaveText("Gray");
  await page.locator("#bandColorMode").click();
  await expect(page.locator("#bandColorMode")).toHaveText("RGB");
  await page.mouse.move(400, 290);
  await page.mouse.down();
  await page.mouse.move(620, 440, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("#selectionActions")).toBeVisible();
}

export async function exportImage(page, { format, rendered, selection, scalar = false }) {
  await page.locator("#btnToolExport").click();
  await expect(page.locator("#expBandComposite")).toBeChecked();
  await page.locator(format === "png" ? "#expFormatPng" : "#expFormatTiff").check();
  if (format !== "png") await page.locator(rendered ? "#expModeRendered" : "#expModeRaw").check();
  await page.locator(selection ? "#expScopeSel" : "#expScopeView").check();
  if (scalar) await page.locator("#expBandCurrent").check();
  if (rendered) await page.locator("#expIncludeAnnotations").uncheck();
  const downloading = page.waitForEvent("download");
  await page.locator("#btnExpGo").click();
  const download = await downloading;
  const bytes = await readFile(await download.path());
  await expect(page.locator(".export-progress")).toHaveCount(0);
  if (format === "png") {
    return page.evaluate(async (data) => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type: "image/png" }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d"); ctx.drawImage(bitmap, 0, 0);
      const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const channels = [[], [], []];
      for (let i = 0; i < rgba.length; i += 4 * 251) for (let c = 0; c < 3; c++) channels[c].push(rgba[i + c]);
      return { width: canvas.width, height: canvas.height, channels, samples: 4 };
    }, [...bytes]);
  }
  const tiff = await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  expect(await tiff.getImageCount()).toBe(1);
  const image = await tiff.getImage();
  const raster = await image.readRasters();
  return { width: image.getWidth(), height: image.getHeight(), samples: image.getSamplesPerPixel(),
    photometric: image.fileDirectory.PhotometricInterpretation,
    channels: Array.from({ length: image.getSamplesPerPixel() }, (_, c) =>
      Array.from(raster[c]).filter((_value, i) => !rendered || i % 251 === 0)) };
}
