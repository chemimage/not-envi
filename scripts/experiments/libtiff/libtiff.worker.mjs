let module, io;
const PAGE = 256 * 1024;

class FileIO {
  constructor(file, cacheBytes = 64 * 1024 * 1024, exact = false) {
    this.file = file; this.size = file.size; this.limit = cacheBytes; this.exact = exact;
    this.reader = new FileReaderSync(); this.pages = new Map(); this.bytes = 0;
    this.resetStats();
  }
  resetStats() { this.stats = { readRequests: 0, requestedBytes: 0, fileReads: 0, browserBytes: 0, copyBytes: 0, cacheHits: 0, readMs: 0 }; }
  fetch(offset, count) {
    const start = performance.now();
    const result = new Uint8Array(this.reader.readAsArrayBuffer(this.file.slice(offset, offset + count)));
    this.stats.readMs += performance.now() - start;
    this.stats.fileReads++; this.stats.browserBytes += result.length;
    return result;
  }
  read(offset, count) {
    if (!Number.isSafeInteger(offset) || offset < 0 || count < 0 || count > 32 * 1024 * 1024) throw new Error("Invalid bounded read");
    this.stats.readRequests++;
    count = Math.max(0, Math.min(count, this.size - offset)); this.stats.requestedBytes += count; this.stats.copyBytes += count;
    if (this.exact) return this.fetch(offset, count);
    const output = new Uint8Array(count);
    for (let written = 0; written < count;) {
      const at = offset + written, index = Math.floor(at / PAGE), base = index * PAGE;
      let page = this.pages.get(index);
      if (page) { this.pages.delete(index); this.stats.cacheHits++; }
      else {
        page = this.fetch(base, Math.min(PAGE, this.size - base)); this.bytes += page.length;
        while (this.pages.size && this.bytes > this.limit) {
          const oldest = this.pages.keys().next().value;
          this.bytes -= this.pages.get(oldest).length; this.pages.delete(oldest);
        }
      }
      this.pages.set(index, page);
      const take = Math.min(count - written, page.length - (at - base));
      if (take <= 0) throw new Error("Short input");
      output.set(page.subarray(at - base, at - base + take), written); this.stats.copyBytes += take;
      written += take;
    }
    return output;
  }
  clear() { this.pages.clear(); this.bytes = 0; this.resetStats(); }
}

class MemoryWriter {
  constructor() { this.bytes = new Uint8Array(1024 * 1024); this.size = 0; }
  read(offset, count) { return this.bytes.subarray(offset, Math.min(this.size, offset + count)); }
  write(offset, input) {
    const end = offset + input.length;
    if (end > 32 * 1024 * 1024) throw new Error("Fixture exceeds 32 MiB");
    if (end > this.bytes.length) {
      const next = new Uint8Array(Math.max(end, this.bytes.length * 2)); next.set(this.bytes); this.bytes = next;
    }
    this.bytes.set(input, offset); this.size = Math.max(this.size, end); return input.length;
  }
}

function metadata() {
  const fields = ["width", "height", "samples", "bits", "compression", "tiled", "blockWidth", "blockHeight", "sampleFormat", "heapCapacity", "decodedCacheBytes", "decodeCalls", "subIfds"];
  return Object.fromEntries(fields.map((key, i) => [key, module._probe_info(i)]));
}
function requireSuccess(value) {
  if (value <= 0) throw new Error(module.UTF8ToString(module._probe_error()) || io.error || "libtiff operation failed");
  return value;
}
function stats() { return { ...io.stats, ioCacheBytes: io.bytes || 0, ...metadata() }; }

async function handle(message) {
  if (message.type === "jsCodec") {
    const { decodeBoundedTiffBlockDirect } = await import('/probe/baseline-codecs.mjs');
    const times = []; let output;
    for (let batch=0; batch<12; batch++) {
      const start=performance.now();
      for (let i=0;i<512;i++) output=decodeBoundedTiffBlockDirect(message.directory,message.bytes,message.expected,{littleEndian:true});
      times.push((performance.now()-start)/512);
    }
    return { times, bytes: output };
  }
  if (message.type === "init") {
    const create = (await import(`/probe/libtiff-${message.variant || "reader"}.mjs`)).default;
    const start = performance.now();
    module = await create({ locateFile: (name) => `/probe/${name}`, printErr: (text) => { self.lastLibtiffLog = text; } });
    return { initMs: performance.now() - start, heapCapacity: module.HEAPU8.length };
  }
  if (message.type === "make") {
    io = new MemoryWriter(); module.io = io;
    requireSuccess(module._probe_fixture(message.codec, message.predictor || 1, message.float ? 1 : 0,
      message.channels || 1, message.tiled === false ? 0 : 1, message.pyramid || 0, message.noise ? 1 : 0));
    return { bytes: io.bytes.slice(0, io.size).buffer };
  }
  if (message.type === "open") {
    module._probe_close(); io = new FileIO(message.file, message.cacheBytes, message.exact); module.io = io;
    const start = performance.now(); requireSuccess(module._probe_open());
    return { ...metadata(), openMs: performance.now() - start, stats: stats() };
  }
  if (message.type === "directory") {
    const start = performance.now(); requireSuccess(module._probe_directory(message.level));
    return { ...metadata(), selectMs: performance.now() - start };
  }
  if (message.type === "clear") {
    module._probe_close(); io.clear(); requireSuccess(module._probe_open()); io.resetStats(); return stats();
  }
  if (message.type === "stats") return stats();
  if (message.type === "resetStats") { io.resetStats(); return stats(); }
  if (message.type === "window") {
    const start = performance.now();
    const count = requireSuccess(module._probe_window(message.x, message.y, message.w, message.h, message.step || 1));
    const computeMs = performance.now() - start;
    const at = module._probe_output(), bytes = module.HEAPU8.slice(at, at + count);
    return { bytes: bytes.buffer, computeMs, stats: stats() };
  }
  if (message.type === "block") {
    const offset = module._probe_block_offset(message.index), length = module._probe_block_bytes(message.index);
    const bytes = io.read(offset, length);
    return { bytes: bytes.buffer, decodedBytes: module._probe_block_size(), meta: metadata(), offset, length };
  }
  if (message.type === "codec") {
    const input = new Uint8Array(message.bytes), ptr = module._malloc(input.length);
    if (!ptr) throw new Error("Input allocation failed");
    try {
      module.HEAPU8.set(input, ptr);
      const times = [];
      let count;
      for (let batch = 0; batch < 12; batch++) {
        const start = performance.now();
        for (let i = 0; i < 512; i++) count = requireSuccess(module._probe_decode_user(0, ptr, input.length));
        times.push((performance.now() - start) / 512);
      }
      const at = module._probe_output();
      return { times, bytes: module.HEAPU8.slice(at, at + count).buffer, stats: stats() };
    } finally { module._free(ptr); }
  }
  if (message.type === "close") { module._probe_close(); io?.clear(); return {}; }
  throw new Error(`Unknown operation ${message.type}`);
}

let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      const result = await handle(data);
      self.postMessage({ id: data.id, result }, result.bytes instanceof ArrayBuffer ? [result.bytes] : []);
    } catch (error) { self.postMessage({ id: data.id, error: String(error.stack || error) }); }
  });
};

