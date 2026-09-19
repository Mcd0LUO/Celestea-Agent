/**
 * W887 + H: the studio's version string, resolvable BOTH in the source checkout
 * and from a globally installed package.
 *
 * The single source of truth is `scripts/version.mjs` (git tag). That file only
 * exists in the checkout, so it is imported DYNAMICALLY: a source run gets the
 * git-derived version, an installed package (no checkout, no git) falls back to
 * its own `package.json` version. A missing toolchain degrades instead of
 * failing module load, and the answer is cached after the first resolution.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

/** The installed package's own version — the release truth. */
function ownPackageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    try {
      const doc = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown };
      if (typeof doc.version === "string" && doc.version !== "") return doc.version;
    } catch {
      // No package.json here; keep walking toward the root.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "dev";
}

/** The git-derived version in a checkout, else the package version. */
export async function resolveStudioVersion(): Promise<string> {
  if (cached !== null) return cached;
  try {
    // W887: the checkout-only toolchain seam, imported dynamically so an
    // installed package (no scripts/) degrades to its package.json version.
    const mod = (await import("../../../scripts/version.mjs")) as { computeVersion: () => { version: string } };
    cached = mod.computeVersion().version;
  } catch {
    cached = ownPackageVersion();
  }
  return cached;
}

/** Test seam: forget the memoized answer. */
export function resetStudioVersionCache(): void {
  cached = null;
}
