#!/usr/bin/env node
/**
 * W847 W0: fail-loud Node major guard for the production start path.
 *
 * WHY A SCRIPT: the band lives in package.json engines.node, and this guard reads
 * it from there (one source of truth) instead of hardcoding a second copy. It only
 * compares the running major against the parsed band; it never downgrades, never
 * falls back, and exits non-zero when the band cannot be parsed (fail closed).
 *
 * Zero dependencies: node:fs / node:path / node:url only.
 *
 * Wired into scripts/run-studio-ts.sh (the systemd ExecStart path). pnpm does not
 * auto-run pre/post scripts by default, so a "prestart" hook would not fire.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(scriptDir, "..", "package.json");
const raw = JSON.parse(readFileSync(pkgPath, "utf8"));
const range = String((raw.engines && raw.engines.node) || "");
const match = /^>=\s*(\d+)\.\d+\.\d+\s+<\s*(\d+)\.\d+\.\d+$/.exec(range.trim());
if (match === null) {
  console.error("[node-guard] cannot parse engines.node=" + JSON.stringify(range) + " in " + pkgPath);
  process.exit(1);
}
const minMajor = Number(match[1]);
const maxMajor = Number(match[2]);
const current = process.versions.node;
const major = Number(current.split(".")[0]);
if (!Number.isInteger(major) || major < minMajor || major >= maxMajor) {
  console.error("[node-guard] refusing to start: node " + current + " is outside " + range + " (package.json engines.node)");
  process.exit(1);
}
console.log("[node-guard] node " + current + " is within " + range);
