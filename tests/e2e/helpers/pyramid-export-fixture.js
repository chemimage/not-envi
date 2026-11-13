import { expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fromArrayBuffer, GeoTIFFImage } from "geotiff";


export async function exportPyramidFixture(page, testInfo, url = "/") {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(url);
  const width = 2048, height = 2048, pixels = width * height, data = Buffer.alloc(pixels * 2);
  for (let i = 0; i < pixels; i++) { data[i] = i % 251; data[pixels + i] = 250 - i % 251; }
  await page.locator("#filePicker").setInputFiles([
    { name: "large.hdr", mimeType: "text/plain", buffer: Buffer.from(`ENVI\nsamples = ${width}\nlines = ${height}\nbands = 2\ndata type = 1\ninterleave = bsq\nbyte order = 0\npixel size (um) = {0.5, 1.25}\n`) },
    { name: "large.raw", mimeType: "application/octet-stream", buffer: data }
  ]);
  await expect(page.locator("#displayDock")).toBeVisible();
  await page.mouse.click(500, 300);
  await page.locator("#btnToolExport").click();
  await page.locator("#expFormatTiff").check();
  await page.locator("#expModeRaw").check();
  await page.locator("#expScopeView").check();
  await page.locator("#expBandAll").check();
  await expect(page.locator("#expNote")).toContainText("Includes an image pyramid");
  const pending = page.waitForEvent("download");
  await page.locator("#btnExpGo").click();
  const download = await pending, path = testInfo.outputPath("large-pyramid.tiff");
  await download.saveAs(path);
  const bytes = await readFile(path), tiff = await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  expect(await tiff.getImageCount()).toBe(2);
  for (let band = 0; band < 2; band++) {
    const image = await tiff.getImage(band), fd = image.fileDirectory;
    expect([image.getWidth(), image.getHeight()]).toEqual([width, height]);
    expect(fd.TileWidth).toBe(512);
    expect(fd.Compression).toBe(8);
    expect(fd.Software).toMatch(/^not-envi/);
    expect(fd.ResolutionUnit).toBe(3);
    expect(fd.XResolution[0] / fd.XResolution[1]).toBeCloseTo(20000);
    expect(fd.YResolution[0] / fd.YResolution[1]).toBeCloseTo(8000);
    expect(Array.from(fd.SubIFDs)).toHaveLength(2);
    const raster = await image.readRasters({ interleave: true });
    expect(raster.every((value, i) => value === data[band * pixels + i])).toBe(true);
    for (let level = 0; level < 2; level++) {
      const parsed = await tiff.parseFileDirectoryAt(fd.SubIFDs[level]);
      const overview = new GeoTIFFImage(parsed.fileDirectory, parsed.geoKeyDirectory, tiff.dataView, tiff.littleEndian, false, tiff.source);
      expect(overview.getWidth()).toBe(width / (2 ** (level + 1)));
      expect(overview.fileDirectory.NewSubfileType).toBe(1);
    }
  }
  await expect(page.locator(".export-progress")).toHaveCount(0);
  await page.getByRole("button", { name: "Close dataset", exact: true }).click();
  await page.locator("#filePicker").setInputFiles(path);
  await expect(page.locator("#displayDock")).toBeVisible();
  await expect(page.getByText(/2,?048\u00d72,?048\s+bands:2/, { exact: true })).toBeVisible();
  await expect(page.locator("#metaScale")).toHaveText(/0\.5.*1\.25.*m\/px/);
}
