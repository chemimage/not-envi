// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const wasm = readFileSync("wasm/fmap/pkg/fmap_core.wasm");

async function fixture({ slots = 2, concurrency = 2, count = 4, bytes = 8192, size = 32768n } = {}) {
  const { instance } = await WebAssembly.instantiate(wasm, {});
  const c = instance.exports;
  expect(c.fmap_init(4096, slots)).toBe(0);
  expect(c.fmap_fill_init(size, concurrency, count, bytes)).toBe(0);
  const submit = (page, offset = 0, length = 16, grain = 0, priority = 0) =>
    c.fmap_fill_submit(BigInt(page), offset, length, grain, priority);
  const poll = () => {
    const ptr = c.fmap_fill_poll();
    if (!ptr) return null;
    const view = new DataView(c.memory.buffer, ptr, 24);
    return { id: view.getUint32(0, true), slot: view.getUint32(4, true),
      start: view.getUint32(8, true), length: view.getUint32(12, true), offset: view.getBigUint64(16, true) };
  };
  const events = () => {
    const result = [];
    let ptr;
    while ((ptr = c.fmap_fill_event())) {
      const view = new DataView(c.memory.buffer, ptr, 24);
      result.push({ id: view.getUint32(0, true), slot: view.getUint32(4, true),
        offset: view.getUint32(8, true), length: view.getUint32(12, true),
        error: view.getInt32(16, true), failureId: view.getUint32(20, true) });
    }
    return result;
  };
  const complete = (command, value = 77) => {
    const ptr = c.fmap_fill_prepare(command.id);
    if (ptr) new Uint8Array(c.memory.buffer, ptr, command.length).fill(value);
    c.fmap_fill_complete(command.id, ptr ? 1 : 0);
    return ptr;
  };
  const stat = (i) => Number(c.fmap_fill_stat(i));
  return { c, submit, poll, events, complete, stat };
}

test("C merges shared demands and transfers separate pins to opaque leases", async () => {
  const h = await fixture();
  const first = h.submit(0, 16, 32), second = h.submit(0, 32, 32);
  const read = h.poll();
  expect(read).toMatchObject({ offset: 16n, length: 48 });
  expect(h.poll()).toBeNull();
  expect(h.complete(read)).toBeGreaterThan(0);
  expect(h.events().sort((a, b) => a.id - b.id)).toEqual([
    { id: first, slot: read.slot, offset: 16, length: 32, error: 0, failureId: 0 },
    { id: second, slot: read.slot, offset: 32, length: 32, error: 0, failureId: 0 }
  ]);
  expect(h.c.fmap_slot_pin_count(read.slot)).toBe(2);
  h.c.fmap_fill_release(first); h.c.fmap_fill_release(first);
  expect(h.c.fmap_slot_pin_count(read.slot)).toBe(1);
  h.c.fmap_fill_complete(read.id, 1);
  expect(h.c.fmap_slot_pin_count(read.slot)).toBe(1);
  h.c.fmap_fill_release(second);
  expect(h.c.fmap_pinned_bytes()).toBe(0);
  expect(h.stat(19)).toBe(0);
});

test("clear retains provider charges and rejects stale writes and releases into reused slots", async () => {
  const h = await fixture({ slots: 1 });
  const delivered = h.submit(0);
  const warm = h.poll(); h.complete(warm); h.events();
  const pending = h.submit(0, 64);
  const old = h.poll();
  expect(h.c.fmap_init(4096, 1)).toBe(-6);
  expect(h.c.fmap_reset()).toBe(-6);
  h.c.fmap_fill_clear();
  expect(h.events()).toEqual([{ id: pending, slot: 0, offset: 64, length: 16, error: -9, failureId: 0 }]);
  expect(h.stat(12)).toBe(1);
  expect(h.stat(13)).toBe(16);
  const freshId = h.submit(1), fresh = h.poll();
  expect(fresh.slot).toBe(old.slot);
  h.complete(fresh, 99); h.events();
  h.c.fmap_fill_release(delivered);
  expect(h.c.fmap_slot_pin_count(fresh.slot)).toBe(1);
  expect(h.complete(old, 42)).toBe(0);
  expect(h.c.fmap_slot_pin_count(fresh.slot)).toBe(1);
  expect(Array.from(new Uint8Array(h.c.memory.buffer, h.c.fmap_slot_ptr(fresh.slot), 16))).toEqual(Array(16).fill(99));
  expect(h.stat(12)).toBe(0);
  expect(h.stat(13)).toBe(0);
  h.c.fmap_fill_release(freshId);
  expect(h.stat(19)).toBe(0);
});

test("mapping growth and reset cannot overwrite live fill state or delivered leases", async () => {
  const h = await fixture();
  const held = h.submit(0), active = h.poll();
  const oldBuffer = h.c.memory.buffer;
  for (let id = 1n; id <= 1000n; id++) expect(h.c.fmap_map_region(id * 8192n, 4096n, 0n, id)).toBe(0);
  expect(h.c.memory.buffer).not.toBe(oldBuffer);
  h.c.fmap_mapping_reset();
  for (let id = 1n; id <= 1000n; id++) expect(h.c.fmap_map_region(id * 8192n, 4096n, 0n, id)).toBe(0);
  h.complete(active, 101);
  expect(h.events()).toMatchObject([{ id: held, error: 0 }]);
  h.c.fmap_mapping_reset();
  expect(h.c.fmap_map_region(0n, 4096n, 0n, 1n)).toBe(0);
  expect(h.c.fmap_slot_pin_count(active.slot)).toBe(1);
  expect(new Uint8Array(h.c.memory.buffer, h.c.fmap_slot_ptr(active.slot), 1)[0]).toBe(101);
  h.c.fmap_fill_release(held);
  expect(h.c.fmap_pinned_bytes()).toBe(0);
});

test("an all-pinned new page cannot block filling another range of a pinned resident page", async () => {
  const h = await fixture({ slots: 1 });
  const lease = h.submit(0); h.complete(h.poll()); h.events();
  const blocked = h.submit(1, 0, 16, 0, 0);
  const resident = h.submit(0, 64, 16, 0, 1);
  const read = h.poll();
  expect(read).toMatchObject({ offset: 64n, length: 16 });
  h.complete(read);
  expect(h.events()).toMatchObject([{ id: resident, error: 0 }]);
  h.c.fmap_fill_release(resident); h.c.fmap_fill_release(lease);
  expect(h.poll()).toMatchObject({ offset: 4096n, length: 16 });
  h.c.fmap_fill_cancel(blocked); h.events(); h.c.fmap_fill_clear();
});

test("failure rejects all admitted consumers with its fill identity and permits retry", async () => {
  const h = await fixture();
  const a = h.submit(0), b = h.submit(0);
  const read = h.poll(); h.c.fmap_fill_complete(read.id, 0);
  const errors = h.events().sort((x, y) => x.id - y.id);
  expect(errors.map(e => [e.id, e.error, e.failureId])).toEqual([[a, -10, read.id], [b, -10, read.id]]);
  expect(h.stat(4)).toBe(1);
  expect(h.c.fmap_pinned_bytes()).toBe(0);
  const retry = h.submit(0); h.complete(h.poll());
  expect(h.events()).toMatchObject([{ id: retry, error: 0 }]);
  h.c.fmap_fill_release(retry);
});

test("C bounds admission while parked metadata is reused at its high water mark", async () => {
  const h = await fixture({ count: 1, bytes: 16, size: 4096n * 256n });
  const round = () => {
    const ids = Array.from({ length: 100 }, (_, page) => h.submit(page));
    expect(h.stat(14)).toBe(1); expect(h.stat(15)).toBe(16); expect(h.stat(16)).toBe(99);
    for (const id of ids) h.c.fmap_fill_cancel(id);
    expect(h.events()).toHaveLength(100);
    expect(h.poll()).toBeNull();
    expect(h.stat(19)).toBe(0);
    return h.stat(18);
  };
  const before = round(), after = round();
  expect(before).toBeGreaterThan(0); expect(after).toBe(before);
  expect(h.stat(20)).toBe(100);
});

test("C preserves exact u64 file offsets and validates overflow/EOF independently of JS", async () => {
  const size = 0xffffffffffffffffn;
  const h = await fixture({ size });
  const page = size / 4096n;
  const id = h.submit(page, 4094, 1);
  const read = h.poll();
  expect(read.offset).toBe(size - 1n);
  expect(h.submit(page, 4095, 1)).toBe(-5);
  expect(h.submit(page + 1n)).toBe(-5);
  expect(h.submit(0, 0, 0)).toBe(-4);
  expect(h.submit(0, 4096, 1)).toBe(-4);
  expect(h.submit(0, 0, 16, 4097)).toBe(-4);
  h.complete(read); h.events(); h.c.fmap_fill_release(id);
});

test("old demand IDs cannot release a lease after an idle pool reinitialization", async () => {
  const h = await fixture();
  const old = h.submit(0); h.complete(h.poll()); h.events(); h.c.fmap_fill_release(old);
  expect(h.c.fmap_init(4096, 2)).toBe(0);
  expect(h.c.fmap_fill_init(32768n, 2, 4, 8192)).toBe(0);
  const fresh = h.submit(0); h.complete(h.poll()); h.events();
  expect(fresh).not.toBe(old);
  h.c.fmap_fill_release(old);
  expect(h.c.fmap_pinned_bytes()).toBe(4096);
  h.c.fmap_fill_release(fresh);
});
