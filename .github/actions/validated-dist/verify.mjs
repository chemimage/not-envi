import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const source = process.env.VALIDATED_DIST;
if (!source) throw new Error("VALIDATED_DIST is required.");
const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (manifest.commit !== commit) throw new Error("Distribution commit does not match the tagged checkout.");
if (process.env.GITHUB_REF_TYPE !== "tag" || process.env.GITHUB_REF_NAME !== `v${manifest.version}`) {
  throw new Error("Tag does not match the version calculated by CI.");
}
for (const path of ["package.json", "package-lock.json"]) {
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  if (pkg.version !== manifest.version || (pkg.packages?.[""] && pkg.packages[""].version !== manifest.version)) {
    throw new Error(`${path} does not match the validated release version.`);
  }
}
const html = readFileSync(join(source, "index.html"));
if (createHash("sha256").update(html).digest("hex") !== manifest.sha256) {
  throw new Error("Distribution SHA-256 does not match the tested CI artifact.");
}
const reports = ["coverage-summary.json", "coverage-badge.json"];
for (const name of reports) {
  const bytes = readFileSync(join(source, name));
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.reports?.[name]) {
    throw new Error(`${name} SHA-256 does not match the measured CI report.`);
  }
}
mkdirSync("dist", { recursive: true });
copyFileSync(join(source, "index.html"), "dist/index.html");
for (const name of reports) copyFileSync(join(source, name), join("dist", name));
console.log(`Verified tested distribution for ${commit} (${manifest.version}).`);
