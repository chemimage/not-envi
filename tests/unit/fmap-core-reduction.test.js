// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { computeHistogram, histogramFromReduction } from "../../src/render/display-math.js";

const wasm = readFileSync("wasm/fmap/pkg/fmap_core.wasm");

test.each([true, false])("pinned strided Float64 spans preserve Float32 analysis, endian=%s", async (little) => {
  const { instance: { exports: c } } = await WebAssembly.instantiate(wasm);
  expect(c.fmap_init(4096, 1)).toBe(0);
  const slot = c.fmap_acquire_page(0n);
  const input = [NaN, -Infinity, 3.1, -7.2, Infinity, 12.7, 3.1];
  const view = new DataView(c.memory.buffer, c.fmap_slot_ptr(slot), 4096);
  input.forEach((v, i) => view.setFloat64(3 + i * 16, v, little));
  expect(c.fmap_commit_range(slot, 3, 104)).toBe(0);
  const run = (bins, min, max) => {
    expect(c.fmap_reduce_numeric(slot, 3, input.length, 16, 5, +little, 1, bins, min, max)).toBe(input.length);
    return new Float64Array(c.memory.buffer, c.fmap_reduction_ptr(), 261).slice();
  };
  const range = run(0, 0, 1);
  const values = run(256, range[0], range[1]);
  const actual = histogramFromReduction({ min: range[0], max: range[1], count: values[2],
    sum: values[3], sumSq: values[4], bins: Uint32Array.from(values.subarray(5)) });
  expect(actual).toEqual(computeHistogram(Float32Array.from(input)));
  expect(c.fmap_release_page(slot)).toBe(0);
  expect(c.fmap_reduce_numeric(slot, 3, 1, 8, 5, +little, 1, 0, 0, 1)).toBe(-3);
});

test("reduction rejects sparse holes, invalid types/ranges and oversized scratch", async () => {
  const { instance: { exports: c } } = await WebAssembly.instantiate(wasm);
  expect(c.fmap_reduce_scratch_numeric(0, 1, 4, 4, 1, 1, 0, 0, 1, 4)).toBe(-1);
  expect(c.fmap_init(4096, 1)).toBe(0);
  const slot = c.fmap_acquire_page(0n);
  new Uint8Array(c.memory.buffer, c.fmap_slot_ptr(slot), 4096).fill(7);
  expect(c.fmap_commit_range(slot, 0, 4)).toBe(0);
  expect(c.fmap_commit_range(slot, 8, 4)).toBe(0);
  expect(c.fmap_reduce_numeric(slot, 0, 3, 4, 4, 1, 1, 0, 0, 1)).toBe(-5);
  const data = new DataView(c.memory.buffer, c.fmap_slot_ptr(slot), 4096);
  data.setFloat32(0, 1.5, true); data.setFloat32(8, 2.5, true);
  expect(c.fmap_reduce_numeric(slot, 0, 2, 8, 4, 1, 1, 0, 0, 1)).toBe(2);
  expect(Array.from(new Float64Array(c.memory.buffer, c.fmap_reduction_ptr(), 5))).toEqual([1.5, 2.5, 2, 4, 8.5]);
  expect(c.fmap_reduce_numeric(slot, 0, 1, 1, 99, 1, 1, 0, 0, 1)).toBe(-7);
  expect(c.fmap_reduce_numeric(slot, 0, 1, 1, 1, 1, 1, 257, 0, 1)).toBe(-4);
  expect(c.fmap_reduce_numeric(slot, 0, 1, 1, 1, 1, 1, 256, 2, 1)).toBe(-6);
  expect(c.fmap_reduce_scratch_numeric(0, 1, 1, 1, 1, 1, 0, 0, 1, 4097)).toBe(-4);
});
