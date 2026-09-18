/**
 * W880 test isolation: point CELESTEA_HOME at a throwaway directory so no test
 * ever writes into the developer's (or CI user's) real data root. A FRESH
 * directory per test also keeps the canonical container (keyed by workspace
 * basename) from leaking sessions between tests that reuse a basename.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

let home: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "celestea-home-test-"));
  process.env.CELESTEA_HOME = home;
});

afterEach(() => {
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

