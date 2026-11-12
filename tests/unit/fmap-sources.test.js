// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { collectFmapSources, verifyFmapArtifact } from "../../scripts/fmap-sources.mjs";

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
