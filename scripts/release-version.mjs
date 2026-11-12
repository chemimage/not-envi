import { execFileSync } from "node:child_process";

const ranks = { none: 0, patch: 1, minor: 2, major: 3 };

export function calculateReleaseVersion({ cwd = process.cwd() } = {}) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  if (git("rev-parse", "--is-shallow-repository") === "true") {
    throw new Error("Version calculation requires full Git history and release tags. Fetch with --unshallow --tags first.");
  }
  const tags = git("tag", "--merged", "HEAD").split("\n")
    .filter((tag) => /^[vV]?\d+\.\d+\.\d+$/.test(tag))
    .map((tag) => ({ tag, parts: tag.replace(/^[vV]/, "").split(".").map(BigInt) }));
  tags.sort((a, b) => {
    for (let i = 0; i < 3; i++) {
      if (a.parts[i] !== b.parts[i]) return a.parts[i] > b.parts[i] ? -1 : 1;
    }
    return a.tag.localeCompare(b.tag);
  });
  if (!tags.length) throw new Error("No reachable stable release tag found. Fetch the release tags before calculating a version.");
  const { tag, parts } = tags[0];
  const source = parts.join(".");
  const commitsSinceSource = Number(git("rev-list", "--count", `${tag}..HEAD`));
  const messages = git("log", `${tag}..HEAD`, "--format=%B%x00").split("\0").filter((body) => body.trim());
  let bump = 0;
  for (const message of messages) {
    const annotations = [...message.matchAll(/\+semver:\s*(major|minor|patch|none)\b/gi)].map((match) => match[1].toLowerCase());
    // A no-bump commit does not suppress a feature elsewhere in the batch.
    const rank = annotations.includes("none") ? 0 : annotations.length
      ? Math.max(...annotations.map((value) => ranks[value])) : ranks.patch;
    bump = Math.max(bump, rank);
  }
  const next = [...parts];
  if (bump) {
    const index = 3 - bump;
    next[index] += 1n;
    for (let i = index + 1; i < 3; i++) next[i] = 0n;
  }
  return { version: next.join("."), source, commitsSinceSource, sha: git("rev-parse", "HEAD") };
}
