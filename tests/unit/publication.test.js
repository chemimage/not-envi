import { describe, expect, test } from "vitest";
import { planPublication } from "../../scripts/publication.mjs";

const commit = "a".repeat(40);
const other = "b".repeat(40);
const checked = { manifest: { commit, version: "1.12.0" }, calculatedVersion: "1.12.0",
  testedCommit: commit, mainCommit: commit, tagCommit: null };

describe("automatic publication", () => {
  test("creates a new calculated tag only for the tested current main commit", () => {
    expect(planPublication(checked)).toEqual({ publish: true, tag: "v1.12.0", createTag: true });
  });
  test("does not deploy an older CI result after main advances", () => {
    expect(planPublication({ ...checked, mainCommit: other }).publish).toBe(false);
  });
  test("no-bump commits preserve the existing version tag", () => {
    expect(planPublication({ ...checked, sourceVersion: "1.12.0", tagCommit: other }).publish).toBe(false);
  });
  test("rejects a new-version tag collision instead of moving or silently reusing it", () => {
    expect(() => planPublication({ ...checked, sourceVersion: "1.11.0", tagCommit: other })).toThrow("refusing to move");
  });
  test("rerunning publication of the same tagged commit repairs publication without moving its tag", () => {
    expect(planPublication({ ...checked, tagCommit: commit })).toEqual({ publish: true, tag: "v1.12.0", createTag: false });
  });
  test.each([
    { manifest: { commit: other, version: "1.12.0" } },
    { manifest: { commit, version: "9.9.9" } },
    { manifest: { commit, version: "malformed" }, calculatedVersion: "malformed" }
  ])("rejects incorrect artifact identity before tagging", (change) => {
    expect(() => planPublication({ ...checked, ...change })).toThrow();
  });
});
