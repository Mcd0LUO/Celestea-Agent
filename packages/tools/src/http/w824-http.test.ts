/**
 * W824 http probes.
 *
 * P0-3 (W812): requestOnce's timer outlived a synchronous request failure and
 *      the callback dereferenced a TDZ const -> uncaught ReferenceError 100ms
 *      later (process exit 1). The subprocess probe proves the fix.
 * P0-4 + A1 (W812/W822): an IPv4-mapped IPv6 literal (::ffff:169.254.169.254)
 *      slipped through a deny-only policy, and an embedded dotted quad parsed
 *      as 0xffff0169 instead of 0xffffa9fea9fe.
 *
 * Fails on HEAD, passes after the fix.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { HttpTargetPolicy, ipInRange, parseIpRange } from "./ssrf.js";

const TSX = fileURLToPath(new URL("../../../../node_modules/.bin/tsx", import.meta.url));
const TRANSPORT = fileURLToPath(new URL("./transport.ts", import.meta.url));

describe("W824 W812-P0-4/A1: IPv4-mapped IPv6", () => {
  it("deny-only policy rejects the ::ffff: form of a denied IPv4", async () => {
    const policy = HttpTargetPolicy.parse("", "169.254.169.254/32,127.0.0.0/8");
    expect(policy.active).toBe(true);
    expect(await policy.checkUrl("http://169.254.169.254/")).not.toBeNull();
    const checked = await policy.resolveChecked("http://[::ffff:169.254.169.254]/");
    expect(checked.reason).not.toBeNull();
    expect(checked.reason).toContain("deny list");
    expect(checked.ips).toEqual([]);
  });

  it("parses an embedded dotted quad and matches the mapped form (A1)", () => {
    const range = parseIpRange("::ffff:169.254.169.254/128");
    expect(range.base).toBe(0xffffa9fea9fen);
    expect(ipInRange(range, "::ffff:a9fe:a9fe")).toBe(true);
    expect(ipInRange(range, "169.254.169.254")).toBe(true);
    expect(ipInRange(range, "169.254.169.1")).toBe(false);
  });

  it("still rejects the mapped form under an IPv4 allow list", async () => {
    const policy = HttpTargetPolicy.parse("1.2.3.0/24", "169.254.169.254/32");
    expect((await policy.resolveChecked("http://[::ffff:169.254.169.254]/")).reason).not.toBeNull();
  });

  it("treats the mapped form as its IPv4 address (allow-mode consistency)", async () => {
    const policy = HttpTargetPolicy.parse("169.254.169.254/32", "");
    expect((await policy.resolveChecked("http://[::ffff:169.254.169.254]/")).reason).toBeNull();
  });
});

describe("W824 W812-P0-3: requestOnce leaves no stale timer", () => {
  it("a synchronous header failure rejects without a later uncaught exception", () => {
    const dir = mkdtempSync(join(tmpdir(), "w824-http-"));
    const script = join(dir, "probe.mts");
    const source = [
      'import { requestOnce } from ' + JSON.stringify(TRANSPORT) + ';',
      'const bad = String.fromCharCode(0) + "bad";',
      'try {',
      '  await requestOnce({ url: new URL("http://127.0.0.1:9/"), method: "GET", headers: [["x", bad]], body: null, timeoutMs: 100, maxBodyBytes: 1024 });',
      '  console.log("RESOLVED");',
      '} catch (e) {',
      '  console.log("REJECTED:" + (e && e.message ? e.message : String(e)));',
      '}',
      'setTimeout(() => { console.log("SURVIVED"); process.exit(0); }, 400);',
      '',
    ].join("\n");
    writeFileSync(script, source);
    try {
      const result = spawnSync(TSX, [script], { encoding: "utf8", timeout: 15000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("REJECTED:");
      expect(result.stdout).toContain("SURVIVED");
      expect(result.stderr).not.toContain("Cannot access 'request'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
