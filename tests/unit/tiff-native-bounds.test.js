import { Blob as NodeBlob } from "node:buffer";
import { describe, expect, test } from "vitest";
import { openTiffBackend } from "../../src/io/tiff/backend/index.js";
import { describeTiffDataset } from "../../src/io/tiff/describe.js";

describe("native TIFF metadata bounds", () => {
  test("rejects a forged BigTIFF directory count before allocating its table", async () => {
    const bytes = new Uint8Array(24);
    const view = new DataView(bytes.buffer);
    bytes.set([0x49, 0x49]);
    view.setUint16(2, 43, true);
    view.setUint16(4, 8, true);
    view.setBigUint64(8, 16n, true);
    view.setBigUint64(16, 1_000_000n, true);
    const file = new NodeBlob([bytes], { type: "image/tiff" });
    await expect(openTiffBackend(file)).rejects.toThrow(/metadata exceeds.*parsing limit/i);
  });

  test("rejects an oversized known tag value before reading its payload", async () => {
    const bytes = new Uint8Array(26);
    const view = new DataView(bytes.buffer);
    bytes.set([0x49, 0x49]);
    view.setUint16(2, 42, true);
    view.setUint32(4, 8, true);
    view.setUint16(8, 1, true);
    view.setUint16(10, 273, true);
    view.setUint16(12, 4, true);
    view.setUint32(14, 5_000_000, true);
    view.setUint32(18, 26, true);
    view.setUint32(22, 0, true);
    const file = new NodeBlob([bytes], { type: "image/tiff" });
    await expect(openTiffBackend(file)).rejects.toThrow(/metadata exceeds.*tag 273 values/i);
  });

  test("rejects a forged scalar SamplesPerPixel before expanding sample arrays", async () => {
    const bytes = new Uint8Array(26);
    const view = new DataView(bytes.buffer);
    bytes.set([0x49, 0x49]);
    view.setUint16(2, 42, true);
    view.setUint32(4, 8, true);
    view.setUint16(8, 1, true);
    view.setUint16(10, 277, true);
    view.setUint16(12, 4, true);
    view.setUint32(14, 1, true);
    view.setUint32(18, 1_000_000, true);
    view.setUint32(22, 0, true);
    const file = new NodeBlob([bytes], { type: "image/tiff" });
    const backend = await openTiffBackend(file);
    await expect(describeTiffDataset(backend, file)).rejects.toThrow(/SamplesPerPixel.*supported limit/i);
    backend.close();
  });
});
