/** Locate the repository root (the directory holding pnpm-workspace.yaml). */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

export function repoRoot(from: string = import.meta.url): string {
  if (cached) return cached;
  let dir = dirname(fileURLToPath(from));
  for (let i = 0; i < 12; i++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) {
      cached = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`repository root not found above ${from}`);
}

export function contractPath(...parts: string[]): string {
  return resolve(repoRoot(), "contracts", ...parts);
}

export function fixturePath(...parts: string[]): string {
  return resolve(repoRoot(), "fixtures", ...parts);
}

export function reportPath(...parts: string[]): string {
  return resolve(repoRoot(), "reports", ...parts);
}
