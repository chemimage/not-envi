import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const repository = "chemimage/not-envi";
const remoteHost = "inference";
const remoteDirectory = "/srv/www/hyve";
const files = ["index.html", "coverage-summary.json", "coverage-badge.json", "manifest.json"];

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8"
  });
  if (result.error) throw new Error(`Cannot run ${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} failed (exit ${result.status ?? result.signal}).`);
  return capture ? result.stdout.trim() : "";
}

export function selectSuccessfulRun(runs) {
  const eligible = runs.filter((run) => run.headBranch === "main" && run.event === "push"
    && run.status === "completed" && run.conclusion === "success"
    && Number.isSafeInteger(run.databaseId) && run.databaseId > 0 && /^[0-9a-f]{40}$/.test(run.headSha));
  eligible.sort((a, b) => b.databaseId - a.databaseId);
  if (!eligible.length) throw new Error("No successful main CI run is available. Wait for CI to pass and try again.");
  return eligible[0];
}

export function verifyDistribution(directory, run) {
  const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
  if (manifest.commit !== run.headSha) throw new Error("Artifact commit does not match the selected CI run.");
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("Artifact has an invalid release version.");
  for (const name of files.filter((name) => name !== "manifest.json")) {
    const expected = name === "index.html" ? manifest.sha256 : manifest.reports?.[name];
    const actual = createHash("sha256").update(readFileSync(path.join(directory, name))).digest("hex");
    if (actual !== expected) throw new Error(`${name} SHA-256 does not match the tested CI artifact.`);
  }
  return manifest;
}

export function installationScript() {
  // Each rename stays on the serving filesystem. The single-file app is never
  // removed before its replacement is ready; manifest is the completion marker.
  return `#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target=${remoteDirectory}
cd "$source_dir"
sha256sum -c SHA256SUMS
install -d -o root -g www-data -m 755 "$target"
stage=$(mktemp -d "$target/.deploy.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT HUP INT TERM
for name in index.html coverage-summary.json coverage-badge.json manifest.json; do
  install -o root -g www-data -m 644 "$source_dir/$name" "$stage/$name"
done
for name in coverage-summary.json coverage-badge.json index.html manifest.json; do
  mv -f -- "$stage/$name" "$target/$name"
done
echo "Installed verified distribution into $target"
`;
}

export function main(args = process.argv.slice(2)) {
  if (args.some((arg) => arg !== "--download-only" && arg !== "--help")) {
    throw new Error("Usage: build-and-deploy-remote.bat [--download-only]");
  }
  if (args.includes("--help")) {
    console.log("Usage: build-and-deploy-remote.bat [--download-only]\nDownloads and verifies the latest successful main CI artifact; deploys over local SSH unless --download-only is set.\nRequires Node.js 22+, authenticated GitHub CLI (gh auth login), and SSH/SCP for deployment.");
    return;
  }
  const downloadOnly = args.includes("--download-only");
  run("gh", ["--version"], true);
  if (!downloadOnly) run("ssh", ["-V"]);
  const runs = JSON.parse(run("gh", ["run", "list", "--repo", repository,
    "--workflow", "ci.yml", "--branch", "main", "--event", "push", "--status", "success", "--limit", "1",
    "--json", "databaseId,headSha,headBranch,event,status,conclusion,url"], true));
  const selected = selectSuccessfulRun(runs);
  console.log(`Selected successful main CI: ${selected.url}\nCommit: ${selected.headSha}`);
  const directory = mkdtempSync(path.join(tmpdir(), "hyve-deploy-"));
  let keepDownload = false;
  try {
    run("gh", ["run", "download", String(selected.databaseId), "--repo", repository,
      "--name", "site-dist", "--dir", directory]);
    const manifest = verifyDistribution(directory, selected);
    console.log(`Verified v${manifest.version}, SHA-256 ${manifest.sha256}`);
    if (downloadOnly) {
      keepDownload = true;
      console.log(`Verified files retained at ${directory}\nNo server changes made.`);
      return;
    }
    writeFileSync(path.join(directory, "SHA256SUMS"), files.map((name) => {
      const hash = createHash("sha256").update(readFileSync(path.join(directory, name))).digest("hex");
      return `${hash}  ${name}\n`;
    }).join(""));
    writeFileSync(path.join(directory, "install.sh"), installationScript());
    const staging = run("ssh", [remoteHost, "mktemp -d /tmp/hyve-deploy.XXXXXXXX"], true);
    if (!/^\/tmp\/hyve-deploy\.[a-zA-Z0-9]{8}$/.test(staging)) {
      throw new Error("Server returned an unexpected staging path; refusing to upload or install.");
    }
    console.log(`Deploying to ${remoteHost}:${remoteDirectory} (sudo may prompt)...`);
    try {
      run("scp", [...files, "SHA256SUMS", "install.sh"].map((name) => path.join(directory, name))
        .concat(`${remoteHost}:${staging}/`));
      run("ssh", ["-t", remoteHost, `sudo sh '${staging}/install.sh'`]);
      console.log(`Deployed v${manifest.version} (${manifest.commit}) to ${remoteHost}:${remoteDirectory}.`);
    } finally {
      try { run("ssh", [remoteHost, `rm -rf -- '${staging}'`]); } catch (error) {
        console.warn(`Remote staging cleanup failed: ${error.message} Staging path: ${staging}`);
      }
    }
  } finally {
    if (!keepDownload) {
      const resolved = path.resolve(directory);
      if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("hyve-deploy-")) {
        throw new Error("Refusing to clean an unexpected local staging directory.");
      }
      rmSync(resolved, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    console.error(`Deployment failed: ${error.message}`);
    process.exitCode = 1;
  }
}
