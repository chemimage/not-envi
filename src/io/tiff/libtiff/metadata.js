import { callLibtiff, createLibtiffModule, libtiffResult } from "./runtime.js";
import { loadLibtiffCompiled } from "./compiled.js";
import { coalesceRawStrips } from "./raw-layout.js";

const MAX_METADATA = 16 * 1024 * 1024;
const TAGS = new Map([
  [254, "NewSubfileType"], [256, "ImageWidth"], [257, "ImageLength"],
  [258, "BitsPerSample"], [259, "Compression"], [262, "PhotometricInterpretation"],
  [266, "FillOrder"], [270, "ImageDescription"], [273, "StripOffsets"],
  [274, "Orientation"], [277, "SamplesPerPixel"], [278, "RowsPerStrip"],
  [279, "StripByteCounts"], [284, "PlanarConfiguration"], [285, "PageName"],
  [297, "PageNumber"], [317, "Predictor"], [322, "TileWidth"], [323, "TileLength"],
  [324, "TileOffsets"], [325, "TileByteCounts"], [330, "SubIFDs"],
  [339, "SampleFormat"], [347, "JPEGTables"]
]);

export function metadataLimitError(message) {
  return Object.assign(new Error(message), { code: "TIFF_METADATA_LIMIT" });
}

/** The existing fmap source serves every C read; libtiff never maps the file. */
export class LibtiffMetadataReader {
  constructor(file, rangeSource, limit = MAX_METADATA) {
    if (!Number.isSafeInteger(file?.size) || file.size < 0) throw new RangeError("TIFF file size exceeds the exact integer range.");
    this.file = file;
    this.rangeSource = rangeSource;
    this.limit = Math.min(MAX_METADATA, Number.isSafeInteger(limit) && limit > 0 ? limit : MAX_METADATA);
    this.used = 0;
    this.closed = false;
    this.queue = Promise.resolve();
  }

  async read(offset, length) {
    if (this.closed) throw new Error("TIFF reader is closed.");
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > this.limit) {
      throw metadataLimitError("TIFF metadata exceeds the bounded parsing limit.");
    }
    const count = Math.max(0, Math.min(length, this.file.size - offset));
    if (!this.rangeSource) {
      const blob = this.file.slice(offset, offset + count);
      if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error || new Error("TIFF metadata read failed."));
        reader.onload = () => resolve(new Uint8Array(reader.result));
        reader.readAsArrayBuffer(blob);
      });
    }
    const output = new Uint8Array(count);
    const chunk = Math.max(1, Math.min(1024 * 1024, this.rangeSource.maxLogicalResultBytes || Infinity,
      this.rangeSource.maxWorkingSetBytes ? Math.floor(this.rangeSource.maxWorkingSetBytes / 2) : Infinity));
    for (let cursor = 0; cursor < count; cursor += chunk) {
      output.set(await this.rangeSource.read(offset + cursor, Math.min(chunk, count - cursor)), cursor);
    }
    return output;
  }

  async open() {
    this.module = await createLibtiffModule(await loadLibtiffCompiled());
    this.module.io = { size: this.file.size, read: (offset, count) => this.read(offset, count) };
    libtiffResult(this.module, await callLibtiff(this.module, "hyve_open", [this.limit]));
    return { littleEndian: !!this.module._hyve_little_endian(), bigTiff: !!this.module._hyve_big_tiff(),
      firstIfdOffset: this.module._hyve_offset() };
  }

  directory(offset) {
    const work = this.queue.then(async () => {
      if (this.closed) throw new Error("TIFF reader is closed.");
      const module = this.module, fileDirectory = {};
      module.tag = (tag, value) => {
        const bytes = typeof value === "string" ? value.length * 2 : value?.byteLength || 8;
        if (this.used + bytes > this.limit) throw metadataLimitError("TIFF metadata exceeds the retained parsing limit.");
        this.used += bytes;
        if (TAGS.has(tag)) fileDirectory[TAGS.get(tag)] = value;
      };
      libtiffResult(module, await callLibtiff(module, "hyve_directory", [offset]));
      coalesceRawStrips(fileDirectory, this.file.size);
      const next = await callLibtiff(module, "hyve_next");
      if (next < 0) libtiffResult(module, next);
      return { fileDirectory, ifdOffset: offset, nextIfdOffset: next };
    });
    this.queue = work.catch(() => {});
    return work;
  }

  close() {
    this.closed = true;
    const module = this.module;
    this.queue.finally(() => { module?._hyve_close(); this.module = null; });
  }
}
