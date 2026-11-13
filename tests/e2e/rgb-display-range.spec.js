import { expect, test } from "@playwright/test";
import { exportImage } from "./helpers/export-fixture.js";

// A narrow, constant RGB TIFF makes automatic per-channel stretching visibly
// incorrect. Both integer encodings represent the same [32,96,160] RGB color.
function colorTiff(bits) {
  const w = 20, h = 10, entries = 10, bitsOffset = 8 + 2 + entries * 12 + 4;
  const dataOffset = bitsOffset + 6, byteCount = w * h * 3 * bits / 8;
  const bytes = Buffer.alloc(dataOffset + byteCount);
  bytes.write("II"); bytes.writeUInt16LE(42, 2); bytes.writeUInt32LE(8, 4); bytes.writeUInt16LE(entries, 8);
  const tags = [[256, 4, 1, w], [257, 4, 1, h], [258, 3, 3, bitsOffset], [259, 3, 1, 1], [262, 3, 1, 2],
    [273, 4, 1, dataOffset], [277, 3, 1, 3], [278, 4, 1, h], [279, 4, 1, byteCount], [284, 3, 1, 1]];
  tags.forEach(([tag, type, count, value], i) => {
    const offset = 10 + i * 12;
    bytes.writeUInt16LE(tag, offset); bytes.writeUInt16LE(type, offset + 2);
    bytes.writeUInt32LE(count, offset + 4); bytes.writeUInt32LE(value, offset + 8);
  });
  for (let c = 0; c < 3; c++) bytes.writeUInt16LE(bits, bitsOffset + c * 2);
  for (let i = 0; i < w * h * 3; i++) {
    const value = [32, 96, 160][i % 3];
    if (bits === 8) bytes[dataOffset + i] = value;
    else bytes.writeUInt16LE(value * 257, dataOffset + i * 2);
  }
  return bytes;
}

for (const bits of [8, 16]) test(`${bits}-bit RGB TIFF loads at full scale on every channel`, async ({ page }) => {
  await page.goto("/");
  await page.locator("#filePicker").setInputFiles({ name: "color.tif", mimeType: "image/tiff", buffer: colorTiff(bits) });
  await expect(page.locator("#bandColorMode")).toHaveText("RGB");
  await page.locator("#displayHeader").click();
  for (let channel = 0; channel < 3; channel++) {
    await expect(page.locator("#numMin")).toHaveValue("0");
    await expect(page.locator("#numMax")).toHaveValue(String(2 ** bits - 1));
    await page.locator("#btnHistChannel").click();
  }
  await page.locator("#displayHeader").click();
  const rendered = await exportImage(page, { format: "tiff", rendered: true, selection: false });
  // A view export can include black margins outside the image bounds.
  const colors = rendered.channels[0].map((_, i) => rendered.channels.slice(0, 3).map(channel => channel[i]))
    .filter(pixel => pixel.some(value => value !== 0));
  expect(colors.length).toBeGreaterThan(0);
  expect([...new Set(colors.map(pixel => pixel.join(",")))]).toEqual(["32,96,160"]);
  await page.locator("#displayHeader").click();
  await page.locator("#btnAuto").click();
  await expect(page.locator("#numMin")).not.toHaveValue("0");
});
