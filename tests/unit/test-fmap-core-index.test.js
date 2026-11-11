// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

let wasm;
beforeAll(() => { wasm = readFileSync(resolve("wasm/fmap/pkg/fmap_core.wasm")); });

async function coreWithSlots(slots, pageSize = 32) {
  const { instance } = await WebAssembly.instantiate(wasm, {});
  expect(instance.exports.fmap_init(pageSize, slots)).toBe(0);
  return instance.exports;
}

function randomGenerator(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
}

function mix64(value) {
  const u64 = (key) => BigInt.asUintN(64, key);
  value ^= value >> 33n;
  value = u64(value * 0xff51afd7ed558ccdn);
  value ^= value >> 33n;
  value = u64(value * 0xc4ceb9fe1a85ec53n);
  value ^= value >> 33n;
  return Number(BigInt.asUintN(32, value));
}

describe("C resident-page index", () => {
  test("indexes page zero and complete u64 identities, preserving pinned and sparse validity semantics", async () => {
    const core = await coreWithSlots(4);
    const pages = [0n, 1n << 32n, 1n << 63n, (1n << 64n) - 1n];
    const slots = pages.map((page) => core.fmap_acquire_page(page));
    for (let index = 0; index < pages.length; index += 1) {
      expect(core.fmap_find_page(pages[index])).toBe(slots[index]);
      expect(BigInt.asUintN(64, core.fmap_slot_page(slots[index]))).toBe(pages[index]);
      expect(core.fmap_commit_range(slots[index], index, 1)).toBe(0);
      expect(core.fmap_range_valid(slots[index], index, 1)).toBe(1);
      expect(core.fmap_range_valid(slots[index], index + 1, 1)).toBe(0);
    }
    expect(core.fmap_acquire_page(900n)).toBe(-2);
    expect(core.fmap_evict_page(0n)).toBe(-2);
    expect(core.fmap_find_page(0n)).toBe(slots[0]);
    expect(core.fmap_release_page(slots[0])).toBe(0);
    expect(core.fmap_acquire_page(900n)).toBe(slots[0]);
    expect(core.fmap_find_page(0n)).toBe(-1);
    expect(core.fmap_range_valid(slots[0], 0, 1)).toBe(0);
    expect(core.fmap_find_page(900n)).toBe(slots[0]);
    expect(core.fmap_find_page(1n)).toBe(-1);
  });

  test("backward-shift deletion preserves colliding probe chains through wraparound and churn", async () => {
    const core = await coreWithSlots(8);
    const capacity = core.fmap_page_index_capacity();
    expect(capacity).toBe(16);
    const pages = [];
    for (let page = 0n; pages.length < 500; page += 1n) {
      if ((mix64(page) & (capacity - 1)) === capacity - 2) pages.push(page);
    }
    const live = new Map();
    for (let index = 0; index < 8; index += 1) {
      const slot = core.fmap_acquire_page(pages[index]);
      expect(core.fmap_release_page(slot)).toBe(0);
      live.set(pages[index], slot);
    }
    for (let index = 8; index < pages.length; index += 1) {
      const victim = [...live.keys()][index % live.size];
      expect(core.fmap_evict_page(victim)).toBe(1);
      live.delete(victim);
      expect(core.fmap_find_page(victim)).toBe(-1);
      const slot = core.fmap_acquire_page(pages[index]);
      expect(core.fmap_release_page(slot)).toBe(0);
      live.set(pages[index], slot);
      for (const [page, expectedSlot] of live) expect(core.fmap_find_page(page)).toBe(expectedSlot);
      expect(core.fmap_page_index_last_probes()).toBeLessThanOrEqual(8);
    }
    expect(core.fmap_page_index_bytes()).toBe(16 * capacity);
  });

  test("matches a slot/pin/LRU oracle across randomized acquisition, eviction, reset and reinitialization", async () => {
    const core = await coreWithSlots(23);
    const random = randomGenerator(0xa51b42);
    let slots = new Array(23).fill(null), tick = 0;
    for (let operation = 0; operation < 6000; operation += 1) {
      const page = BigInt(random() % 80) + (BigInt(random() % 3) << 36n);
      const action = random() % 10;
      const found = slots.findIndex((slot) => slot?.page === page);
      if (action < 5) {
        let expected = found;
        if (expected < 0) {
          expected = slots.findIndex((slot) => slot == null);
          if (expected < 0) {
            let oldest = Infinity;
            for (let index = 0; index < slots.length; index += 1) {
              if (!slots[index].pins && slots[index].touch < oldest) {
                expected = index;
                oldest = slots[index].touch;
              }
            }
          }
        }
        expect(core.fmap_acquire_page(page)).toBe(expected < 0 ? -2 : expected);
        if (expected >= 0) {
          if (found < 0) slots[expected] = { page, pins: 0, touch: 0, valid: 0 };
          slots[expected].pins += 1;
          slots[expected].touch = ++tick;
        }
      } else if (action < 7) {
        const index = random() % slots.length;
        const slot = slots[index];
        expect(core.fmap_release_page(index)).toBe(slot?.pins ? 0 : -3);
        if (slot?.pins) { slot.pins -= 1; slot.touch = ++tick; }
      } else if (action === 7) {
        const expected = found < 0 ? 0 : (slots[found].pins ? -2 : 1);
        expect(core.fmap_evict_page(page)).toBe(expected);
        if (expected === 1) slots[found] = null;
      } else if (action === 8) {
        const index = random() % slots.length;
        const valid = random() % 33;
        expect(core.fmap_commit_page(index, valid)).toBe(slots[index] ? 0 : -3);
        if (slots[index]) { slots[index].valid = valid; slots[index].touch = ++tick; }
      } else expect(core.fmap_find_page(page)).toBe(found);

      if (operation === 2000) {
        expect(core.fmap_reset()).toBe(0);
        slots.fill(null); tick = 0;
        expect(core.fmap_page_index_lookups()).toBe(0n);
      } else if (operation === 4000) {
        expect(core.fmap_init(32, 11)).toBe(0);
        slots = new Array(11).fill(null); tick = 0;
      }
      if (operation % 53 === 0) {
        for (let index = 0; index < slots.length; index += 1) {
          const slot = slots[index];
          if (slot) {
            expect(core.fmap_find_page(slot.page)).toBe(index);
            expect(core.fmap_slot_valid_bytes(index)).toBe(slot.valid);
          }
        }
        expect(core.fmap_pinned_bytes()).toBe(slots.filter((slot) => slot?.pins).length * 32);
        expect(core.fmap_page_index_capacity()).toBeGreaterThanOrEqual(slots.length * 2);
      }
    }
  });

  test("lookup probes stay indexed as resident capacity grows and storage remains pool-bounded", async () => {
    for (const count of [64, 4096]) {
      const core = await coreWithSlots(count, 8);
      const slots = new Map();
      for (let index = 0; index < count; index += 1) {
        const page = BigInt(index) * ((1n << 32n) + 17n);
        const slot = core.fmap_acquire_page(page);
        slots.set(page, slot);
        expect(core.fmap_release_page(slot)).toBe(0);
      }
      const probesBefore = core.fmap_page_index_probes();
      const queriesBefore = core.fmap_page_index_lookups();
      for (const [page, slot] of slots) expect(core.fmap_find_page(page)).toBe(slot);
      for (let index = 0; index < count; index += 1) expect(core.fmap_find_page((1n << 60n) + BigInt(index))).toBe(-1);
      const probes = Number(core.fmap_page_index_probes() - probesBefore);
      const queries = Number(core.fmap_page_index_lookups() - queriesBefore);
      expect(queries).toBe(count * 2);
      expect(probes / queries).toBeLessThan(4);
      expect(core.fmap_page_index_peak_probes()).toBeLessThan(64);
      expect(core.fmap_page_index_capacity()).toBe(count * 2);
      expect(core.fmap_page_index_bytes()).toBe(count * 2 * 16);
    }
  });

  test("failed reinitialization preserves resident lookup and mapping metadata cannot overwrite the index", async () => {
    const core = await coreWithSlots(8);
    const slot = core.fmap_acquire_page(0n);
    expect(core.fmap_release_page(slot)).toBe(0);
    expect(core.fmap_init(0xffffffff, 0xffffffff)).toBe(-6);
    expect(core.fmap_find_page(0n)).toBe(slot);
    for (let index = 0; index < 2000; index += 1) {
      expect(core.fmap_map_region(BigInt(index * 8192), 4096n, 0n, BigInt(index + 1))).toBe(0);
    }
    expect(core.fmap_find_page(0n)).toBe(slot);
    expect(core.fmap_mapping_count()).toBe(2000);
    expect(core.fmap_reset()).toBe(0);
    expect(core.fmap_find_page(0n)).toBe(-1);
    expect(core.fmap_mapping_count()).toBe(2000);
    expect(core.fmap_acquire_page(0n)).toBe(0);
  });
});
