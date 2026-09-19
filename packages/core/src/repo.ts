/** Locate the repository root (the directory holding pnpm-workspace.yaml). */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

/**
 * H (packaging): contracts shipped INSIDE this package, resolved from the
 * module's own location regardless of cwd.
 *
 * In a source checkout this file is `packages/core/src/repo.ts` / `dist/repo.js`,
 * so `<pkg>/contracts` sits one level up from `src`/`dist`. After
 * `npm i -g celestea-agent` the same relative walk finds
 * `@celestea/core/contracts` (shipped via `files`), so the frozen contract
 * files travel with the code instead of relying on the git checkout layout.
 */
function packagedContractsRoot(from: string): string | null {
  let dir = dirname(fileURLToPath(from));
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, "contracts");
    // The marker is the CONTRACT DATA file, not the directory name: the source
    // tree has a `src/contracts/` TS module directory, which must never win.
    if (existsSync(resolve(candidate, "endpoints.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The checkout root (the dir holding `pnpm-workspace.yaml`), or null. */
function workspaceMarkerRoot(from: string): string | null {
  let dir = dirname(fileURLToPath(from));
  for (let i = 0; i < 12; i++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function repoRoot(from: string = import.meta.url): string {
  if (cached) return cached;
  const workspace = workspaceMarkerRoot(from);
  if (workspace !== null) {
    cached = workspace;
    return workspace;
  }
  // H: an INSTALLED package has no workspace marker. Fall back to the
  // package-local contracts root's parent (still never the cwd), so a globally
  // installed `celestea` boots the same way the checkout does.
  const packaged = packagedContractsRoot(from);
  if (packaged !== null) {
    cached = dirname(packaged);
    return cached;
  }
  throw new Error(`repository root not found above ${from}`);
}

/**
 * Absolute path to the frozen `contracts/` directory.
 *
 * H: a SOURCE CHECKOUT always uses `<repo>/contracts` — the build-staged
 * `packages/core/contracts/` is a shipping artifact and must never shadow a
 * live edit of the repo's contracts in dev. Only an INSTALLED package (no
 * workspace marker) reads its own bundled `contracts/`.
 */
export function contractsDir(): string {
  const workspace = workspaceMarkerRoot(import.meta.url);
  if (workspace !== null) return resolve(workspace, "contracts");
  const packaged = packagedContractsRoot(import.meta.url);
  if (packaged !== null) return packaged;
  return resolve(repoRoot(), "contracts");
}

export function contractPath(...parts: string[]): string {
  return resolve(contractsDir(), ...parts);
}

export function fixturePath(...parts: string[]): string {
  return resolve(repoRoot(), "fixtures", ...parts);
}

export function reportPath(...parts: string[]): string {
  return resolve(repoRoot(), "reports", ...parts);
}
