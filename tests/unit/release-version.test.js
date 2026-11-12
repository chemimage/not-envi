// @vitest-environment node
import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { calculateReleaseVersion } from "../../scripts/release-version.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function repository({ tagged = true } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "hyve-version-"));
  roots.push(cwd);
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Version Test");
  git("config", "user.email", "version-test@example.invalid");
  const commit = (body) => execFileSync("git", ["commit", "--allow-empty", "--file=-"], { cwd, input: body, encoding: "utf8" });
  commit("Initial release");
  if (tagged) git("tag", "v1.2.3");
  const version = () => calculateReleaseVersion({ cwd });
  return { cwd, git, commit, version };
}

describe("Node release version calculation", () => {
  test("pins an existing release and applies the largest bump once across the batch", { timeout: 30_000 }, () => {
    const { git, commit, version } = repository();
    expect(version()).toMatchObject({ version: "1.2.3", source: "1.2.3", commitsSinceSource: 0 });
    commit("Update documentation\n\n+semver: none");
    expect(version().version).toBe("1.2.3");
    commit("Correct a rendering failure");
    expect(version().version).toBe("1.2.4");
    commit("Add export progress\n\n+semver: minor");
    commit("Add another feature\n\n+semver: minor");
    expect(version()).toMatchObject({ version: "1.3.0", commitsSinceSource: 4 });
    commit("Change the public interface\n\n+semver: major");
    commit("Prepare release notes\n\n+semver: none");
    expect(version().version).toBe("2.0.0");
    git("tag", "v2.0.0");
    expect(version()).toMatchObject({ version: "2.0.0", source: "2.0.0", commitsSinceSource: 0 });
  });

  test("ignores unrelated branch tags and prereleases", { timeout: 30_000 }, () => {
    const { git, commit, version } = repository();
    git("switch", "-c", "unmerged");
    commit("Other branch");
    git("tag", "v99.0.0");
    git("switch", "main");
    commit("Fix a bug\n\n+semver: patch");
    git("tag", "v8.0.0-rc.1");
    expect(version()).toMatchObject({ version: "1.2.4", source: "1.2.3" });
  });

  test("includes semver annotations from merged work", { timeout: 30_000 }, () => {
    const { git, commit, version } = repository();
    git("switch", "-c", "feature");
    commit("Add feature\n\n+semver: minor");
    git("switch", "main");
    git("merge", "--no-ff", "feature", "-m", "Merge feature");
    expect(version().version).toBe("1.3.0");
  });

  test("none overrides another marker only within the same commit", { timeout: 30_000 }, () => {
    const { commit, version } = repository();
    commit("Document an example\n\n+semver: major\n+semver: none");
    expect(version().version).toBe("1.2.3");
    commit("Add feature\n\n+semver: minor");
    expect(version().version).toBe("1.3.0");
  });

  test("fails clearly when stable tags or full history are missing", { timeout: 30_000 }, () => {
    const untagged = repository({ tagged: false });
    expect(untagged.version).toThrow("No reachable stable release tag");
    const source = repository();
    source.commit("New work");
    const shallow = join(source.cwd, "shallow");
    source.git("clone", "--depth=1", pathToFileURL(source.cwd).href, shallow);
    expect(() => calculateReleaseVersion({ cwd: shallow })).toThrow("full Git history");
  });

  test("CLI updates and checks both package files and emits CI output without .NET", { timeout: 30_000 }, () => {
    const { cwd, commit } = repository();
    commit("Add feature\n\n+semver: minor");
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ version: "1.2.3" }));
    writeFileSync(join(cwd, "package-lock.json"), JSON.stringify({ version: "1.2.3", packages: { "": { version: "1.2.3" } } }));
    const output = join(cwd, "github-output");
    const script = resolve("scripts/calculate-version.mjs");
    const run = (...args) => execFileSync(process.execPath, [script, ...args], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.3.0" }
    });
    run("--write", "--github-output");
    expect(JSON.parse(readFileSync(join(cwd, "package.json"))).version).toBe("1.3.0");
    expect(JSON.parse(readFileSync(join(cwd, "package-lock.json"))).packages[""].version).toBe("1.3.0");
    expect(readFileSync(output, "utf8")).toContain("version=1.3.0");
    expect(() => run("--check")).not.toThrow();
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ version: "9.0.0" }));
    expect(() => run("--check")).toThrow();
  });
});
