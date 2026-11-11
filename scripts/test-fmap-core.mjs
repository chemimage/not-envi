import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export async function testFmapCore(file = path.resolve("wasm/fmap/pkg/fmap_core.wasm")) {
  const bytes = readFileSync(file);
  const module = await WebAssembly.compile(bytes);
  assert.deepEqual(WebAssembly.Module.imports(module), [], "core has no host imports");
  const exportNames = new Set(WebAssembly.Module.exports(module).map(entry => entry.name));
  for (const name of [
    "memory",
    "fmap_init",
    "fmap_reset",
    "fmap_acquire_page",
    "fmap_commit_page",
    "fmap_release_page",
    "fmap_touch_page",
    "fmap_slot_ptr",
    "fmap_extract_f32",
    "fmap_extract_f32_le",
    "fmap_scratch_ptr",
    "fmap_scratch_capacity_bytes",
    "fmap_extract_scratch_f32"
  ]) {
    assert.ok(exportNames.has(name), `missing required ABI export ${name}`);
  }
  const { exports: wasm } = await WebAssembly.instantiate(module, {});
  const view = () => new DataView(wasm.memory.buffer);
  const output = count => new Float32Array(wasm.memory.buffer, wasm.fmap_output_ptr(), count);

  assert.equal(wasm.fmap_init(0, 2), -6, "reject zero-sized pages");
  assert.equal(wasm.fmap_init(64, 2), 0);
  assert.equal(wasm.fmap_page_size(), 64);
  assert.equal(wasm.fmap_slot_count(), 2);
  assert.equal(wasm.fmap_resident_bytes(), 128);
  assert.equal(wasm.fmap_scratch_capacity_bytes(), 64);
  assert.equal(wasm.fmap_output_capacity_f32(), 16);
  const memoryAfterInit = wasm.memory.buffer.byteLength;

  const highPage = 0x1_0000_0001n;
  const first = wasm.fmap_acquire_page(highPage);
  assert.equal(first, 0);
  assert.equal(wasm.fmap_slot_page(first), highPage, "preserve page IDs beyond 4 GiB");
  assert.equal(wasm.fmap_slot_pin_count(first), 1);
  assert.equal(wasm.fmap_pinned_bytes(), 64);
  assert.equal(wasm.fmap_acquire_page(highPage), first, "deduplicate resident page");
  assert.equal(wasm.fmap_slot_pin_count(first), 2);
  assert.equal(wasm.fmap_hits(), 1n);

  const firstPtr = wasm.fmap_slot_ptr(first);
  view().setFloat32(firstPtr, 1.25, true);
  view().setFloat32(firstPtr + 4, 99, true);
  view().setFloat32(firstPtr + 8, -3.5, true);
  assert.equal(wasm.fmap_commit_page(first, 12), 0);
  assert.equal(wasm.fmap_slot_valid_bytes(first), 12);
  assert.equal(wasm.fmap_extract_f32_le(first, 0, 2, 8), 2);
  assert.deepEqual(Array.from(output(2)), [1.25, -3.5]);
  assert.equal(wasm.fmap_extract_f32_le(first, 8, 2, 8), -5, "exact valid-byte bound");

  const scratchPtr = wasm.fmap_scratch_ptr();
  view().setFloat32(scratchPtr, 2.5, true);
  view().setFloat32(scratchPtr + 4, -7.25, true);
  assert.equal(wasm.fmap_extract_scratch_f32(0, 2, 4, 1, 8), 2);
  assert.deepEqual(Array.from(output(2)), [2.5, -7.25], "decode exact cold span in scratch");
  assert.equal(wasm.fmap_extract_scratch_f32(4, 2, 4, 1, 8), -5);
  view().setFloat32(scratchPtr, 13.75, false);
  assert.equal(wasm.fmap_extract_scratch_f32(0, 1, 4, 0, 4), 1);
  assert.deepEqual(Array.from(output(1)), [13.75], "decode big-endian Float32 from scratch");

  const second = wasm.fmap_acquire_page(2n);
  assert.equal(second, 1);
  assert.equal(wasm.fmap_acquire_page(3n), -2, "backpressure while all slots pinned");
  assert.equal(wasm.fmap_release_page(first), 0);
  assert.equal(wasm.fmap_release_page(first), 0);
  assert.equal(wasm.fmap_release_page(second), 0);
  assert.equal(wasm.fmap_touch_page(first), 0);
  const replacement = wasm.fmap_acquire_page(3n);
  assert.equal(replacement, second, "evict least-recently-used unpinned page");
  assert.equal(wasm.fmap_find_page(2n), -1);
  assert.equal(wasm.fmap_evictions(), 1n);

  const replacementPtr = wasm.fmap_slot_ptr(replacement);
  view().setFloat32(replacementPtr, 6.5, false);
  assert.equal(wasm.fmap_commit_page(replacement, 4), 0);
  assert.equal(wasm.fmap_extract_f32(replacement, 0, 1, 4, 0), 1);
  assert.deepEqual(Array.from(output(1)), [6.5], "decode big-endian Float32");
  assert.equal(wasm.fmap_release_page(replacement), 0);
  assert.equal(wasm.fmap_evict_page(3n), 1);

  const generation = wasm.fmap_generation();
  assert.equal(wasm.fmap_reset(), 0);
  assert.notEqual(wasm.fmap_generation(), generation);
  assert.equal(wasm.fmap_pinned_bytes(), 0);
  assert.equal(wasm.fmap_hits(), 0n);
  assert.equal(wasm.fmap_misses(), 0n);

  for (let index = 0; index < 200; index++) {
    const slot = wasm.fmap_acquire_page(BigInt(index) * 0x1_0000_0000n + 7n);
    assert.ok(slot >= 0);
    assert.equal(wasm.fmap_commit_page(slot, 1), 0);
    assert.equal(wasm.fmap_release_page(slot), 0);
  }
  assert.equal(wasm.fmap_resident_bytes(), 128, "logical file size does not grow resident pool");
  assert.equal(wasm.memory.buffer.byteLength, memoryAfterInit, "steady-state requests do not grow WASM memory");

  assert.equal(wasm.fmap_init(128, 4), 0, "allow worker reconfiguration in-place");
  const memoryAfterGrowth = wasm.memory.buffer.byteLength;
  assert.equal(wasm.fmap_init(64, 2), 0);
  assert.equal(wasm.memory.buffer.byteLength, memoryAfterGrowth, "smaller reinit reuses linear memory");

  return {
    bytes: bytes.length,
    exports: WebAssembly.Module.exports(module).length,
    logicalPagesExercised: 200,
    residentBytes: wasm.fmap_resident_bytes(),
    memoryBytes: wasm.memory.buffer.byteLength
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await testFmapCore(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  console.log(`fmap ABI tests passed: ${JSON.stringify(result)}`);
}
