/**
 * W516 §4.1/§5.6: `net_hosts` widens the SSRF **allow** side only, and only
 * while the env policy is active. `deny` always wins and an inactive policy is
 * never tightened into a whitelist (that would be a widening mechanism acting
 * as a narrowing one).
 *
 * DNS is mocked so the host-name branch is deterministic and offline.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.9", family: 4 }]),
}));

import { ENV_HTTP_ALLOW, ENV_HTTP_DENY, HttpTargetPolicy } from "./ssrf.js";

describe("HttpTargetPolicy + net_hosts grants", () => {
  it("ignores grants while the env policy is inactive (never tightens)", async () => {
    const policy = HttpTargetPolicy.fromEnv({}, { netHosts: ["10.1.2.3", "api.example.com"] });
    expect(policy.active).toBe(false);
    expect(policy.netHostsIneffective).toBe(true);
    expect(await policy.checkUrl("http://10.9.9.9/")).toBeNull();
    expect(await policy.checkUrl("http://api.example.com/")).toBeNull();
  });

  it("unions IP/CIDR and host-name entries into the allow list", async () => {
    const env = { [ENV_HTTP_ALLOW]: "10.0.0.0/8" };
    const without = HttpTargetPolicy.fromEnv(env, {});
    expect(await without.checkUrl("http://10.1.2.3/")).toBeNull();
    expect(await without.checkUrl("http://192.168.1.1/")).toContain(`not in the ${ENV_HTTP_ALLOW} allow list`);
    expect(await without.checkUrl("http://api.example.com/")).toContain("allow list");

    const granted = HttpTargetPolicy.fromEnv(env, { netHosts: ["192.168.1.1", "api.example.com"] });
    expect(granted.netHostsIneffective).toBe(false);
    expect(await granted.checkUrl("http://192.168.1.1/")).toBeNull();
    expect(await granted.checkUrl("http://api.example.com/")).toBeNull();
    // a name grant is exact-match only: a sibling host still has to pass the list.
    expect(await granted.checkUrl("http://evil.example.com/")).toContain("allow list");
  });

  it("never overrides the deny list (scenario 13: deny always wins)", async () => {
    const env = { [ENV_HTTP_ALLOW]: "0.0.0.0/0", [ENV_HTTP_DENY]: "10.0.0.0/8,203.0.113.0/24" };
    const granted = HttpTargetPolicy.fromEnv(env, { netHosts: ["10.1.2.3", "api.example.com"] });
    expect(await granted.checkUrl("http://10.1.2.3/")).toContain(`in the ${ENV_HTTP_DENY} deny list`);
    expect(await granted.checkUrl("http://api.example.com/")).toContain(`in the ${ENV_HTTP_DENY} deny list`);
    expect(await granted.checkUrl("http://10.9.9.9/")).toContain("deny list");
  });

  it("drops unparseable grant entries instead of failing closed (§4.3.7)", async () => {
    const policy = HttpTargetPolicy.fromEnv(
      { [ENV_HTTP_ALLOW]: "10.0.0.0/8" },
      { netHosts: ["", "not a host!", "192.168.5.5/99", "   ", "192.168.5.5"] },
    );
    expect(policy.sizes.failClosed).toBe(false);
    expect(policy.active).toBe(true);
    // the broken entries were dropped, the valid one still landed in the allow list.
    expect(policy.sizes.allow).toBe(2);
    expect(await policy.checkUrl("http://192.168.5.5/")).toBeNull();
    expect(await policy.checkUrl("http://192.168.5.6/")).toContain("allow list");
    // an unparseable ENV entry still fails closed (operator posture, unchanged).
    expect(HttpTargetPolicy.fromEnv({ [ENV_HTTP_ALLOW]: "nonsense" }).sizes.failClosed).toBe(true);
  });
});
