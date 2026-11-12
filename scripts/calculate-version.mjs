import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const result = JSON.parse(execFileSync("dotnet", ["tool", "run", "dotnet-gitversion", "--", "/output", "json", "/nofetch"], { encoding: "utf8" }));
const version = result.MajorMinorPatch;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("GitVersion returned an invalid release version.");

if (process.argv.includes("--write")) {
  for (const path of ["package.json", "package-lock.json"]) {
    const document = JSON.parse(readFileSync(path, "utf8"));
    document.version = version;
    if (document.packages?.[""]) document.packages[""].version = version;
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  }
}
if (process.argv.includes("--check")) {
  for (const path of ["package.json", "package-lock.json"]) {
    const document = JSON.parse(readFileSync(path, "utf8"));
    if (document.version !== version || (document.packages?.[""] && document.packages[""].version !== version)) {
      throw new Error(`${path} must match the calculated release version ${version}.`);
    }
  }
  if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME !== `v${version}`) {
    throw new Error(`Release tag must be v${version}.`);
  }
}
if (process.argv.includes("--github-output")) {
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}
console.log(JSON.stringify({ version, source: result.VersionSourceSemVer,
  commitsSinceSource: result.CommitsSinceVersionSource, sha: result.Sha }, null, 2));
