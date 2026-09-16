/**
 * B2 / W812 P1-3 (R3) — read_image must reject an oversize file BEFORE buffering
 * it, through the REAL guarded registry.
 *
 * Source: /server-center/runtime/worker-exec/results/W827-R3修复计划-B-tools-workers-studio.md
 * §B2 W812 P1-3: "在允许根放一个 >4MiB 文件（可 truncate 稀疏文件），经真 guard +
 * registry 调 read_image，断言 too_large，并...证明未整块进内存".
 *
 * The memory proof is the store's put(): bytes cross into the content-addressed
 * store only through put(), so a call count of zero for an oversize path is the
 * guarantee that the file was never buffered.
 */

import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ATTACHMENT_MAX_BYTES, createAttachmentStore, type AttachmentStore } from "../attachments/store.js";
import { createToolRegistry } from "../registry.js";
import { cleanupTempDirs, makeDir, makeTempDir } from "../testing/tmp.test-util.js";
import { readImageTool } from "../tools/read-image.js";
import { PathGuard, PathGuardPolicy } from "./path-guard.js";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => cleanupTempDirs());

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

describe("B2 / W812 P1-3: read_image bounded read", () => {
  it("rejects a >4MiB path as too_large without ever handing bytes to the store", async () => {
    const ws = makeTempDir("w833-cap-ws");
    const root = makeDir(makeTempDir("w833-cap-root"), "images");
    const bigPath = join(root, "huge.png");
    writeFileSync(bigPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    truncateSync(bigPath, ATTACHMENT_MAX_BYTES + 8 * 1024 * 1024); // sparse, > 4MiB

    const backing = createAttachmentStore(join(tempDir("w833-cap-att"), "attachments"));
    let putCalls = 0;
    const counting: AttachmentStore = {
      dir: backing.dir,
      put: async (input) => {
        putCalls += 1;
        return backing.put(input);
      },
      readById: (id) => backing.readById(id),
      readDataUrl: (id) => backing.readDataUrl(id),
    };

    const registry = createToolRegistry(
      [readImageTool({ attachments: counting })],
      [new PathGuard(new PathGuardPolicy({ workspace: ws, readRoots: [root] }))],
    );

    const externalBefore = process.memoryUsage().external;
    const out = await registry.dispatch({ call_id: "c1", name: "read_image", args: { path: bigPath } });
    const externalAfter = process.memoryUsage().external;

    // The read root was allowed (the case is about SIZE, not the guard)...
    expect(out.decision?.kind).toBe("allow");
    expect(out.value).toBeNull();
    expect(out.error).toContain("code=too_large");
    // ...and the oversize file never reached the store: nothing was buffered.
    expect(putCalls).toBe(0);
    expect(externalAfter - externalBefore).toBeLessThan(4 * 1024 * 1024);
  });
});
