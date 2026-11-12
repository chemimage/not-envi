import { afterEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const verifier = resolve(".github/actions/validated-dist/verify.mjs");
const gitDir = resolve(".git");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const fixtures = [];
afterEach(() => fixtures.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

function verifyFixture(change = () => {}) {
  const cwd = mkdtempSync(join(tmpdir(), "hyve-artifact-"));
  fixtures.push(cwd);
  const source = join(cwd, "artifact");
  mkdirSync(source);
  const html = "<!doctype html><title>tested HTML</title>";
  const manifest = {
    commit, version: "1.2.3", sha256: createHash("sha256").update(html).digest("hex"),
    reports: {}
  };
  for (const name of ["coverage-summary.json", "coverage-badge.json"]) {
    const report = JSON.stringify({ report: name });
    writeFileSync(join(source, name), report);
    manifest.reports[name] = createHash("sha256").update(report).digest("hex");
  }
  const pkg = { version: "1.2.3" };
  const lock = { version: "1.2.3", packages: { "": { version: "1.2.3" } } };
  change({ manifest, pkg, lock });
  writeFileSync(join(source, "index.html"), html);
  writeFileSync(join(source, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(cwd, "package.json"), JSON.stringify(pkg));
  writeFileSync(join(cwd, "package-lock.json"), JSON.stringify(lock));
  const result = spawnSync(process.execPath, [verifier], {
    cwd, encoding: "utf8", env: {
      ...process.env, GIT_DIR: gitDir, VALIDATED_DIST: source,
      GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.2.3"
    }
  });
  return { ...result, cwd, html };
}

describe("publication artifact verification", () => {
  test("copies the exact tested HTML after checking release identity", () => {
    const result = verifyFixture();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(readFileSync(join(result.cwd, "dist/index.html"), "utf8")).toBe(result.html);
    expect(JSON.parse(readFileSync(join(result.cwd, "dist/coverage-summary.json"), "utf8"))).toEqual({ report: "coverage-summary.json" });
  });

  test.each([
    ["commit", ({ manifest }) => { manifest.commit = "0".repeat(40); }, "Distribution commit"],
    ["tag", ({ manifest }) => { manifest.version = "1.2.4"; }, "Tag does not match"],
    ["package", ({ pkg }) => { pkg.version = "1.2.2"; }, "package.json does not match"],
    ["lockfile", ({ lock }) => { lock.packages[""].version = "1.2.2"; }, "package-lock.json does not match"],
    ["bytes", ({ manifest }) => { manifest.sha256 = "0".repeat(64); }, "Distribution SHA-256"],
    ["coverage report", ({ manifest }) => { manifest.reports["coverage-summary.json"] = "0".repeat(64); }, "coverage-summary.json SHA-256"],
    ["coverage badge", ({ manifest }) => { manifest.reports["coverage-badge.json"] = "0".repeat(64); }, "coverage-badge.json SHA-256"]
  ])("rejects a mismatched %s before publication", (_name, change, message) => {
    const result = verifyFixture(change);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
  });
});

describe("publication CI selection", () => {
  const action = readFileSync(resolve(".github/actions/validated-dist/action.yml"), "utf8");
  const script = action.match(/script: \|\r?\n((?: {10}[^\r\n]*\r?\n)+)/)[1]
    .split(/\r?\n/).map(line => line.slice(10)).join("\n");
  const runSelection = new (Object.getPrototypeOf(async function () {}).constructor)(
    "require", "github", "context", "core", "process", script
  );
  const candidate = (head_branch, event) => ({
    id: 123, head_sha: commit, head_branch, event, status: "completed", conclusion: "success",
    head_repository: { full_name: "chemimage/not-envi" }
  });

  async function select(runs, reachable = true) {
    const core = { setOutput: vi.fn(), info: vi.fn() };
    const execFileSync = vi.fn((_command, args) => {
      if (args[0] === "merge-base" && !reachable) throw new Error("not reachable from main");
      return commit;
    });
    await runSelection(() => ({ execFileSync }), {
      rest: { actions: { listWorkflowRuns: async () => ({ data: { workflow_runs: runs } }) } }
    }, { repo: { owner: "chemimage", repo: "not-envi" } }, core, {
      env: { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.2.3" }
    });
    return core;
  }

  test.each([["main", "push"], ["main", "workflow_dispatch"], ["v1.2.3", "workflow_dispatch"]])(
    "accepts successful %s CI from %s at the release commit", async (branch, event) => {
      const core = await select([candidate(branch, event)]);
      expect(core.setOutput).toHaveBeenCalledWith("run-id", "123");
    }
  );

  test.each([["another-branch", "workflow_dispatch"], ["v1.2.2", "workflow_dispatch"], ["main", "pull_request"]])(
    "rejects %s CI from %s", async (branch, event) => {
      await expect(select([candidate(branch, event)])).rejects.toThrow("Successful CI is required");
    }
  );

  test("rejects a tag whose commit is outside main", async () => {
    await expect(select([candidate("v1.2.3", "workflow_dispatch")], false)).rejects.toThrow("not reachable from main");
  });
});
