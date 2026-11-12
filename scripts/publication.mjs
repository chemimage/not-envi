import { readFileSync, writeFileSync } from "node:fs";

export function planPublication({ manifest, calculatedVersion, sourceVersion, testedCommit, mainCommit, tagCommit }) {
  if (!/^[0-9a-f]{40}$/.test(testedCommit) || manifest.commit !== testedCommit) throw new Error("Artifact does not belong to the successful CI commit.");
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || manifest.version !== calculatedVersion) throw new Error("Artifact version does not match the calculated release version.");
  if (mainCommit !== testedCommit) return { publish: false, reason: "A newer main commit exists; waiting for its CI." };
  if (tagCommit && tagCommit !== testedCommit) {
    if (sourceVersion !== manifest.version) throw new Error("Calculated version tag already points to another commit; refusing to move it.");
    return { publish: false, reason: "The calculated version is already released; no new version bump." };
  }
  return { publish: true, tag: `v${manifest.version}`, createTag: !tagCommit };
}

// Stamp the build checkout, not repository history. CI and publication both
// use the same calculated version, including the version embedded in the HTML.
export function stampPackageVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid build version.");
  for (const name of ["package.json", "package-lock.json"]) {
    const pkg = JSON.parse(readFileSync(name, "utf8"));
    pkg.version = version;
    if (pkg.packages?.[""]) pkg.packages[""].version = version;
    writeFileSync(name, `${JSON.stringify(pkg, null, 2)}\n`);
  }
}
