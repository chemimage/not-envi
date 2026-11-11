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
    "fmap_map_region",
    "fmap_unmap_region",
    "fmap_lookup_mapping",
    "fmap_mapping_start",
    "fmap_mapping_end",
    "fmap_mapping_file_offset",
    "fmap_mapping_count",
    "fmap_mapping_bytes",
    "fmap_mapping_reset",
    "fmap_mapping_find_gap",
    "fmap_mapping_gap_nodes_visited",
    "fmap_mapping_gap_entries_visited",
    "fmap_acquire_page",
    "fmap_commit_page",
    "fmap_commit_range",
    "fmap_range_valid",
    "fmap_slot_range_count",
    "fmap_slot_range_offset",
    "fmap_slot_range_length",
    "fmap_release_page",
    "fmap_touch_page",
    "fmap_slot_ptr",
    "fmap_extract_f32",
    "fmap_extract_f32_le",
    "fmap_extract_numeric",
    "fmap_output_f64_ptr",
    "fmap_output_f64_capacity",
    "fmap_scratch_ptr",
    "fmap_scratch_capacity_bytes",
    "fmap_extract_scratch_f32",
    "fmap_extract_scratch_numeric"
  ]) {
    assert.ok(exportNames.has(name), `missing required ABI export ${name}`);
  }
  const { exports: wasm } = await WebAssembly.instantiate(module, {});
  const view = () => new DataView(wasm.memory.buffer);
  const output = count => new Float32Array(wasm.memory.buffer, wasm.fmap_output_ptr(), count);
  const numericOutput = count => new Float64Array(
    wasm.memory.buffer,
    wasm.fmap_output_f64_ptr(),
    count
  );

  assert.equal(wasm.fmap_init(0, 2), -6, "reject zero-sized pages");
  assert.equal(wasm.fmap_init(64, 2), 0);
  assert.equal(wasm.fmap_page_size(), 64);
  assert.equal(wasm.fmap_slot_count(), 2);
  assert.equal(wasm.fmap_resident_bytes(), 128);
  assert.equal(wasm.fmap_scratch_capacity_bytes(), 64);
  assert.equal(wasm.fmap_output_capacity_f32(), 16);
  assert.equal(wasm.fmap_output_f64_capacity(), 8);
  assert.equal(wasm.fmap_output_f64_ptr() % 8, 0, "Float64 output is naturally aligned");
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
  assert.equal(wasm.fmap_range_valid(first, 0, 0), 1, "empty range is valid within a resident page");
  assert.equal(wasm.fmap_range_valid(first, 0, 4), 0, "new page starts with no valid bytes");
  assert.equal(wasm.fmap_extract_f32_le(first, 0, 1, 4), -5, "new page bytes are invalid");
  assert.equal(wasm.fmap_commit_range(first, 0, 4), 0);
  assert.equal(wasm.fmap_commit_range(first, 8, 4), 0);
  assert.equal(wasm.fmap_slot_valid_bytes(first), 12);
  assert.equal(wasm.fmap_range_valid(first, 0, 4), 1);
  assert.equal(wasm.fmap_range_valid(first, 4, 4), 0, "sparse fill preserves its hole");
  assert.equal(wasm.fmap_range_valid(first, 8, 4), 1);
  assert.equal(wasm.fmap_slot_range_count(first), 2);
  assert.deepEqual([
    wasm.fmap_slot_range_offset(first, 0), wasm.fmap_slot_range_length(first, 0),
    wasm.fmap_slot_range_offset(first, 1), wasm.fmap_slot_range_length(first, 1)
  ], [0, 4, 8, 4], "enumerate sorted resident validity intervals");
  assert.equal(wasm.fmap_slot_range_length(first, 2), 0, "invalid range index is safe");
  assert.equal(wasm.fmap_extract_f32_le(first, 0, 2, 8), 2);
  assert.deepEqual(Array.from(output(2)), [1.25, -3.5]);
  assert.equal(wasm.fmap_extract_f32_le(first, 0, 3, 4), -5, "strided extraction rejects a hole");
  assert.equal(wasm.fmap_commit_range(first, 4, 4), 0, "adjacent commit merges sparse intervals");
  assert.equal(wasm.fmap_range_valid(first, 0, 12), 1, "bridged range becomes fully valid");
  assert.equal(wasm.fmap_slot_range_count(first), 1);
  assert.equal(wasm.fmap_slot_range_length(first, 0), 12);
  assert.equal(wasm.fmap_extract_f32_le(first, 8, 2, 8), -5, "exact valid-byte bound");
  assert.equal(wasm.fmap_commit_range(first, 63, 2), -5, "reject range crossing the page boundary");
  assert.equal(wasm.fmap_commit_range(first, 0, 65), -4, "reject range length larger than a page");
  assert.equal(wasm.fmap_range_valid(first, 64, 0), 1, "empty range at page end is valid");
  assert.equal(wasm.fmap_range_valid(first, 65, 0), -5, "reject offset beyond page end");

  const numericCases = [
    { type: 1, size: 1, value: 241, set: (data, at, value) => data.setUint8(at, value) },
    { type: 2, size: 2, value: -12345, set: (data, at, value, le) => data.setInt16(at, value, le) },
    { type: 3, size: 4, value: -123456789, set: (data, at, value, le) => data.setInt32(at, value, le) },
    { type: 4, size: 4, value: -12.5, set: (data, at, value, le) => data.setFloat32(at, value, le) },
    { type: 5, size: 8, value: Math.PI, set: (data, at, value, le) => data.setFloat64(at, value, le) },
    { type: 12, size: 2, value: 54321, set: (data, at, value, le) => data.setUint16(at, value, le) },
    { type: 13, size: 4, value: 4_000_000_000, set: (data, at, value, le) => data.setUint32(at, value, le) },
    {
      type: 14,
      size: 8,
      value: -(2n ** 53n + 3n),
      set: (data, at, value, le) => data.setBigInt64(at, value, le)
    },
    {
      type: 15,
      size: 8,
      value: 2n ** 63n + 12345n,
      set: (data, at, value, le) => data.setBigUint64(at, value, le)
    }
  ];
  for (const testCase of numericCases) {
    for (const littleEndian of [false, true]) {
      testCase.set(view(), firstPtr + 1, testCase.value, littleEndian);
      assert.equal(wasm.fmap_commit_page(first, testCase.size + 1), 0);
      assert.equal(
        wasm.fmap_extract_numeric(first, 1, 1, testCase.size, testCase.type, Number(littleEndian)),
        1,
        `extract ENVI type ${testCase.type} (${littleEndian ? "LE" : "BE"})`
      );
      assert.equal(numericOutput(1)[0], Number(testCase.value));
    }
  }
  assert.equal(wasm.fmap_extract_numeric(first, 1, 1, 1, 99, 1), -7, "reject unknown type");
  assert.equal(wasm.fmap_extract_numeric(first, 1, 2, 8, 5, 1), -5, "bound typed reads");
  assert.equal(wasm.fmap_extract_numeric(first, 0, 9, 1, 1, 1), -4, "bound Float64 output");
  view().setUint16(firstPtr, 1234, true);
  view().setUint16(firstPtr + 4, 5678, true);
  assert.equal(wasm.fmap_commit_page(first, 0), 0);
  assert.equal(wasm.fmap_commit_range(first, 0, 2), 0);
  assert.equal(wasm.fmap_commit_range(first, 4, 2), 0);
  assert.equal(wasm.fmap_extract_numeric(first, 0, 2, 4, 12, 1), 2);
  assert.deepEqual(Array.from(numericOutput(2)), [1234, 5678], "support strided typed reads");
  assert.equal(
    wasm.fmap_extract_numeric(first, 0, 3, 2, 12, 1),
    -5,
    "generic extraction rejects a sampled hole while allowing stride gaps"
  );

  const scratchPtr = wasm.fmap_scratch_ptr();
  view().setFloat32(scratchPtr, 2.5, true);
  view().setFloat32(scratchPtr + 4, -7.25, true);
  assert.equal(wasm.fmap_extract_scratch_f32(0, 2, 4, 1, 8), 2);
  assert.deepEqual(Array.from(output(2)), [2.5, -7.25], "decode exact cold span in scratch");
  assert.equal(wasm.fmap_extract_scratch_f32(4, 2, 4, 1, 8), -5);
  view().setFloat32(scratchPtr, 13.75, false);
  assert.equal(wasm.fmap_extract_scratch_f32(0, 1, 4, 0, 4), 1);
  assert.deepEqual(Array.from(output(1)), [13.75], "decode big-endian Float32 from scratch");
  view().setBigInt64(scratchPtr + 2, -(2n ** 60n + 7n), false);
  assert.equal(wasm.fmap_extract_scratch_numeric(2, 1, 8, 14, 0, 10), 1);
  assert.equal(numericOutput(1)[0], Number(-(2n ** 60n + 7n)));
  assert.equal(wasm.fmap_extract_scratch_numeric(2, 1, 8, 14, 0, 9), -5);

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
  assert.equal(wasm.fmap_range_valid(replacement, 0, 1), -3, "eviction clears validity with the slot");
  assert.equal(wasm.fmap_slot_range_count(replacement), 0);

  const generation = wasm.fmap_generation();
  assert.equal(wasm.fmap_reset(), 0);
  assert.notEqual(wasm.fmap_generation(), generation);
  assert.equal(wasm.fmap_pinned_bytes(), 0);
  assert.equal(wasm.fmap_hits(), 0n);
  assert.equal(wasm.fmap_misses(), 0n);

  assert.equal(wasm.fmap_init(256, 1), 0, "configure a page large enough to test validity fragmentation");
  const fragmented = wasm.fmap_acquire_page(77n);
  assert.equal(fragmented, 0);
  for (let index = 0; index < 64; index++) {
    assert.equal(wasm.fmap_commit_range(fragmented, index * 2, 1), 0);
  }
  assert.equal(wasm.fmap_slot_range_count(fragmented), 64);
  assert.equal(wasm.fmap_slot_valid_bytes(fragmented), 127);
  assert.equal(wasm.fmap_commit_range(fragmented, 128, 1), -8, "report fixed interval capacity explicitly");
  assert.equal(wasm.fmap_slot_range_count(fragmented), 64, "capacity failure leaves interval metadata unchanged");
  assert.equal(wasm.fmap_range_valid(fragmented, 128, 1), 0, "failed fragment commit is atomic");
  assert.equal(wasm.fmap_slot_valid_bytes(fragmented), 127, "failed fragment does not raise high-water mark");
  assert.equal(wasm.fmap_commit_range(fragmented, 1, 1), 0, "bridging intervals frees metadata capacity");
  assert.equal(wasm.fmap_range_valid(fragmented, 0, 3), 1);
  assert.equal(wasm.fmap_commit_range(fragmented, 128, 1), 0, "freed interval capacity accepts another fragment");
  assert.equal(wasm.fmap_commit_page(fragmented, 32), 0, "full commit replaces sparse validity");
  assert.equal(wasm.fmap_range_valid(fragmented, 0, 32), 1);
  assert.equal(wasm.fmap_range_valid(fragmented, 32, 1), 0);
  assert.equal(wasm.fmap_release_page(fragmented), 0);
  assert.equal(wasm.fmap_reset(), 0);
  assert.equal(wasm.fmap_range_valid(fragmented, 0, 1), -3, "reset clears occupied slots and validity");

  for (let index = 0; index < 200; index++) {
    const slot = wasm.fmap_acquire_page(BigInt(index) * 0x1_0000_0000n + 7n);
    assert.ok(slot >= 0);
    assert.equal(wasm.fmap_commit_page(slot, 1), 0);
    assert.equal(wasm.fmap_release_page(slot), 0);
  }
  assert.equal(wasm.fmap_resident_bytes(), 256, "logical file size does not grow resident pool");
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
