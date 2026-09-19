#!/usr/bin/env node
/**
 * build-contracts.mjs (H) — stage the frozen `contracts/` INSIDE @celestea/core.
 *
 * Why: the contract data files used to be resolved from the git checkout root
 * (`repoRoot()/contracts`). After `npm i -g celestea-agent` there is no checkout,
 * so the frozen files must travel with the package. This copies them to
 * `packages/core/contracts`, which `packages/core/src/repo.ts` finds by walking
 * up from its own module location — cwd-independent and install-safe.
 *
 * The source tree is untouched until a build runs; the copy is a build artifact.
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(REPO_ROOT, "contracts");
const TARGET = join(REPO_ROOT, "packages", "core", "contracts");

if (!existsSync(SOURCE)) {
  console.error("[build-contracts] missing source " + SOURCE);
  process.exit(1);
}
rmSync(TARGET, { recursive: true, force: true });
cpSync(SOURCE, TARGET, { recursive: true });
console.log("[build-contracts] staged " + SOURCE + " -> " + TARGET);
