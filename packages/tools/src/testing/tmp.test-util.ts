/** Temp-dir helpers shared by the tools tests. */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const created: string[] = [];

/** A fresh temp dir (removed by [cleanupTempDirs]). */
export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `celestea-tools-${prefix}-`));
  created.push(dir);
  return dir;
}

export function makeDir(parent: string, name: string): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeFixture(dir: string, name: string, content: string | Buffer): string {
  const target = join(dir, name);
  writeFileSync(target, content);
  return target;
}

export function cleanupTempDirs(): void {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
}
