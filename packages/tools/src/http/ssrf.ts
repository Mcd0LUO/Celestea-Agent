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

export class HttpTargetPolicy {
  private readonly allow: readonly IpRange[];
  private readonly deny: readonly IpRange[];
  private readonly failClosed: boolean;

  private constructor(allow: readonly IpRange[], deny: readonly IpRange[], failClosed: boolean) {
    this.allow = allow;
    this.deny = deny;
    this.failClosed = failClosed;
  }

  /** Parse the two lists; a malformed entry throws (see [fromEnv] for env use). */
  static parse(allowSpec?: string | null, denySpec?: string | null): HttpTargetPolicy {
    return new HttpTargetPolicy(parseList(allowSpec), parseList(denySpec), false);
  }

  /** Policy from the environment; malformed config ⇒ fail closed. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): HttpTargetPolicy {
    try {
      return HttpTargetPolicy.parse(envString(env, ENV_HTTP_ALLOW), envString(env, ENV_HTTP_DENY));
    } catch {
      return new HttpTargetPolicy([], [], true);
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

  /** `null` when the target is authorized, else the denial reason. */
  async checkUrl(url: string): Promise<string | null> {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    if (host === "") return "target url has no host";
    const ips = await resolveTargets(host, parsed.port === "" ? defaultPort(parsed.protocol) : Number(parsed.port));
    if (typeof ips === "string") return ips;
    for (const ip of ips) {
      const reason = this.ipAllowed(ip);
      if (reason !== null) return reason;
    }
    return null;
  }

  private ipAllowed(ip: string): string | null {
    if (this.failClosed) {
      return `ssrf policy misconfigured (fail-closed): fix ${ENV_HTTP_ALLOW}/${ENV_HTTP_DENY}`;
    }
    if (this.allow.length > 0 && !this.allow.some((range) => ipInRange(range, ip))) {
      return `target ip ${ip} is not in the ${ENV_HTTP_ALLOW} allow list`;
    }
    if (this.deny.some((range) => ipInRange(range, ip))) {
      return `target ip ${ip} is in the ${ENV_HTTP_DENY} deny list`;
    }
    return null;
  }
}

function parseList(spec: string | undefined | null): IpRange[] {
  if (spec === undefined || spec === null || spec.trim() === "") return [];
  return spec
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => parseIpRange(entry));
}

/** Every address a target host resolves to, or a failure reason string. */
async function resolveTargets(host: string, port: number): Promise<string[] | string> {
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
