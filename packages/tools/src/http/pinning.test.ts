/**
 * W738 P1 — SSRF check-then-use is closed by pinning.
 *
 * The policy authorizes a target AND hands back the addresses it approved; the
 * transport connects to exactly those addresses and never resolves again. These
 * tests are deliberately live (a real loopback HTTP server): the only way the
 * request can reach it under the `*.invalid` host names below is the pin, so a
 * regression to "connect by name" fails loudly instead of passing silently.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fetchWithPolicy } from "./redirects.js";
import { HttpTargetPolicy, type HostResolver } from "./ssrf.js";
import { pinnedLookup, requestOnce } from "./transport.js";

/** Denied by the deny list; nothing in this test may ever connect to it. */
const DENIED_IP = "10.66.0.1";
const ALLOW = "127.0.0.0/8";
const DENY = "10.0.0.0/8";

/**
 * Two servers on the SAME port but different loopback addresses: `127.0.0.1` is
 * the address the platform resolver hands out for the `.invalid` names below
 * (this sandbox wildcard-resolves them), `127.0.0.2` is the address the SSRF
 * policy approves. Which body comes back therefore says, unambiguously, which
 * address the socket was dialled to.
 */
const APPROVED_IP = "127.0.0.2";
const PLATFORM_DNS_IP = "127.0.0.1";

let approved: Server;
let other: Server;
let port = 0;
let hits: string[] = [];

beforeAll(async () => {
  other = createServer((req, res) => {
    hits.push(`other:${req.url ?? ""}`);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("other");
  });
  approved = createServer((req, res) => {
    hits.push(`${req.headers.host ?? ""}${req.url ?? ""}`);
    if (req.url === "/hop") {
      res.writeHead(302, { location: "/ok" });
      res.end();
      return;
    }
    if (req.url === "/away") {
      res.writeHead(302, { location: `http://internal.invalid:${port}/ok` });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  port = await listen(approved, APPROVED_IP, 0);
  await listen(other, PLATFORM_DNS_IP, port);
});

afterAll(async () => {
  await close(other);
  await close(approved);
});

const listen = (server: Server, host: string, p: number): Promise<number> =>
  new Promise((resolve) => server.listen(p, host, () => resolve((server.address() as AddressInfo).port)));

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));

/** Resolver that answers per host and counts what it was asked. */
function scripted(answers: Record<string, readonly string[]>): { resolver: HostResolver; calls: string[] } {
  const calls: string[] = [];
  const resolver: HostResolver = async (host) => {
    calls.push(host);
    return answers[host] ?? `cannot resolve host '${host}'`;
  };
  return { resolver, calls };
}

const url = (host: string, path: string): URL => new URL(`http://${host}:${port}${path}`);

const options = (policy: HttpTargetPolicy) => ({
  method: "GET",
  headers: [],
  body: null,
  timeoutMs: 5_000,
  maxBodyBytes: 1024 * 1024,
  policy,
});

describe("SSRF pinning (W738 P1)", () => {
  it("connects to the approved IP, never to the platform resolver's answer", async () => {
    hits = [];
    const { resolver, calls } = scripted({ "rebind.invalid": [APPROVED_IP] });
    const policy = HttpTargetPolicy.parse(ALLOW, DENY, { resolver });
    const result = await fetchWithPolicy(url("rebind.invalid", "/ok"), options(policy));
    expect(result.status).toBe(200);
    // "ok" only comes from the APPROVED loopback address; a re-resolving transport
    // would have reached the other one and answered "other".
    expect(result.body).toBe("ok");
    expect(hits).toEqual([`rebind.invalid:${port}/ok`]);
    // exactly one resolution: the authorizing one (no second getaddrinfo).
    expect(calls).toEqual(["rebind.invalid"]);
  });

  it("ignores a rebound second answer that the policy would have denied", async () => {
    hits = [];
    const seen: string[] = [];
    let first = true;
    const rebound: HostResolver = async (host) => {
      seen.push(host);
      if (first) {
        first = false;
        return [APPROVED_IP];
      }
      return [DENIED_IP];
    };
    const policy = HttpTargetPolicy.parse(ALLOW, DENY, { resolver: rebound });
    const result = await fetchWithPolicy(url("rebind.invalid", "/ok"), options(policy));
    expect(result.body).toBe("ok");
    expect(seen).toEqual(["rebind.invalid"]);
  });

  it("keeps the URL host in `Host` while the socket goes to the pinned address", async () => {
    hits = [];
    const result = await requestOnce({
      url: url("rebind.invalid", "/ok"),
      method: "GET",
      headers: [],
      body: null,
      timeoutMs: 5_000,
      maxBodyBytes: 1024,
      pinnedIps: [APPROVED_IP],
    });
    expect(result.status).toBe(200);
    expect(hits).toEqual([`rebind.invalid:${port}/ok`]);
  });

  it("refuses (and never connects) when the resolved address is denied", async () => {
    hits = [];
    const { resolver } = scripted({ "internal.invalid": [DENIED_IP] });
    const policy = HttpTargetPolicy.parse("0.0.0.0/0", DENY, { resolver });
    await expect(fetchWithPolicy(url("internal.invalid", "/ok"), options(policy))).rejects.toThrow(
      /target_forbidden.*deny list/,
    );
    expect(hits).toEqual([]);
  });

  it("re-authorizes and re-pins every redirect hop", async () => {
    hits = [];
    const { resolver, calls } = scripted({ "rebind.invalid": [APPROVED_IP] });
    const policy = HttpTargetPolicy.parse(ALLOW, DENY, { resolver });
    const result = await fetchWithPolicy(url("rebind.invalid", "/hop"), options(policy));
    expect(result.status).toBe(200);
    expect(hits).toEqual([`rebind.invalid:${port}/hop`, `rebind.invalid:${port}/ok`]);
    expect(calls).toEqual(["rebind.invalid", "rebind.invalid"]);
  });

  it("stops at a redirect hop whose address is denied", async () => {
    hits = [];
    const { resolver } = scripted({ "rebind.invalid": [APPROVED_IP], "internal.invalid": [DENIED_IP] });
    const policy = HttpTargetPolicy.parse(ALLOW, DENY, { resolver });
    await expect(fetchWithPolicy(url("rebind.invalid", "/away"), options(policy))).rejects.toThrow(/target_forbidden/);
    // only the first hop was sent; the denied hop was never dialled.
    expect(hits).toEqual([`rebind.invalid:${port}/away`]);
  });
});

describe("pinnedLookup", () => {
  const call = (pinned: readonly string[], opts: unknown): Promise<{ error: Error | null; addresses: unknown }> =>
    new Promise((resolve) => {
      pinnedLookup(pinned)("host.invalid", opts as never, (error, address) => resolve({ error, addresses: address }));
    });

  it("answers the `all` form from the pinned list", async () => {
    const { error, addresses } = await call(["127.0.0.1", "::1"], { family: 0, all: true });
    expect(error).toBeNull();
    expect(addresses).toEqual([
      { address: "127.0.0.1", family: 4 },
      { address: "::1", family: 6 },
    ]);
  });

  it("answers the single form and honours a requested family", async () => {
    expect((await call(["127.0.0.1", "::1"], { family: 6 })).addresses).toBe("::1");
    expect((await call(["127.0.0.1"], { family: 0 })).addresses).toBe("127.0.0.1");
  });

  it("fails with ENOTFOUND instead of falling back to the platform resolver", async () => {
    const { error, addresses } = await call(["127.0.0.1"], { family: 6, all: true });
    expect((error as NodeJS.ErrnoException | null)?.code).toBe("ENOTFOUND");
    expect(addresses).toBe("");
    expect((await call([], { all: true })).error).not.toBeNull();
  });
});
