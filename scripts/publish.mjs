#!/usr/bin/env node
/**
 * publish.mjs — the ONLY sanctioned way to publish to npm.
 *
 * Why this exists: a publish is irreversible (a version can never be
 * republished, and the tarball stays public forever), so it must never happen
 * as a side effect of "finishing the release steps". The owner's rule is
 * explicit: **no npm push without their authorization**.
 *
 * So this wrapper fails closed unless a HUMAN sets the authorization for that
 * one command, and it prints exactly what it is about to publish so the
 * confirmation is informed rather than ceremonial:
 *
 *   CELESTEA_PUBLISH_AUTHORIZED=1 pnpm run publish
 *
 * It also refuses to publish from a tree that is not the tagged release
 * commit, which is the other half of the same mistake (a build made before the
 * tag ships a UI that claims the previous version).
 *
 * Calling `pnpm -r publish` directly bypasses this file: that is a policy
 * violation, not a supported path.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AUTHORIZED = process.env["CELESTEA_PUBLISH_AUTHORIZED"] === "1";

function fail(lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

if (!AUTHORIZED) {
  const version = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
  fail([
    "✗ publish REFUSED — npm publishing requires the owner's explicit authorization.",
    "",
    `  This would publish ${version} to the public npm registry, which cannot be undone.`,
    "  Ask the owner first; only then, for that one command:",
    "",
    "    CELESTEA_PUBLISH_AUTHORIZED=1 pnpm run publish",
    "",
    "  (Do not call `pnpm -r publish` directly — it skips this gate and the tag check.)",
  ]);
}

const version = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
const tag = `v${version}`;

function git(...args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
}

const dirty = git("status", "--porcelain");
if (dirty !== "") {
  fail(["✗ publish REFUSED — the working tree is not clean:", dirty, "", "  Commit first: the published tarballs must be reproducible from the tag."]);
}

let head = "";
let tagCommit = "";
try {
  head = git("rev-parse", "HEAD");
  tagCommit = git("rev-parse", `${tag}^{commit}`);
} catch {
  fail([`✗ publish REFUSED — no ${tag} tag in this repository.`, "", `  Tag BEFORE building: the frontend version comes from git describe --tags.`, `  See docs/AGENT.md §4.`]);
}
if (head !== tagCommit) {
  fail([
    `✗ publish REFUSED — HEAD is not ${tag}.`,
    `  HEAD  = ${head}`,
    `  ${tag} = ${tagCommit}`,
    "",
    "  Publishing an untagged commit is how a release ends up claiming the previous version.",
  ]);
}

console.log(`[publish] authorized by CELESTEA_PUBLISH_AUTHORIZED=1`);
console.log(`[publish] tree clean, HEAD == ${tag} (${head.slice(0, 7)})`);
console.log(`[publish] publishing 9 packages at ${version} ...`);
// shell on Windows only: pnpm is a .cmd shim there, and execFileSync does not
// apply PATHEXT — spawning the bare name raises ENOENT. Same rule as run-with-env.
execFileSync("pnpm", ["-r", "publish", "--access", "public"], {
  cwd: REPO,
  stdio: "inherit",
  shell: process.platform === "win32",
});
