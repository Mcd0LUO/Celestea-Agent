/**
 * W807 -- contract loading hardening.
 *
 * The loader used to re-read contracts/*.json on every call and compare it to
 * counts baked into the module at load time. A disk edit under a running process
 * therefore became a self-contradiction (W804: contracts/tools.json went 11 -> 12
 * on disk while production had 11 in memory; every compose 500'd until restart).
 * These tests pin the two halves of the fix on a THROWAWAY COPY of contracts/ --
 * the real files are never touched:
 *   1. after the first load the in-process view is a frozen snapshot: a later
 *      on-disk rewrite is visible on disk but does not change what the process
 *      sees, and the startup gate freezes the validated snapshot too;
 *   2. a file that disagrees with the frozen count makes the explicit startup
 *      gate (and the lazy first load) throw a readable ContractValidationError
 *      carrying file / expected / actual.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContractValidationError, FROZEN_COUNTS, createContractStore } from "@celestea/core";

const REAL_CONTRACTS = resolve(process.cwd(), "contracts");
const temps: string[] = [];

/** A writable copy of the real contracts directory, removed after each test. */
function copyContracts(): string {
  const dir = mkdtempSync(join(tmpdir(), "w807-contracts-"));
  cpSync(REAL_CONTRACTS, dir, { recursive: true });
  temps.push(dir);
  return dir;
}

/** Rewrite tools.json in the throwaway copy to a 3-tool variant (count 3). */
function driftTools(dir: string): string {
  const file = join(dir, "tools.json");
  const doc = JSON.parse(readFileSync(file, "utf8")) as { tools: unknown[]; count: number };
  writeFileSync(file, JSON.stringify({ ...doc, count: 3, tools: doc.tools.slice(0, 3) }));
  return file;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("W807 contract store", () => {
  it("reuses the first validated snapshot: a later disk rewrite cannot change it", () => {
    const dir = copyContracts();
    const store = createContractStore(dir);

    const first = store.loadTools();
    expect(first.tools).toHaveLength(FROZEN_COUNTS.tools);

    // Damage the throwaway copy and prove the damage is really on disk.
    const file = driftTools(dir);
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { tools: unknown[]; count: number };
    expect(onDisk.count).toBe(3);
    expect(onDisk.tools).toHaveLength(3);

    // The process still sees the validated snapshot, not the new file.
    const second = store.loadTools();
    expect(second).toBe(first);
    expect(second.count).toBe(FROZEN_COUNTS.tools);
    expect(second.tools).toHaveLength(FROZEN_COUNTS.tools);
  });

  it("primes the cache at startup: verifyAtStartup freezes the on-disk snapshot", () => {
    const dir = copyContracts();
    const store = createContractStore(dir);
    expect(() => store.verifyAtStartup()).not.toThrow();

    driftTools(dir);

    expect(store.loadTools().tools).toHaveLength(FROZEN_COUNTS.tools);
  });

  it("fails fast on a drift, naming the file, the expected and the actual count", () => {
    const dir = copyContracts();
    const file = driftTools(dir);
    const store = createContractStore(dir);

    expect(() => store.verifyAtStartup()).toThrow(ContractValidationError);
    let message = "";
    try {
      store.verifyAtStartup();
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("tools.json");
    expect(message).toContain("expected " + FROZEN_COUNTS.tools);
    expect(message).toContain("got 3");
    expect(message).toContain(file);
  });

  it("also fails fast on a lazy first load, not only at the startup gate", () => {
    const dir = copyContracts();
    driftTools(dir);
    const store = createContractStore(dir);
    expect(() => store.loadTools()).toThrow(ContractValidationError);
  });

  it("accepts the real repository contracts at the startup gate", () => {
    const store = createContractStore(REAL_CONTRACTS);
    expect(() => store.verifyAtStartup()).not.toThrow();
    expect(store.loadEndpoints().endpoints).toHaveLength(FROZEN_COUNTS.endpoints);
    expect(store.loadSse().events).toHaveLength(FROZEN_COUNTS.sseEvents);
  });
});
