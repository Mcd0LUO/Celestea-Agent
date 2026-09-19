#!/usr/bin/env node
/**
 * release-check.mjs — the MECHANICAL release gate (H, iteration G follow-up).
 *
 * Why it exists: `apps/studio/webdist/` (the frontend shipped inside the
 * `@celestea/studio` tarball) was once a STALE build while every other gate was
 * green, so users installed an outdated UI. "Someone remembers to rebuild" is
 * not a control. This script asserts the facts a release must satisfy and exits
 * non-zero with a concrete reason AND a fix command for each failure.
 *
 * Checks:
 *   1. webdist freshness — build-meta sha/commits/version of the staged webdist
 *      must equal apps/web/dist's;
 *   2. manifests — the 9 publishable packages: private:false, publishConfig
 *      access public, non-empty files, and every bin target exists + is +x;
 *   3. versions — root and all 9 packages share one version;
 *   4. tarball inspection — `pnpm pack` each package and assert no `workspace:`
 *      dependency survives, no source/test/secret paths ship, no credential
 *      pattern appears in any member, AND every REQUIRED path plus every
 *      declared `bin`/`main` actually ships (see REQUIRED below).
 *
 * Usage: node scripts/release-check.mjs   (or `pnpm run release:check`)
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readTarball, readText } from "./lib/tar.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The 9 independently published packages (dir relative to the repo root). */
const PACKAGES = [
  { dir: "apps/cli", name: "celestea-agent" },
  { dir: "packages/core", name: "@celestea/core" },
  { dir: "packages/session", name: "@celestea/session" },
  { dir: "packages/llm", name: "@celestea/llm" },
  { dir: "packages/tools", name: "@celestea/tools" },
  { dir: "packages/agent-loop", name: "@celestea/agent-loop" },
  { dir: "packages/workers", name: "@celestea/workers" },
  { dir: "packages/runtime", name: "@celestea/runtime" },
  { dir: "apps/studio", name: "@celestea/studio" },
];

/** Path fragments that must never appear in a published tarball. */
const FORBIDDEN = [
  { label: "src/", test: (p) => p === "src" || p.startsWith("src/") || p.includes("/src/") },
  { label: "*.test.*", test: (p) => /\.test\./.test(p) },
  { label: "tests/", test: (p) => p === "tests" || p.startsWith("tests/") || p.includes("/tests/") },
  { label: ".celestea", test: (p) => p.includes(".celestea") },
  { label: ".env", test: (p) => p.split("/").pop().startsWith(".env") },
  { label: "*.pem", test: (p) => p.endsWith(".pem") },
  { label: "credentials", test: (p) => p.toLowerCase().includes("credentials") },
];

/**
 * Paths a tarball MUST contain — the mirror image of FORBIDDEN.
 *
 * Why this exists: "someone remembers to include it" is not a control either.
 * Without `contracts/` inside @celestea/core, `repoRoot()`/contractsDir()
 * throw on a globally installed package (no workspace marker to walk up to) and
 * `celestea web` cannot boot at all; without `webdist/` inside
 * @celestea/studio the studio has no UI to serve. Both failures used to ship
 * GREEN, because the tarball check only looked for things that must NOT be
 * there. Paths are relative to `package/` inside the tarball.
 */
const REQUIRED = [
  {
    name: "@celestea/core",
    paths: ["contracts/endpoints.json", "contracts/sse-events.json"],
    why: "an installed package has no workspace marker, so the frozen contracts must travel with it",
  },
  { name: "@celestea/studio", paths: ["webdist/index.html"], why: "the studio serves the frontend from webdist" },
  { name: "celestea-agent", paths: ["dist/main.js"], why: "the celestea bin entry point" },
];

/** Credential shapes that must not appear in any packaged byte. */
const SECRETS = [
  { label: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { label: "npm token", re: /npm_[A-Za-z0-9]{20,}/ },
  { label: "sk- key", re: /sk-[A-Za-z0-9]{20,}/ },
  { label: "Slack token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { label: "AWS access key", re: /AKIA[0-9A-Z]{16}/ },
  { label: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

const failures = [];
const fix = (check, detail, command) => failures.push({ check, detail, command });

/** 1. webdist must be a byte-faithful copy of the current frontend build. */
function checkWebdist() {
  const webMeta = join(REPO, "apps/web/dist/build-meta.json");
  const stagedMeta = join(REPO, "apps/studio/webdist/build-meta.json");
  if (!existsSync(webMeta)) {
    fix("webdist", "apps/web/dist/build-meta.json is missing (frontend not built)", "pnpm run build");
    return;
  }
  if (!existsSync(stagedMeta)) {
    fix("webdist", "apps/studio/webdist/build-meta.json is missing (webdist not staged)", "pnpm run build");
    return;
  }
  const web = JSON.parse(readFileSync(webMeta, "utf8"));
  const staged = JSON.parse(readFileSync(stagedMeta, "utf8"));
  for (const field of ["sha", "commits", "version"]) {
    if (web[field] !== staged[field]) {
      fix("webdist", `webdist is STALE: ${field} web=${web[field]} staged=${staged[field]}`, "pnpm run build");
      return;
    }
  }
  // The version the frontend REPORTS must equal the version being published.
  // scripts/version.mjs derives it from `git describe --tags`, so a build made
  // before the release tag exists ships a UI claiming the PREVIOUS version —
  // exactly the W887 bug (UI showed 2.6.5 while the newest tag was v2.7.0). Both
  // checks above are internal-consistency only and cannot see this.
  const rootVersion = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
  if (staged.version !== rootVersion) {
    fix(
      "webdist",
      `webdist reports version ${staged.version} but the release is ${rootVersion} — tag BEFORE building`,
      `git tag v${rootVersion} && pnpm run build`,
    );
  }
}

/** 2. the publishable manifest shape (private/access/files/bin). */
function checkManifests() {
  for (const { dir, name } of PACKAGES) {
    const path = join(REPO, dir, "package.json");
    if (!existsSync(path)) {
      fix("manifest", `${name}: ${dir}/package.json is missing`, "restore the package manifest");
      continue;
    }
    const doc = JSON.parse(readFileSync(path, "utf8"));
    if (doc.name !== name) fix("manifest", `${name}: package name is ${JSON.stringify(doc.name)}`, `set "name": "${name}"`);
    if (doc.private !== false) fix("manifest", `${name}: private is ${JSON.stringify(doc.private)} (must be false)`, `set "private": false`);
    if (doc.publishConfig?.access !== "public") fix("manifest", `${name}: publishConfig.access is ${JSON.stringify(doc.publishConfig?.access)}`, `set "publishConfig": { "access": "public" }`);
    if (!Array.isArray(doc.files) || doc.files.length === 0) fix("manifest", `${name}: files is empty`, `add a non-empty "files" whitelist`);
    if (name === "celestea-agent" && (doc.bin === undefined || Object.keys(doc.bin).length === 0)) {
      fix("manifest", "celestea-agent: no bin", `add "bin": { "celestea": "./dist/main.js" }`);
    }
    for (const [binName, rel] of Object.entries(doc.bin ?? {})) {
      const file = resolve(REPO, dir, rel);
      if (!existsSync(file)) {
        fix("manifest", `${name}: bin ${binName} -> ${rel} does not exist`, "pnpm run build");
        continue;
      }
      if ((statSync(file).mode & 0o111) === 0) {
        fix("manifest", `${name}: bin ${binName} -> ${rel} is not executable`, "pnpm run build");
      }
    }
  }
}

/** 3. one version across root + every publishable package. */
function checkVersions() {
  const root = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
  for (const { dir, name } of PACKAGES) {
    const version = JSON.parse(readFileSync(join(REPO, dir, "package.json"), "utf8")).version;
    if (version !== root) fix("version", `${name}: version ${version} != root ${root}`, `set version ${root} in ${dir}/package.json`);
  }
}

/** Inspect ONE packed tarball (deps / forbidden paths / secrets). */
function checkOneTarball(dir, name, tmp) {
  let tarball;
  try {
    const stdout = execFileSync("pnpm", ["pack", "--pack-destination", tmp], { cwd: join(REPO, dir), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const line = stdout.split("\n").map((l) => l.trim()).filter((l) => l.endsWith(".tgz")).pop();
    if (line === undefined) throw new Error("pnpm pack printed no .tgz path");
    tarball = line.startsWith("/") ? line : join(tmp, line);
  } catch (e) {
    fix("tarball", `${name}: pnpm pack failed: ${e instanceof Error ? e.message : String(e)}`, "pnpm run build");
    return;
  }
  const files = readTarball(tarball);
  const manifest = readText(files, "package/package.json");
  if (manifest === null) {
    fix("tarball", `${name}: tarball has no package/package.json`, "pnpm run build");
    return;
  }
  const doc = JSON.parse(manifest);
  for (const [dep, range] of Object.entries(doc.dependencies ?? {})) {
    if (String(range).startsWith("workspace:")) fix("tarball", `${name}: dependency ${dep}=${range} still uses the workspace protocol`, "publish with pnpm (pnpm pack rewrites workspace:*); never npm pack");
  }
  for (const member of files.keys()) {
    const rel = member.replace(/^package\//, "");
    for (const rule of FORBIDDEN) {
      if (rule.test(rel)) fix("tarball", `${name}: forbidden path ${rel} (${rule.label})`, `remove it from the "files" whitelist`);
    }
  }
  const rels = new Set([...files.keys()].map((m) => m.replace(/^package\//, "")));
  for (const rule of REQUIRED) {
    if (rule.name !== name) continue;
    for (const p of rule.paths) {
      if (!rels.has(p)) {
        fix("tarball", `${name}: required path ${p} is MISSING (${rule.why})`, `add it to "files" in ${dir}/package.json and rebuild`);
      }
    }
  }
  // Every entry point the SHIPPED manifest declares must actually be in the
  // tarball. Note: npm/pnpm force-include the `main` and `bin` targets even when
  // `files` omits them, so those branches are belt-and-braces. `exports` targets
  // (notably `types`) are NOT force-included — a partial `files` list such as
  // ["dist/index.js"] would silently ship a package with no type declarations.
  const collect = (v, out) => {
    if (typeof v === "string") out.push(v);
    else if (v !== null && typeof v === "object") for (const x of Object.values(v)) collect(x, out);
    return out;
  };
  const bins = typeof doc.bin === "string" ? [doc.bin] : Object.values(doc.bin ?? {});
  // pnpm normalises `exports.types` into a top-level `types` in the packed
  // manifest, so the same path can arrive twice — dedupe to keep one report line.
  const entries = [...new Set([...bins, ...[doc.main, doc.types].filter((x) => x !== undefined), ...collect(doc.exports, [])])];
  for (const target of entries) {
    const rel = String(target).replace(/^\.\//, "");
    if (!/\.(js|cjs|mjs|d\.ts)$/.test(rel)) continue; // ignore non-code assets such as ./package.json
    if (!rels.has(rel)) fix("tarball", `${name}: declared entry ${rel} is not in the tarball`, `add it to "files" in ${dir}/package.json`);
  }
  for (const [member, buf] of files.entries()) {
    const text = buf.toString("utf8");
    for (const secret of SECRETS) {
      if (secret.re.test(text)) fix("tarball", `${name}: ${secret.label} pattern in ${member}`, "remove the credential and rotate it");
    }
  }
}

/** 4. pack every package and inspect what actually ships. */
function checkTarballs() {
  const tmp = mkdtempSync(join(tmpdir(), "celestea-release-check-"));
  try {
    for (const { dir, name } of PACKAGES) checkOneTarball(dir, name, tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Run every check; print failures + fixes; exit non-zero on any failure. */
function main() {
  checkWebdist();
  checkManifests();
  checkVersions();
  checkTarballs();
  if (failures.length === 0) {
    console.log("[release-check] OK — webdist fresh, 9 manifests publishable, versions aligned, tarballs clean");
    return 0;
  }
  console.error(`[release-check] FAILED (${failures.length})`);
  for (const f of failures) console.error(`  ✗ [${f.check}] ${f.detail}\n      fix: ${f.command}`);
  return 1;
}

process.exit(main());
