import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FMAP_LINKED_MODULES } from "./fmap-sources.mjs";

export async function testLinkedCModules({ clang, root, buildDir, sources }) {
  const includePaths = FMAP_LINKED_MODULES.flatMap(name => ["-I", path.join(root, "wasm", name, "include")]);
  // Compile every public header in isolation, in C and C++. Leaf headers cannot
  // rely on prior include order, and the compatibility umbrella must still work.
  for (const source of sources.filter(entry => entry.path.includes("/include/") && entry.path.endsWith(".h"))) {
    const header = source.path.split("/include/")[1];
    for (const language of ["c", "c++"]) {
      execFileSync(clang, ["--target=wasm32-unknown-unknown", "-ffreestanding", "-Wall", "-Wextra", "-Werror",
        ...includePaths, "-x", language, language === "c" ? "-std=c11" : "-std=c++17", "-fsyntax-only", "-"],
      { input: `#include <${header}>\n`, encoding: "utf8" });
    }
  }
  const output = path.join(buildDir, "reduction-module-test.wasm");
  execFileSync(clang, ["--target=wasm32-unknown-unknown", "-std=c11", "-O2", "-flto", "-ffreestanding",
    "-fno-builtin", "-nostdlib", "-Wall", "-Wextra", "-Werror",
    ...["numeric", "reduction"].flatMap(name => ["-I", path.join(root, "wasm", name, "include")]),
    path.join(root, "wasm/numeric/src/numeric.c"), path.join(root, "wasm/reduction/src/reduction.c"),
    path.join(root, "tests/fixtures/reduction-module.c"), "-Wl,--no-entry", "-Wl,--export-memory", "-o", output]);
  const module = await WebAssembly.compile(readFileSync(output));
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  const c = (await WebAssembly.instantiate(module)).exports;
  const input = new DataView(c.memory.buffer, c.input_ptr(), 4096);
  for (const little of [true, false]) {
    [-7.5, NaN, 2.25, Infinity, 3.75].forEach((value, i) => input.setFloat32(3 + i * 8, value, little));
    assert.equal(c.reduce(0, 3, 5, 8, 4, +little, 0, 0, 1), 5);
    const first = new Float64Array(c.memory.buffer, c.result_ptr(0), 261).slice();
    assert.deepEqual(Array.from(first.subarray(0, 5)), [-7.5, 3.75, 3, -1.5, 75.375]);
    assert.equal(c.reduce(1, 19, 1, 8, 4, +little, 256, 2.25, 2.250001), 1);
    assert.equal(new Float64Array(c.memory.buffer, c.result_ptr(1), 261)[5], 1);
    assert.deepEqual(new Float64Array(c.memory.buffer, c.result_ptr(0), 261), first,
      "caller result buffers must not overwrite each other");
  }
  assert.equal(c.reduce(0, 4094, 1, 4, 4, 1, 0, 0, 1), -3);
  assert.equal(c.reduce(0, 0, 1, 4, 99, 1, 0, 0, 1), -1);
  assert.equal(c.reduce(0, 0, 2, 1, 4, 1, 0, 0, 1), -2);
  assert.equal(c.reduce(0, 0, 1, 4, 4, 1, 256, 2, 1), -4);
  console.log("Public C/C++ headers and standalone numeric/reduction module checks passed.");
}
