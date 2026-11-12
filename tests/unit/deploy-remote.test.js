import { afterEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { selectSuccessfulRun, verifyDistribution } from "../../scripts/deploy-remote.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("hyve-deploy-test-")) {
      throw new Error("Unexpected test cleanup directory.");
    }
    rmSync(resolved, { recursive: true, force: true });
  }
});

const successful = { databaseId: 12, headBranch: "main", event: "push", status: "completed",
  conclusion: "success", headSha: "a".repeat(40) };

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "hyve-deploy-test-"));
  directories.push(directory);
  const manifest = { commit: successful.headSha, version: "1.11.0", reports: {} };
  for (const [name, content] of Object.entries({ "index.html": "<html>tested</html>",
    "coverage-summary.json": '{"total":{}}', "coverage-badge.json": '{"message":"90%"}' })) {
    writeFileSync(path.join(directory, name), content);
    const hash = createHash("sha256").update(content).digest("hex");
    if (name === "index.html") manifest.sha256 = hash;
    else manifest.reports[name] = hash;
  }
  writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  return { directory, manifest };
}

describe("local CI artifact deployment", () => {
  test("selects the newest successful main push, excluding failed, pending and PR builds", () => {
    expect(selectSuccessfulRun([
      successful,
      { ...successful, databaseId: 13, conclusion: "failure" },
      { ...successful, databaseId: 14, status: "in_progress" },
      { ...successful, databaseId: 15, event: "pull_request" },
      { ...successful, databaseId: 16, headBranch: "feature" },
      { ...successful, databaseId: 11 }
    ])).toEqual(successful);
    expect(() => selectSuccessfulRun([{ ...successful, conclusion: "failure" }])).toThrow("No successful main CI");
  });

  test("verifies an artifact independently of the local checkout version", () => {
    const { directory, manifest } = fixture();
    expect(verifyDistribution(directory, successful)).toEqual(manifest);
  });

  test("rejects an artifact belonging to a different commit", () => {
    const { directory } = fixture();
    expect(() => verifyDistribution(directory, { ...successful, headSha: "b".repeat(40) })).toThrow("commit does not match");
  });

  test.each(["index.html", "coverage-summary.json", "coverage-badge.json"])("rejects changed %s bytes", (name) => {
    const { directory } = fixture();
    writeFileSync(path.join(directory, name), "changed");
    expect(() => verifyDistribution(directory, successful)).toThrow(`${name} SHA-256`);
  });
});
