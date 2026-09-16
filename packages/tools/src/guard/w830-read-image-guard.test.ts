/**
 * B4 / W819-7 (R3): read_image is a READ tool — its path argument must be
 * arbitrated with read semantics, not the fail-closed write floor.
 *
 * Source: \`/server-center/runtime/worker-exec/results/W828-R3修复计划-C-studio-web-tests-security.md\`
 * §B4 W819-7 — "真实 registry + PathGuard 派发 read_image({path: <read root 内
 * png>}) → allow；对只写根外路径 → 以 read 语义（path_forbidden）拒绝。走
 * registry.dispatch，不直接调 policy。"
 *
 * The discriminator is an operator-declared READ root: it is readable but NOT
 * writable, so a read-image call that is checked as a write is refused there.
 * The deny case uses a path that is neither a read root nor the workspace.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAttachmentStore } from "../attachments/store.js";
import { createToolRegistry } from "../registry.js";
import { cleanupTempDirs, makeDir, makeTempDir, writeFixture } from "../testing/tmp.test-util.js";
import { readImageTool } from "../tools/read-image.js";
import { PathGuard, PathGuardPolicy } from "./path-guard.js";

/** A real 1x1 PNG. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const stores: string[] = [];

afterEach(() => {
  for (const dir of stores.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => cleanupTempDirs());

function store(): ReturnType<typeof createAttachmentStore> {
  const dir = mkdtempSync(join(tmpdir(), "w819-7-att-"));
  stores.push(dir);
  return createAttachmentStore(join(dir, "attachments"));
}

describe("B4/W819-7: read_image path is a READ path", () => {
  it("allows a readable root and denies an out-of-root path with read semantics", async () => {
    const ws = makeTempDir("w819-7-ws");
    const readRoot = makeDir(makeTempDir("w819-7-ro"), "readonly");
    const outside = makeDir(makeTempDir("w819-7-out"), "elsewhere");
    writeFixture(readRoot, "logo.png", "");
    writeFileSync(join(readRoot, "logo.png"), PNG_1X1);
    writeFileSync(join(outside, "secret.png"), PNG_1X1);

    const registry = createToolRegistry(
      [readImageTool({ attachments: store() })],
      [new PathGuard(new PathGuardPolicy({ workspace: ws, readRoots: [readRoot] }))],
    );

    // A read root is readable but NOT writable: allow here proves read semantics.
    const allowed = await registry.dispatch({
      call_id: "c1",
      name: "read_image",
      args: { path: join(readRoot, "logo.png") },
    });
    expect(allowed.error).toBeNull();
    expect((allowed.value as { ok: boolean }).ok).toBe(true);
    expect((allowed.value as { media_type: string }).media_type).toBe("image/png");

    // A path that is neither the workspace nor a read root is denied on READ
    // grounds (an undeclared tool would have produced the WRITE message, but the
    // cold fact here is path_forbidden either way — the test above is the one
    // that distinguishes the two).
    const denied = await registry.dispatch({
      call_id: "c2",
      name: "read_image",
      args: { path: join(outside, "secret.png") },
    });
    expect(denied.value).toBeNull();
    expect(denied.error).toContain("toolguard: code=path_forbidden");
    expect(denied.decision?.kind).toBe("deny");
  });
});
