/**
 * SSRF target policy for `http_request` (`crates/tools/src/http.rs`, W249 P0-3).
 *
 * `CELESTEA_HTTP_ALLOW` / `CELESTEA_HTTP_DENY` carry comma-separated IP/CIDR
 * entries. Both unset ⇒ the policy is inactive and every target is allowed
 * (status quo, surfaced as `active === false` so the caller can decide to log
 * it). When a policy is active, EVERY resolved IP of the target — and of every
 * redirect hop — must pass it (`allow` is a whitelist when non-empty, `deny`
 * always wins).
 *
 * **Fail closed**: a malformed entry makes the policy deny everything until the
 * operator fixes the configuration — a typo can never silently widen access.
 *
 * **No check-then-use (W738 P1)**: [HttpTargetPolicy.checkUrl] is a verdict only.
 * The *authorizing* call is [HttpTargetPolicy.resolveChecked], which returns the
 * exact addresses it approved so the transport can PIN them: between the check
 * and the connect there is no second `getaddrinfo`, so a host name that answers
 * with a public address during the check and with `127.0.0.1`/`169.254.169.254`
 * at connect time (DNS rebinding) can no longer reach an address the policy
 * refused. Never connect by name after a check.
 *
 * W516 (session grants): a host may pass an [SsrfGrantView] with the session's
 * `net_hosts` entries. They are UNIONed into the allow side only, and only when
 * the env policy is active: neither the deny list nor the fail-closed verdict
 * can be reached by a grant, and an inactive policy (both env vars unset) stays
 * inactive — a grant must never *tighten* a deployment into a whitelist
 * (`netHostsIneffective` reports exactly that case to the host's audit).
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { envString } from "../env.js";

export const ENV_HTTP_ALLOW = "CELESTEA_HTTP_ALLOW";
export const ENV_HTTP_DENY = "CELESTEA_HTTP_DENY";

export interface IpRange {
  /** 4 or 6 — an IPv4 range never matches an IPv6 address. */
  family: 4 | 6;
  base: bigint;
  prefix: number;
}

/** Parse `1.2.3.4`, `10.0.0.0/8`, `::1` or `fd00::/8` (throws on nonsense). */
export function parseIpRange(entry: string): IpRange {
  const [baseText = "", prefixText] = entry.trim().split("/");
  const family = isIP(baseText);
  if (family !== 4 && family !== 6) throw new Error(`unparseable ip/cidr '${entry}'`);
  const bits = family === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? bits : Number(prefixText.trim());
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) {
    throw new Error(`bad ipv${family} prefix '${prefixText}' in '${entry}'`);
  }
  return { family, base: ipToBigInt(baseText, family), prefix };
}

/** Containment test on the masked network prefix. */
export function ipInRange(range: IpRange, ip: string): boolean {
  const family = isIP(ip);
  if (family !== range.family) return false;
  const value = ipToBigInt(ip, family);
  const hostBits = BigInt((family === 4 ? 32 : 128) - range.prefix);
  const mask = ((1n << BigInt(family === 4 ? 32 : 128)) - 1n) ^ ((1n << hostBits) - 1n);
  return (value & mask) === (range.base & mask);
}

function ipToBigInt(ip: string, family: number): bigint {
  if (family === 4) return ip.split(".").reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
  return expandV6(ip).reduce((acc, part) => (acc << 16n) | BigInt(parseInt(part, 16)), 0n);
}

function expandV6(ip: string): string[] {
  const [head = "", tail = ""] = ip.split("::");
  const headParts = head === "" ? [] : head.split(":");
  if (!ip.includes("::")) return padV6(headParts);
  const tailParts = tail === "" ? [] : tail.split(":");
  const gap = 8 - headParts.length - tailParts.length;
  return [...headParts, ...Array.from({ length: Math.max(gap, 0) }, () => "0"), ...tailParts];
}

function padV6(parts: string[]): string[] {
  const missing = 8 - parts.length;
  return missing <= 0 ? parts : [...parts, ...Array.from({ length: missing }, () => "0")];
}

/** Session-grant view of the SSRF policy (W516): allow-side widening only. */
export interface SsrfGrantView {
  /** `net_hosts` scope: IP/CIDR entries and/or host names. */
  netHosts?: readonly string[];
}

/**
 * Host -> addresses resolver. Returns the address list, or a failure reason
 * string (which becomes the denial reason). Default: `node:dns/promises`
 * `lookup` (all families, verbatim order).
 */
export type HostResolver = (host: string, port: number) => Promise<readonly string[] | string>;

/** Injectable seams of the policy (tests, custom DNS, W738 pinning harnesses). */
export interface HttpTargetPolicyOptions {
  resolver?: HostResolver;
}

/** Verdict + the exact approved addresses of ONE target. */
export interface CheckedTarget {
  /** `null` when the target is authorized, else the denial reason. */
  reason: string | null;
  /** Approved addresses to pin; empty whenever `reason !== null`. */
  ips: string[];
}

/** Raw policy state (one object: the class has no other construction path). */
interface PolicyState {
  allow: readonly IpRange[];
  deny: readonly IpRange[];
  failClosed: boolean;
  /** Host names a grant allows (they bypass the IP allow list, never deny). */
  hostAllow?: readonly string[];
  /** true = the env policy is inactive, so the grant's hosts changed nothing. */
  hostsIneffective?: boolean;
  resolver?: HostResolver;
}

export class HttpTargetPolicy {
  private readonly allow: readonly IpRange[];
  private readonly deny: readonly IpRange[];
  private readonly failClosed: boolean;
  private readonly hostAllow: readonly string[];
  private readonly hostsIneffective: boolean;
  private readonly resolver: HostResolver;

  private constructor(state: PolicyState) {
    this.allow = state.allow;
    this.deny = state.deny;
    this.failClosed = state.failClosed;
    this.hostAllow = state.hostAllow ?? [];
    this.hostsIneffective = state.hostsIneffective ?? false;
    this.resolver = state.resolver ?? resolveTargets;
  }

  /** Parse the two lists; a malformed entry throws (see [fromEnv] for env use). */
  static parse(allowSpec?: string | null, denySpec?: string | null, options: HttpTargetPolicyOptions = {}): HttpTargetPolicy {
    return new HttpTargetPolicy({
      allow: parseList(allowSpec),
      deny: parseList(denySpec),
      failClosed: false,
      resolver: options.resolver,
    });
  }

  /**
   * Policy from the environment; malformed config ⇒ fail closed. Session grants
   * are merged on the allow side ONLY (see the module docs): the env policy must
   * be active for them to count at all.
   */
  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    grants: SsrfGrantView = {},
    options: HttpTargetPolicyOptions = {},
  ): HttpTargetPolicy {
    const allowSpec = envString(env, ENV_HTTP_ALLOW);
    const denySpec = envString(env, ENV_HTTP_DENY);
    const hosts = [...(grants.netHosts ?? [])].filter((h) => h.trim() !== "");
    try {
      const allow = parseList(allowSpec);
      const deny = parseList(denySpec);
      if (allowSpec === undefined && denySpec === undefined) {
        return new HttpTargetPolicy({ ...options, allow, deny, failClosed: false, hostsIneffective: hosts.length > 0 });
      }
      const merged = splitGrantHosts(hosts);
      return new HttpTargetPolicy({
        ...options,
        allow: [...allow, ...merged.ranges],
        deny,
        failClosed: false,
        hostAllow: merged.names,
      });
    } catch {
      return new HttpTargetPolicy({ ...options, allow: [], deny: [], failClosed: true });
    }
  }

  /** Whether the policy constrains targets at all. */
  get active(): boolean {
    return this.failClosed || this.allow.length > 0 || this.deny.length > 0;
  }

  /** Allow/deny entry counts (diagnostics). */
  get sizes(): { allow: number; deny: number; failClosed: boolean } {
    return { allow: this.allow.length, deny: this.deny.length, failClosed: this.failClosed };
  }

  /** true when `net_hosts` grants were dropped because the env policy is off. */
  get netHostsIneffective(): boolean {
    return this.hostsIneffective;
  }

  /**
   * Verdict only (`null` = authorized). NEVER sufficient on its own: the caller
   * must connect to the addresses returned by [resolveChecked] instead of
   * letting the transport resolve the name again (W738 check-then-use).
   */
  async checkUrl(url: string): Promise<string | null> {
    return (await this.resolveChecked(url)).reason;
  }

  /**
   * Authorize a target and return the addresses it approved. `reason !== null`
   * ⇒ `ips` is empty and nothing may be connected; `reason === null` ⇒ `ips` is
   * non-empty and is the COMPLETE set of addresses the caller may use (pin them
   * on every hop).
   */
  async resolveChecked(url: string): Promise<CheckedTarget> {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    if (host === "") return { reason: "target url has no host", ips: [] };
    const granted = this.hostAllow.includes(host.toLowerCase());
    const ips = await this.resolver(host, parsed.port === "" ? defaultPort(parsed.protocol) : Number(parsed.port));
    if (typeof ips === "string") return { reason: ips, ips: [] };
    if (ips.length === 0) return { reason: `host '${host}' resolves to no addresses`, ips: [] };
    for (const ip of ips) {
      const reason = this.ipAllowed(ip, granted);
      if (reason !== null) return { reason, ips: [] };
    }
    return { reason: null, ips: [...ips] };
  }

  private ipAllowed(ip: string, hostGranted = false): string | null {
    if (this.failClosed) {
      return `ssrf policy misconfigured (fail-closed): fix ${ENV_HTTP_ALLOW}/${ENV_HTTP_DENY}`;
    }
    if (!hostGranted && this.allow.length > 0 && !this.allow.some((range) => ipInRange(range, ip))) {
      return `target ip ${ip} is not in the ${ENV_HTTP_ALLOW} allow list`;
    }
    // Deny always wins: a granted host still has to pass the deny list.
    if (this.deny.some((range) => ipInRange(range, ip))) {
      return `target ip ${ip} is in the ${ENV_HTTP_DENY} deny list`;
    }
    return null;
  }
}

/** IP/CIDR entries -> extra allow ranges; host names -> host allow list. */
function splitGrantHosts(hosts: readonly string[]): { ranges: IpRange[]; names: string[] } {
  const ranges: IpRange[] = [];
  const names: string[] = [];
  for (const raw of hosts) {
    const entry = raw.trim();
    const ipLike = isIP(entry) !== 0 || /^[0-9a-fA-F:.]+\/\d+$/.test(entry);
    if (ipLike) {
      try {
        ranges.push(parseIpRange(entry));
      } catch {
        // An unparseable grant entry is DROPPED (never fail-closed, §4.3.7).
      }
      continue;
    }
    const name = entry.toLowerCase();
    if (HOST_NAME_RE.test(name)) names.push(name);
  }
  return { ranges, names };
}

/** RFC 1123 host name (no scheme, no port, no slash, no whitespace). */
const HOST_NAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

function parseList(spec: string | undefined | null): IpRange[] {
  if (spec === undefined || spec === null || spec.trim() === "") return [];
  return spec
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => parseIpRange(entry));
}

/** Every address a target host resolves to, or a failure reason string. */
export async function resolveTargets(host: string, port: number): Promise<string[] | string> {
  if (isIP(host) !== 0) return [host];
  try {
    const addresses = await lookup(host, { all: true });
    if (addresses.length === 0) return `host '${host}' resolves to no addresses`;
    return addresses.map((a) => a.address);
  } catch (e) {
    return `cannot resolve host '${host}': ${e instanceof Error ? e.message : String(e)}`;
  }
}

function defaultPort(protocol: string): number {
  return protocol === "https:" ? 443 : 80;
}
