import { expect, test } from "@playwright/test";
import { pathToFileURL } from "node:url";
import path from "node:path";

function rgbTiffFixture() {
  const pixels = new Uint8Array([
    255, 0, 0, 0, 255, 0,
    10, 20, 30, 40, 50, 60
  ]);
  const entries = [
    [256, 4, 1, 2], [257, 4, 1, 2], [258, 3, 3, 0],
    [259, 3, 1, 1], [262, 3, 1, 2], [273, 4, 2, 0],
    [277, 3, 1, 3], [278, 4, 1, 1], [279, 4, 2, 0],
    [284, 3, 1, 1]
  ];
  const ifdOffset = 8;
  const ifdBytes = 2 + (entries.length * 12) + 4;
  const bitsOffset = ifdOffset + ifdBytes;
  const stripOffsetsOffset = bitsOffset + 6;
  const stripByteCountsOffset = stripOffsetsOffset + 8;
  const pixelOffset = stripByteCountsOffset + 8;
  const buffer = new ArrayBuffer(pixelOffset + pixels.byteLength);
  const view = new DataView(buffer);
  view.setUint8(0, 0x49);
  view.setUint8(1, 0x49);
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);
  view.setUint16(ifdOffset, entries.length, true);
  let offset = ifdOffset + 2;
  for (const [tag, type, count, originalValue] of entries) {
    let value = originalValue;
    if (tag === 258) value = bitsOffset;
    if (tag === 273) value = stripOffsetsOffset;
    if (tag === 279) value = stripByteCountsOffset;
    view.setUint16(offset, tag, true);
    view.setUint16(offset + 2, type, true);
    view.setUint32(offset + 4, count, true);
    view.setUint32(offset + 8, value, true);
    offset += 12;
  }
  view.setUint32(offset, 0, true);
  view.setUint16(bitsOffset, 8, true);
  view.setUint16(bitsOffset + 2, 8, true);
  view.setUint16(bitsOffset + 4, 8, true);
  view.setUint32(stripOffsetsOffset, pixelOffset, true);
  view.setUint32(stripOffsetsOffset + 4, pixelOffset + 6, true);
  view.setUint32(stripByteCountsOffset, 6, true);
  view.setUint32(stripByteCountsOffset + 4, 6, true);
  new Uint8Array(buffer, pixelOffset).set(pixels);
  return Buffer.from(buffer);
}

test("single-file package opens an fmap ENVI dataset without network access", async ({ page }) => {
  test.skip(process.env.FMAP_PACKAGED !== "1", "Run with scripts/run-fmap-packaged-test.mjs.");

  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error" && !/ERR_(?:INTERNET_DISCONNECTED|BLOCKED_BY_CLIENT)/.test(message.text())) {
      errors.push(message.text());
    }
  });
  await page.addInitScript(() => {
    const NativeWorker = globalThis.Worker;
    globalThis.__fmapWorkerTrace = { results: [], errors: [] };
    globalThis.Worker = class TracedWorker extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", (event) => {
          const data = event.data || {};
          if (data.error) globalThis.__fmapWorkerTrace.errors.push(String(data.error.message || data.error));
          if (data.result?.buffer instanceof ArrayBuffer) {
            globalThis.__fmapWorkerTrace.results.push(Array.from(new Float32Array(data.result.buffer).subarray(0, 128)));
          }
        });
        this.addEventListener("error", (event) => {
          globalThis.__fmapWorkerTrace.errors.push(String(event.message || "Worker error"));
        });
      }
    };
  });
  await page.route(/^https?:\/\//, (route) => route.abort("blockedbyclient"));
  await page.context().setOffline(true);
  const url = new URL(pathToFileURL(path.resolve("dist/index.html")).href);
  url.searchParams.set("fmap", "1");
  await page.goto(url.href);

  const data = Buffer.alloc((8 * 6 * 2 * 4) + 3, 0);
  for (let index = 0; index < 8 * 6 * 2; index += 1) {
    data.writeFloatLE(index + 0.5, 3 + (index * 4));
  }
  await page.locator("#filePicker").setInputFiles([
    {
      name: "offline.hdr",
      mimeType: "text/plain",
      buffer: Buffer.from("ENVI\nsamples = 8\nlines = 6\nbands = 2\nheader offset = 3\ndata type = 4\ninterleave = bsq\nbyte order = 0\n")
    },
    { name: "offline.dat", mimeType: "application/octet-stream", buffer: data }
  ]);

  await expect(page.locator("#displayDock")).toBeVisible();
  await expect(page.locator("#btnFit")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (
    globalThis.__fmapWorkerTrace.results.some((values) => values.includes(0.5) && values.includes(47.5))
  ))).toBe(true);
  expect(await page.evaluate(() => globalThis.__fmapWorkerTrace.errors)).toEqual([]);

  await page.locator("#filePicker").setInputFiles([
    { name: "offline-rgb.tiff", mimeType: "image/tiff", buffer: rgbTiffFixture() }
  ]);
  await expect(page.locator("#datasetList .ds-item")).toHaveCount(2);
  await expect(page.locator("#datasetList")).toContainText("offline-rgb");
  await expect(page.locator("#datasetList")).toContainText("bands:3");
  expect(errors).toEqual([]);
});
