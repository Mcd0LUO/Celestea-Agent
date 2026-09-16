/**
 * W833 (R3 B9) — documentation / comment drift guard (zero behaviour).
 *
 * Source: /server-center/runtime/worker-exec/results/W827-R3修复计划-B-tools-workers-studio.md
 * §B9: W813 P2-attempt (the attempt comments must say first = 0; authoritative
 * contracts/data-files/registry-tsv.schema.json) and W816 F8 + A6 (the worker
 * table defaults to DISK under W787; only an explicit null is in-memory).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("W833 B9: attempt comments say first = 0", () => {
  it("receipt.ts and recovery.ts match the frozen schema", () => {
    const receipt = read("packages/workers/src/receipt.ts");
    const recovery = read("packages/workers/src/recovery.ts");
    expect(receipt).not.toContain("first spawn = 1");
    expect(recovery).not.toContain("1 when the token is absent");
    expect(receipt).toContain("first spawn = 0");
    expect(recovery).toContain("0 when the token is absent");
  });
});

describe("W833 B9: worker table is on-disk by default", () => {
  it("session-compose.ts describes workerRegistryPath, not an unconditional null", () => {
    const compose = read("apps/studio/src/runtime/session-compose.ts");
    expect(compose).not.toMatch(/The table stays IN[\s\S]{0,40}MEMORY/);
    expect(compose).toContain("workerRegistryPath()");
  });

  it("docs carry no unqualified tsvPath:null memory claim", () => {
    const docs = read("docs/iteration-e-capabilities.md");
    expect(docs).not.toMatch(/studio 侧(显式 )?\x60tsvPath: null\x60（纯内存）/);
    expect(docs).toContain("worker-registry.tsv");
  });
});
