// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

let bytes;
beforeAll(() => { bytes = readFileSync(resolve("wasm/fmap/pkg/fmap_core.wasm")); });

async function createCore() {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const core = instance.exports;
  expect(core.fmap_init(4096, 4)).toBe(0);
  return core;
}

function randomGenerator(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
}

function assertMapping(core, { start, length, offset, id }) {
  expect(core.fmap_lookup_mapping(start)).toBe(id);
  expect(core.fmap_lookup_mapping(start + length - 1n)).toBe(id);
  expect(core.fmap_mapping_start(id)).toBe(start);
  expect(core.fmap_mapping_end(id)).toBe(start + length);
  expect(core.fmap_mapping_file_offset(id)).toBe(offset);
}

describe("C sparse Maple-style mapping index", () => {
  test("stores sparse u64 ranges independently of resident bytes and preserves exact boundaries", async () => {
    const core = await createCore();
    const first = { start: 0n, length: 3n, offset: (4n << 30n) + 11n, id: 1n };
    const second = { start: (1n << 50n), length: 12345n, offset: 37n, id: (1n << 48n) };
    for (const item of [first, second]) {
      expect(core.fmap_map_region(item.start, item.length, item.offset, item.id)).toBe(0);
      assertMapping(core, item);
      expect(core.fmap_lookup_mapping(item.start + item.length)).toBe(0n);
    }
    expect(core.fmap_mapping_count()).toBe(2);
    expect(core.fmap_mapping_bytes()).toBeLessThan(16 * 1024);
    expect(core.fmap_resident_bytes()).toBe(16 * 1024);
    expect(core.fmap_map_region(3n, 10n, 0n, 2n)).toBe(0);
    expect(core.fmap_lookup_mapping(3n)).toBe(2n);
    expect(core.fmap_unmap_region(1n)).toBe(0);
    expect(core.fmap_lookup_mapping(2n)).toBe(0n);
    expect(core.fmap_lookup_mapping(3n)).toBe(2n);
  });

  test("rejects overlap, duplicate handles and overflow without altering published mappings", async () => {
    const core = await createCore();
    expect(core.fmap_map_region(100n, 100n, 500n, 7n)).toBe(0);
    for (const [start, length, offset, id] of [
      [99n, 2n, 0n, 8n], [150n, 1n, 0n, 8n], [199n, 2n, 0n, 8n],
      [0n, 300n, 0n, 8n], [300n, 1n, 0n, 7n], [300n, 0n, 0n, 8n],
      [300n, 1n, 0n, 0n], [(1n << 64n) - 1n, 1n, 0n, 8n],
      [300n, 2n, (1n << 64n) - 1n, 8n]
    ]) expect(core.fmap_map_region(start, length, offset, id)).toBeLessThan(0);
    assertMapping(core, { start: 100n, length: 100n, offset: 500n, id: 7n });
    expect(core.fmap_mapping_count()).toBe(1);
    expect(core.fmap_unmap_region(999n)).toBeLessThan(0);
    expect(core.fmap_mapping_count()).toBe(1);
  });

  test("matches an interval oracle through split, merge, rotation and ID-hash churn", async () => {
    const core = await createCore();
    const random = randomGenerator(0xc0ffee);
    const live = new Map();
    let nextId = 1n;
    const insert = (slot) => {
      const item = { start: (1n << 33n) + BigInt(slot) * 8192n,
        length: BigInt((random() % 4096) + 1), offset: BigInt(random()) * 7n, id: nextId++ };
      expect(core.fmap_map_region(item.start, item.length, item.offset, item.id)).toBe(0);
      live.set(slot, item);
    };
    for (let slot = 0; slot < 2400; slot += 1) insert(slot);
    for (let operation = 0; operation < 12000; operation += 1) {
      const slot = random() % 3000;
      const item = live.get(slot);
      if (item) {
        assertMapping(core, item);
        expect(core.fmap_lookup_mapping(item.start + item.length)).toBe(0n);
        if (random() & 1) {
          expect(core.fmap_unmap_region(item.id)).toBe(0);
          live.delete(slot);
          expect(core.fmap_lookup_mapping(item.start)).toBe(0n);
          expect(core.fmap_mapping_end(item.id)).toBe(0n);
        }
      } else insert(slot);
      if (operation % 200 === 0) expect(core.fmap_mapping_count()).toBe(live.size);
    }
    for (const item of live.values()) assertMapping(core, item);
    const shuffled = [...live.values()].sort(() => (random() & 1) ? 1 : -1);
    for (const item of shuffled) expect(core.fmap_unmap_region(item.id)).toBe(0);
    expect(core.fmap_mapping_count()).toBe(0);
    expect(core.fmap_lookup_mapping(1n << 33n)).toBe(0n);
    expect(core.fmap_mapping_bytes()).toBeLessThan(1024 * 1024);
  });

  test("reuses mapping storage and keeps cache eviction separate from mapping lifetime", async () => {
    const core = await createCore();
    let firstBytes;
    for (let round = 0; round < 3; round += 1) {
      for (let slot = 0; slot < 1600; slot += 1) {
        expect(core.fmap_map_region(BigInt(slot * 4096), 4096n, BigInt(slot * 4096), BigInt(slot + 1))).toBe(0);
      }
      const before = core.fmap_mapping_bytes();
      expect(core.fmap_reset()).toBe(0);
      expect(core.fmap_lookup_mapping(4096n)).toBe(2n);
      for (let slot = 0; slot < 1600; slot += 1) expect(core.fmap_unmap_region(BigInt(slot + 1))).toBe(0);
      expect(core.fmap_mapping_bytes()).toBe(before);
      if (round === 0) firstBytes = before;
      else expect(before).toBe(firstBytes);
    }
    expect(core.fmap_map_region(0n, 100n, 0n, 1n)).toBe(0);
    core.fmap_mapping_reset();
    expect(core.fmap_lookup_mapping(0n)).toBe(0n);
    expect(core.fmap_mapping_bytes()).toBe(0);
    expect(core.fmap_map_region(0n, 100n, 0n, 1n)).toBe(0);
    expect(core.fmap_init(8192, 8)).toBe(0);
    expect(core.fmap_mapping_count()).toBe(0);
    expect(core.fmap_lookup_mapping(0n)).toBe(0n);
  });

  test("growing mapping metadata leaves occupied cache bytes and pointers intact", async () => {
    const core = await createCore();
    const slot = core.fmap_acquire_page(123n);
    const pointer = core.fmap_slot_ptr(slot);
    new Uint8Array(core.memory.buffer, pointer, 4096).fill(0x6d);
    expect(core.fmap_commit_page(slot, 4096)).toBe(0);
    for (let index = 0; index < 3000; index += 1) {
      expect(core.fmap_map_region(BigInt(index * 8192), 1000n, 0n, BigInt(index + 1))).toBe(0);
    }
    expect(core.fmap_slot_ptr(slot)).toBe(pointer);
    expect(new Uint8Array(core.memory.buffer, pointer, 4096).every((value) => value === 0x6d)).toBe(true);
    expect(core.fmap_range_valid(slot, 0, 4096)).toBe(1);
    expect(core.fmap_release_page(slot)).toBe(0);
  });
});
