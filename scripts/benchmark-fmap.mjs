import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { ChunkCacheDataSource } from "../src/core/data-source.js";

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

const offsets = deterministicOffsets(PROBE_COUNT);
const results = {
  disclaimer: "Synthetic pager microbenchmark; this is not a mobile or end-to-end viewer performance claim.",
  config: { logicalBytes: LOGICAL_SIZE, pageBytes: PAGE_SIZE, poolBytes: POOL_BYTES, probes: PROBE_COUNT },
  current: await benchmarkCurrent(offsets),
  fmap: await benchmarkFmap(offsets)
};

console.log(JSON.stringify(results, null, 2));
