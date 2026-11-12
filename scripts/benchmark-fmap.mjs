import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { ChunkCacheDataSource } from "../src/core/data-source.js";
import { readBandWindow, readBandWindowBIP } from "../src/core/raster-io.js";
import { EnviDataSource } from "../src/io/envi-data-source.js";
import { readSpectrumAtPixel } from "../src/render/spectrum-data.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const PAGE_SIZE = 256 * 1024;
const POOL_BYTES = 16 * MIB;
const LOGICAL_SIZE = 8 * GIB;
const PROBE_COUNT = 256;

class SyntheticSparseSource {
  constructor(size) {
    this.size = size;
    this.bytesRead = 0;
    this.readCalls = 0;
  }

  async read(offset, length) {
    const count = Math.max(0, Math.min(length, this.size - offset));
    const bytes = new Uint8Array(count);
    for (let index = 0; index < count; index += 1) {
      bytes[index] = (offset + index) & 0xff;
    }
    this.bytesRead += count;
    this.readCalls += 1;
    return bytes;
  }

  close() {}
}

class SyntheticFloat32Source {
  constructor(size, headerOffset) {
    this.size = size;
    this.headerOffset = headerOffset;
    this.bytesRead = 0;
    this.readCalls = 0;
  }

  async read(offset, length) {
    const count = Math.max(0, Math.min(length, this.size - offset));
    const bytes = new Uint8Array(count);
    const view = new DataView(bytes.buffer);
    const scratch = new DataView(new ArrayBuffer(4));
    let byte = 0;
    let relative = offset - this.headerOffset;
    const copyValueByte = () => {
      const valueIndex = Math.floor(relative / 4);
      const valueByte = ((relative % 4) + 4) % 4;
      scratch.setFloat32(0, deterministicValue(valueIndex), true);
      bytes[byte] = scratch.getUint8(valueByte);
      byte += 1;
      relative += 1;
    };
    while (byte < count && (((relative % 4) + 4) % 4) !== 0) copyValueByte();
    while (byte + 4 <= count) {
      view.setFloat32(byte, deterministicValue(relative / 4), true);
      byte += 4;
      relative += 4;
    }
    while (byte < count) copyValueByte();
    this.bytesRead += count;
    this.readCalls += 1;
    return bytes;
  }

  close() {}
}

function deterministicValue(valueIndex) {
  return ((valueIndex % 2001) - 1000) / 8;
}

function deterministicOffsets(count) {
  let state = 0x51f15e;
  return Array.from({ length: count }, (_, index) => {
    state = ((state * 1664525) + 1013904223) >>> 0;
    if (index === 0) return (5 * GIB) + 37;
    return ((state * 4096) % (LOGICAL_SIZE - 4));
  });
}

function expectedByte(offset) {
  return offset & 0xff;
}

async function timeRun(name, operation) {
  const started = performance.now();
  const result = await operation();
  return { name, elapsedMs: Number((performance.now() - started).toFixed(2)), ...result };
}

async function benchmarkCurrent(offsets) {
  const base = new SyntheticSparseSource(LOGICAL_SIZE);
  const cache = new ChunkCacheDataSource(base, {
    chunkSize: PAGE_SIZE,
    maxBytes: POOL_BYTES,
    concurrency: 2
  });
  const readPass = async () => {
    let checksum = 0;
    for (const offset of offsets) {
      const bytes = await cache.read(offset, 4);
      if (bytes.length !== 4 || bytes[0] !== expectedByte(offset)) throw new Error(`Current backend mismatch at ${offset}`);
      checksum = (checksum + bytes[0]) >>> 0;
    }
    return checksum;
  };
  const cold = await timeRun("current-cold", async () => ({ checksum: await readPass() }));
  const afterCold = base.bytesRead;
  const warm = await timeRun("current-warm", async () => ({ checksum: await readPass() }));
  return {
    cold,
    warm,
    browserBytesCold: afterCold,
    browserBytesWarm: base.bytesRead - afterCold,
    readCalls: base.readCalls,
    residentBytes: cache.cacheBytes(),
    hits: cache.stats.cacheHits,
    misses: cache.stats.cacheMisses,
    evictions: cache.stats.cacheEvictions
  };
}

async function benchmarkFmap(offsets) {
  const moduleBytes = await readFile(new URL("../wasm/fmap/pkg/fmap_core.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(moduleBytes, {});
  const wasm = instance.exports;
  const slotCount = Math.floor(POOL_BYTES / PAGE_SIZE);
  if (wasm.fmap_init(PAGE_SIZE, slotCount) !== 0) throw new Error("Unable to initialize fmap benchmark pool");
  const base = new SyntheticSparseSource(LOGICAL_SIZE);

  const readPass = async () => {
    let checksum = 0;
    for (const offset of offsets) {
      const pageIndex = Math.floor(offset / PAGE_SIZE);
      const inPage = offset - (pageIndex * PAGE_SIZE);
      const slot = wasm.fmap_acquire_page(BigInt(pageIndex));
      if (slot < 0) throw new Error(`Unable to acquire fmap page ${pageIndex}`);
      try {
        if (wasm.fmap_slot_valid_bytes(slot) === 0) {
          const pageOffset = pageIndex * PAGE_SIZE;
          const bytes = await base.read(pageOffset, Math.min(PAGE_SIZE, LOGICAL_SIZE - pageOffset));
          new Uint8Array(wasm.memory.buffer, wasm.fmap_slot_ptr(slot), PAGE_SIZE).set(bytes);
          if (wasm.fmap_commit_page(slot, bytes.length) !== 0) throw new Error(`Unable to commit fmap page ${pageIndex}`);
        }
        const value = new Uint8Array(wasm.memory.buffer, wasm.fmap_slot_ptr(slot) + inPage, 4);
        if (value.length !== 4 || value[0] !== expectedByte(offset)) throw new Error(`fmap mismatch at ${offset}`);
        checksum = (checksum + value[0]) >>> 0;
      } finally {
        wasm.fmap_release_page(slot);
      }
    }
    return checksum;
  };

  const cold = await timeRun("fmap-cold", async () => ({ checksum: await readPass() }));
  const afterCold = base.bytesRead;
  const warm = await timeRun("fmap-warm", async () => ({ checksum: await readPass() }));
  return {
    cold,
    warm,
    browserBytesCold: afterCold,
    browserBytesWarm: base.bytesRead - afterCold,
    readCalls: base.readCalls,
    residentBytes: wasm.fmap_resident_bytes(),
    hits: Number(wasm.fmap_hits()),
    misses: Number(wasm.fmap_misses()),
    evictions: Number(wasm.fmap_evictions())
  };
}

function enviOffset(meta, x, y, band) {
  const { samples, lines, bands, headerOffset } = meta;
  if (meta.interleave === "bsq") return headerOffset + (((band * lines + y) * samples + x) * 4);
  if (meta.interleave === "bil") return headerOffset + ((((y * bands + band) * samples + x) * 4));
  return headerOffset + ((((y * samples + x) * bands + band) * 4));
}

function expectedAt(meta, x, y, band) {
  return deterministicValue((enviOffset(meta, x, y, band) - meta.headerOffset) / 4);
}

async function benchmarkEnviBaseline(interleave) {
  const meta = {
    samples: 2048,
    lines: 2048,
    bands: 16,
    headerOffset: (5 * GIB) + 13,
    interleave,
    littleEndian: true,
    dataType: 4,
    dataTypeInfo: { bytes: 4, ctor: Float32Array, dv: "getFloat32" }
  };
  const size = meta.headerOffset + (meta.samples * meta.lines * meta.bands * 4);
  const base = new SyntheticFloat32Source(size, meta.headerOffset);
  const cache = new ChunkCacheDataSource(base, { chunkSize: PAGE_SIZE, maxBytes: POOL_BYTES, concurrency: 2 });
  const source = new EnviDataSource(cache, meta);
  const readWindow = interleave === "bip" ? readBandWindowBIP : readBandWindow;
  const started = performance.now();
  let checksum = 0;

  for (let index = 0; index < 8; index += 1) {
    const x = 17 + (index * 19);
    const y = 21 + (index * 13);
    const output = await readWindow(meta, source, index % meta.bands, x, y, 64, 48, 2, 2);
    const expected = expectedAt(meta, x, y, index % meta.bands);
    if (output[0] !== expected) throw new Error(`${interleave} viewport mismatch at ${x},${y}`);
    checksum += output[0] + output[output.length - 1];
  }

  const spectrum = await readSpectrumAtPixel({ meta, ds: source }, 33, 44, 2);
  for (let band = 0; band < meta.bands; band += 1) {
    if (spectrum[band] !== expectedAt(meta, 33, 44, band)) throw new Error(`${interleave} spectrum mismatch at band ${band}`);
    checksum += spectrum[band];
  }

  for (let band = 0; band < meta.bands; band += 1) {
    const area = await readWindow(meta, source, band, 101, 91, 32, 32, 4, 2);
    checksum += area.reduce((sum, value) => sum + value, 0);
  }

  return {
    elapsedMs: Number((performance.now() - started).toFixed(2)),
    checksum: Number(checksum.toFixed(3)),
    browserBytes: base.bytesRead,
    readCalls: base.readCalls,
    residentBytes: cache.cacheBytes(),
    hits: cache.stats.cacheHits,
    misses: cache.stats.cacheMisses,
    evictions: cache.stats.cacheEvictions
  };
}

async function benchmarkTiffRangePatterns() {
  const run = async (name, ranges) => {
    const base = new SyntheticSparseSource(LOGICAL_SIZE);
    const cache = new ChunkCacheDataSource(base, { chunkSize: PAGE_SIZE, maxBytes: POOL_BYTES, concurrency: 2 });
    const started = performance.now();
    let checksum = 0;
    for (const [offset, length] of ranges) {
      const bytes = await cache.read(offset, length);
      checksum = (checksum + bytes[0] + bytes[bytes.length - 1]) >>> 0;
    }
    return {
      name,
      elapsedMs: Number((performance.now() - started).toFixed(2)),
      checksum,
      browserBytes: base.bytesRead,
      residentBytes: cache.cacheBytes()
    };
  };
  const tiles = Array.from({ length: 32 }, (_, index) => [((5 * GIB) + (index * 512 * 1024)), 64 * 1024]);
  const strips = Array.from({ length: 8 }, (_, index) => [((5 * GIB) + (index * 8 * MIB)), MIB]);
  return { tiles: await run("tiff-tile-ranges", tiles), strips: await run("tiff-strip-ranges", strips) };
}

const offsets = deterministicOffsets(PROBE_COUNT);
const results = {
  disclaimer: "Synthetic pager microbenchmark; this is not a mobile or end-to-end viewer performance claim.",
  config: { logicalBytes: LOGICAL_SIZE, pageBytes: PAGE_SIZE, poolBytes: POOL_BYTES, probes: PROBE_COUNT },
  currentEnviBaselines: {
    bsq: await benchmarkEnviBaseline("bsq"),
    bil: await benchmarkEnviBaseline("bil"),
    bip: await benchmarkEnviBaseline("bip")
  },
  currentTiffRangeBaselines: await benchmarkTiffRangePatterns(),
  current: await benchmarkCurrent(offsets),
  fmap: await benchmarkFmap(offsets)
};

console.log(JSON.stringify(results, null, 2));
