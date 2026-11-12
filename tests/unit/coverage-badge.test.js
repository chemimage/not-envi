import { afterEach, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("scripts/coverage-badge.mjs");
const fixtures = [];
afterEach(() => fixtures.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

function generate(lines) {
  const cwd = mkdtempSync(join(tmpdir(), "hyve-coverage-"));
  fixtures.push(cwd);
  mkdirSync(join(cwd, "coverage"));
  writeFileSync(join(cwd, "coverage/coverage-summary.json"), JSON.stringify({ total: { lines } }));
  return { ...spawnSync(process.execPath, [script], { cwd, encoding: "utf8" }), cwd };
}

test("badge reports measured line counts with one decimal of precision", () => {
  const result = generate({ total: 3, covered: 1, pct: 99 });
  expect(result.status).toBe(0);
  expect(JSON.parse(readFileSync(join(result.cwd, "coverage/coverage-badge.json"), "utf8"))).toEqual({
    schemaVersion: 1, label: "JS line coverage", message: "33.3%", color: "orange"
  });
});

test.each([{ total: 0, covered: 0 }, { total: 10, covered: 11 }, { total: 10 }, { total: 10, covered: -1 }])(
  "refuses an unmeasured or inconsistent summary %j", lines => {
    const result = generate(lines);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("measured JavaScript line counts");
  }
);
