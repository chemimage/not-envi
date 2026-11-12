import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceHashFormat = "fmap-source-set-v1";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Hash every C translation unit and header, including its portable relative
 * path. Stable ordering and normalized line endings work across Git checkouts;
 * discovery rather than a hand-maintained list prevents unnoticed new files.
 * Optional subtree scopes include src/include without generated build output. */
export function collectFmapSources(sourceDirectory, directories = ["."]) {
  const root = sourceDirectory instanceof URL ? fileURLToPath(sourceDirectory) : path.resolve(sourceDirectory);
  const paths = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("fmap source directories must not contain symbolic links.");
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && /\.[ch]$/i.test(entry.name)) paths.push(path.relative(root, fullPath).split(path.sep).join("/"));
    }
  };
  for (const directory of directories) visit(path.join(root, directory));
  paths.sort();
  if (!paths.some((name) => /\.c$/i.test(name))) throw new Error("No fmap C translation units were found.");
  const sources = paths.map((name) => ({
    path: name,
    sha256: sha256(readFileSync(path.join(root, name), "utf8").replace(/\r\n/g, "\n"))
  }));
  // JSON frames both paths and hashes unambiguously; names and content are
  // verified together, so adding/removing/renaming a source changes the digest.
  return { sourceHashFormat, sources, sourceSha256: sha256(JSON.stringify(sources)) };
}

export function verifyFmapArtifact(bytes, build, sourceDirectory, directories) {
  const source = collectFmapSources(sourceDirectory, directories);
  if (sha256(bytes) !== build.sha256 || bytes.length !== build.bytes
      || source.sourceHashFormat !== build.sourceHashFormat
      || source.sourceSha256 !== build.sourceSha256
      || JSON.stringify(source.sources) !== JSON.stringify(build.sources)) {
    throw new Error("The fmap source or WASM artifact does not match its build manifest. Run npm run build:fmap.");
  }
  if (!bytes.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) {
    throw new Error("The committed fmap artifact is not WebAssembly.");
  }
  return bytes;
}
