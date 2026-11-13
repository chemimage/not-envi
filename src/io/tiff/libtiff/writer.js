import { callLibtiff, createLibtiffModule, libtiffResult } from "./runtime.js";

const CHUNK_BYTES = 256 * 1024;
const MAX_BLOCK_BYTES = 32 * 1024 * 1024;

// Random writes are required for IFD links. Keep the output outside the bounded
// WASM heap and assemble a Blob without allocating a second whole-file buffer.
class OutputFile {
  constructor() { this.chunks = []; this.size = 0; }
  write(offset, bytes) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(offset + bytes.length)) {
      throw new RangeError("TIFF output exceeds the exact integer range.");
    }
    for (let at = 0; at < bytes.length;) {
      const index = Math.floor((offset + at) / CHUNK_BYTES), start = (offset + at) % CHUNK_BYTES;
      const count = Math.min(bytes.length - at, CHUNK_BYTES - start);
      this.chunks[index] ||= new Uint8Array(CHUNK_BYTES);
      this.chunks[index].set(bytes.subarray(at, at + count), start);
      at += count;
    }
    this.size = Math.max(this.size, offset + bytes.length);
    return bytes.length;
  }
  read(offset, count) {
    const bytes = new Uint8Array(Math.max(0, Math.min(count, this.size - offset)));
    for (let at = 0; at < bytes.length;) {
      const index = Math.floor((offset + at) / CHUNK_BYTES), start = (offset + at) % CHUNK_BYTES;
      const length = Math.min(bytes.length - at, CHUNK_BYTES - start);
      if (this.chunks[index]) bytes.set(this.chunks[index].subarray(start, start + length), at);
      at += length;
    }
    return bytes;
  }
  blob() {
    return new Blob(Array.from({ length: Math.ceil(this.size / CHUNK_BYTES) }, (_, index) =>
      (this.chunks[index] || new Uint8Array(CHUNK_BYTES)).subarray(0, Math.min(CHUNK_BYTES, this.size - index * CHUNK_BYTES))),
    { type: "image/tiff" });
  }
}

export class LibtiffWriter {
  static async open(compiled, bigTiff = false) {
    const writer = new LibtiffWriter();
    writer.module = await createLibtiffModule(compiled);
    writer.module.io = new OutputFile();
    writer.pointer = 0; writer.capacity = 0;
    try {
      await writer.call("ne_tiff_write_open", [bigTiff ? 1 : 0]);
      return writer;
    } catch (error) { writer.close(); throw error; }
  }
  async call(name, args = []) {
    return libtiffResult(this.module, await callLibtiff(this.module, name, args));
  }
  async block(index, bytes) {
    if (!bytes.length || bytes.length > MAX_BLOCK_BYTES) throw new RangeError("TIFF export block exceeds 32 MiB.");
    if (bytes.length > this.capacity) {
      this.module._free(this.pointer);
      this.pointer = this.module._malloc(bytes.length);
      this.capacity = this.pointer ? bytes.length : 0;
      if (!this.pointer) throw new Error("TIFF export memory reservation failed.");
    }
    this.module.HEAPU8.set(bytes, this.pointer);
    await this.call("ne_tiff_write_block", [index, this.pointer, bytes.length]);
  }
  async finish() {
    await this.call("ne_tiff_write_finish");
    return this.module.io.blob();
  }
  close() {
    this.module._free(this.pointer);
    this.pointer = 0;
    this.module._hyve_close();
  }
}
