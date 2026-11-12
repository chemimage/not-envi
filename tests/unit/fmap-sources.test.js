// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { collectFmapSources, verifyFmapArtifact, FMAP_LINKED_MODULES, FMAP_SOURCE_SCOPES } from "../../scripts/fmap-sources.mjs";

const directories = [];
const bytes = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "hyve-fmap-sources-"));
  directories.push(directory);
  mkdirSync(path.join(directory, "nested"));
  writeFileSync(path.join(directory, "nested", "helper.c"), "int helper(void) { return 1; }\n");
  writeFileSync(path.join(directory, "internal.h"), "int helper(void);\n");
  writeFileSync(path.join(directory, "core.c"), '#include "internal.h"\n');
  return directory;
}

function manifest(directory) {
  return { ...collectFmapSources(directory), bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(path.resolve(tmpdir()) + path.sep)
        || !path.basename(resolved).startsWith("hyve-fmap-sources-")) throw new Error("Unexpected source fixture directory");
    rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("source discovery covers nested translation units and headers in portable sorted order", () => {
  const directory = fixture();
  const first = collectFmapSources(directory);
  expect(first.sources.map((source) => source.path)).toEqual(["core.c", "internal.h", "nested/helper.c"]);
  writeFileSync(path.join(directory, "nested", "helper.c"), "int helper(void) { return 1; }\r\n");
  writeFileSync(path.join(directory, "internal.h"), "int helper(void);\r\n");
  writeFileSync(path.join(directory, "core.c"), '#include "internal.h"\r\n');
  expect(collectFmapSources(directory)).toEqual(first);
});

test("package verification includes public headers and excludes build output", () => {
  const directory = fixture();
  mkdirSync(path.join(directory, "src"));
  mkdirSync(path.join(directory, "include"));
  mkdirSync(path.join(directory, "build"));
  writeFileSync(path.join(directory, "src", "core.c"), '#include <fmap.h>\n');
  const header = path.join(directory, "include", "fmap.h");
  writeFileSync(header, "int fmap_init(void);\n");
  writeFileSync(path.join(directory, "build", "ignored.c"), "int generated;\n");
  const scopes = ["src", "include"];
  const source = collectFmapSources(directory, scopes);
  expect(source.sources.map(entry => entry.path)).toEqual(["include/fmap.h", "src/core.c"]);
  const build = { ...source, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  expect(verifyFmapArtifact(bytes, build, directory, scopes)).toBe(bytes);
  writeFileSync(header, "int fmap_init(int slots);\n");
  expect(() => verifyFmapArtifact(bytes, build, directory, scopes)).toThrow(/does not match/);
});

test.each([
  ["edit a C source", (directory) => writeFileSync(path.join(directory, "core.c"), "int changed;\n")],
  ["edit a header", (directory) => writeFileSync(path.join(directory, "internal.h"), "int changed;\n")],
  ["add a C source", (directory) => writeFileSync(path.join(directory, "nested", "new.c"), "int added;\n")],
  ["add a header", (directory) => writeFileSync(path.join(directory, "nested", "new.h"), "int added;\n")],
  ["remove a C source", (directory) => unlinkSync(path.join(directory, "nested", "helper.c"))],
  ["remove a header", (directory) => unlinkSync(path.join(directory, "internal.h"))],
  ["rename a C source", (directory) => renameSync(path.join(directory, "core.c"), path.join(directory, "renamed.c"))],
  ["rename a header", (directory) => renameSync(path.join(directory, "internal.h"), path.join(directory, "renamed.h"))]
])("artifact verification rejects stale manifests when we %s", (_description, mutate) => {
  const directory = fixture();
  const build = manifest(directory);
  expect(verifyFmapArtifact(bytes, build, directory)).toBe(bytes);
  mutate(directory);
  expect(() => verifyFmapArtifact(bytes, build, directory)).toThrow(/does not match its build manifest/);
});

test("verification detects an altered binary or incomplete source list", () => {
  const directory = fixture();
  const build = manifest(directory);
  const altered = Buffer.from(bytes);
  altered[7] = 1;
  expect(() => verifyFmapArtifact(altered, build, directory)).toThrow(/does not match its build manifest/);
  expect(() => verifyFmapArtifact(bytes, { ...build, sources: build.sources.slice(1) }, directory))
    .toThrow(/does not match its build manifest/);
});

test.each(["numeric/include/numeric.h", "reduction/src/reduction.c", "fmap/include/fmap/cache.h"])(
  "linked artifact verification rejects a stale %s", (changed) => {
    const directory = fixture();
    for (const name of FMAP_LINKED_MODULES) {
      mkdirSync(path.join(directory, name, "src"), { recursive: true });
      mkdirSync(path.join(directory, name, "include"), { recursive: true });
      writeFileSync(path.join(directory, name, "src", `${name}.c`), "int module;\n");
      writeFileSync(path.join(directory, name, "include", `${name}.h`), "int module(void);\n");
    }
    mkdirSync(path.join(directory, "fmap/include/fmap"));
    writeFileSync(path.join(directory, "fmap/include/fmap/cache.h"), "int cache(void);\n");
    mkdirSync(path.join(directory, "reduction/build"));
    writeFileSync(path.join(directory, "reduction/build/generated.c"), "not a source input\n");
    const source = collectFmapSources(directory, FMAP_SOURCE_SCOPES);
    expect(source.sources).toHaveLength(7);
    const build = { ...source, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    expect(verifyFmapArtifact(bytes, build, directory, FMAP_SOURCE_SCOPES)).toBe(bytes);
    writeFileSync(path.join(directory, changed), "int changed(void);\n");
    expect(() => verifyFmapArtifact(bytes, build, directory, FMAP_SOURCE_SCOPES)).toThrow(/does not match/);
  }
);
