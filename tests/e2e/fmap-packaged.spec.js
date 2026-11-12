import { expect, test } from "@playwright/test";
import { pathToFileURL } from "node:url";
import path from "node:path";

test("single-file package reduces large uint8 histograms in its embedded fmap worker offline", async ({ page }) => {
  test.skip(process.env.FMAP_PACKAGED !== "1", "Run with scripts/run-fmap-packaged-test.mjs.");
  await page.context().setOffline(true);
  await page.addInitScript(() => {
    const NativeWorker = globalThis.Worker;
    globalThis.__reductionResults = [];
    globalThis.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.reductions = new Set();
        this.addEventListener("message", ({ data }) => {
          if (!this.reductions.delete(data.id)) return;
          globalThis.__reductionResults.push(data.error || Array.from(new Float64Array(data.result.buffer)));
        });
      }
      postMessage(message, ...args) {
        if (message.type === "reduce") this.reductions.add(message.id);
        return super.postMessage(message, ...args);
      }
    };
  });
  await page.goto(pathToFileURL(path.resolve("dist/index.html")).href);
  await page.locator("#filePicker").setInputFiles([
    { name: "hist.hdr", mimeType: "text/plain", buffer: Buffer.from("ENVI\nsamples = 512\nlines = 512\nbands = 1\ndata type = 1\ninterleave = bsq\nbyte order = 0\n") },
    { name: "hist.raw", mimeType: "application/octet-stream", buffer: Buffer.from(Uint8Array.from({ length: 262144 }, (_, i) => i % 256)) }
  ]);
  // This is a completion/correctness gate, not a five-second throughput test.
  // The streamed analysis yields between 16 batches alongside foreground reads.
  try {
    await page.waitForFunction(() => globalThis.__reductionResults.some((part) => !Array.isArray(part))
      || globalThis.__reductionResults.reduce((sum, part) => sum + part[2], 0) >= 262144,
    null, { timeout: 20000 });
  } catch (error) {
    const progress = await page.evaluate(() => globalThis.__reductionResults.map((part) => Array.isArray(part) ? part[2] : part));
    throw new Error(`Offline histogram did not complete: ${JSON.stringify(progress)}`, { cause: error });
  }
  const values = await page.evaluate(() => {
    const parts = globalThis.__reductionResults;
    if (parts.some((part) => !Array.isArray(part) || part[2] > 16384)) throw new Error("Unexpected reduction batch");
    const merged = Array(261).fill(0);
    merged[0] = Infinity; merged[1] = -Infinity;
    for (const part of parts) {
      merged[0] = Math.min(merged[0], part[0]); merged[1] = Math.max(merged[1], part[1]);
      for (let i = 2; i < merged.length; i++) merged[i] += part[i];
    }
    return merged;
  });
  expect(values.slice(0, 3)).toEqual([0, 255, 262144]);
  expect(values.slice(5)).toEqual(Array(256).fill(1024));
});

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

function packBitsTiffFixture() {
  const entries = [[256, 4, 2], [257, 4, 2], [258, 3, 8], [259, 3, 32773],
    [262, 3, 1], [273, 4, 0], [277, 3, 1], [278, 4, 2], [279, 4, 5]];
  const pixelOffset = 8 + 2 + entries.length * 12 + 4;
  const bytes = Buffer.alloc(pixelOffset + 5);
  bytes.write("II"); bytes.writeUInt16LE(42, 2); bytes.writeUInt32LE(8, 4);
  bytes.writeUInt16LE(entries.length, 8);
  entries.forEach(([tag, type, value], index) => {
    const offset = 10 + index * 12;
    bytes.writeUInt16LE(tag, offset); bytes.writeUInt16LE(type, offset + 2);
    bytes.writeUInt32LE(1, offset + 4); bytes.writeUInt32LE(tag === 273 ? pixelOffset : value, offset + 8);
  });
  bytes.set([3, 10, 20, 30, 40], pixelOffset);
  return bytes;
}

test("single-file package reads and composes ENVI and TIFF through workers without network access", async ({ page }) => {
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
    globalThis.__fmapWorkerTrace = { results: [], decoded: [], pyramidFrames: [], rgbFrames: [], errors: [] };
    globalThis.Worker = class TracedWorker extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.fmapRequestTypes = new Map();
        this.addEventListener("message", (event) => {
          const data = event.data || {};
          if (data.error) globalThis.__fmapWorkerTrace.errors.push(String(data.error.message || data.error));
          const type = this.fmapRequestTypes.get(data.id);
          this.fmapRequestTypes.delete(data.id);
          if ((type === "window" || type === "spectrum") && data.result?.buffer instanceof ArrayBuffer) {
            globalThis.__fmapWorkerTrace.results.push(Array.from(new Float32Array(data.result.buffer).subarray(0, 128)));
          }
          const decoded = data.decoded || data.buffer;
          if (type === "decode:32773" && decoded instanceof ArrayBuffer) {
            globalThis.__fmapWorkerTrace.decoded.push(Array.from(new Uint8Array(decoded).subarray(0, 128)));
          }
          if (type === "pyramid-composition" && !data.error && data.result?.histogramStats?.count > 0) {
            globalThis.__fmapWorkerTrace.pyramidFrames.push({
              count: data.result.histogramStats.count, filledCount: data.result.filledCount,
              fineCount: data.result.fineCount
            });
          }
          if (type === "rgb-composition" && data.bitmap instanceof ImageBitmap) {
            globalThis.__fmapWorkerTrace.rgbFrames.push({
              width: data.bitmap.width, height: data.bitmap.height, pixelsColored: data.pixelsColored
            });
          }
        });
        this.addEventListener("error", (event) => {
          globalThis.__fmapWorkerTrace.errors.push(String(event.message || "Worker error"));
        });
      }
      postMessage(message, ...args) {
        if (message?.type) this.fmapRequestTypes.set(message.id, message.type);
        if (message?.fileDirectory) this.fmapRequestTypes.set(message.id, `decode:${message.fileDirectory.Compression}`);
        if (Array.isArray(message?.operations)) this.fmapRequestTypes.set(message.id, "pyramid-composition");
        if (Array.isArray(message?.planes)) this.fmapRequestTypes.set(message.id, "rgb-composition");
        return super.postMessage(message, ...args);
      }
    };
  });
  await page.route(/^https?:\/\//, (route) => route.abort("blockedbyclient"));
  await page.context().setOffline(true);
  const url = new URL(pathToFileURL(path.resolve("dist/index.html")).href);
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
  await expect.poll(() => page.evaluate(() => (
    globalThis.__fmapWorkerTrace.pyramidFrames.some((frame) => frame.filledCount > 0 && frame.count > 0)
  ))).toBe(true);
  expect(await page.evaluate(() => globalThis.__fmapWorkerTrace.errors)).toEqual([]);

  await page.locator("#filePicker").setInputFiles([
    { name: "offline-rgb.tiff", mimeType: "image/tiff", buffer: rgbTiffFixture() }
  ]);
  await expect(page.locator("#datasetList .ds-item")).toHaveCount(2);
  await expect(page.locator("#datasetList")).toContainText("offline-rgb");
  await expect(page.locator("#datasetList")).toContainText("bands:3");
  await expect.poll(() => page.evaluate(() => (
    globalThis.__fmapWorkerTrace.rgbFrames.some((frame) => frame.width > 0 && frame.height > 0 && frame.pixelsColored > 0)
  ))).toBe(true);
  await page.locator("#filePicker").setInputFiles([
    { name: "offline-packbits.tiff", mimeType: "image/tiff", buffer: packBitsTiffFixture() }
  ]);
  await expect(page.locator("#datasetList .ds-item")).toHaveCount(3);
  await expect(page.locator("#datasetList")).toContainText("offline-packbits");
  await expect(page.locator("#displayDock")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (
    globalThis.__fmapWorkerTrace.decoded.some((values) => values.length === 4 && values.every((value, index) => value === [10, 20, 30, 40][index]))
  ))).toBe(true);
  expect(await page.evaluate(() => globalThis.__fmapWorkerTrace.errors)).toEqual([]);
  expect(errors).toEqual([]);
});
