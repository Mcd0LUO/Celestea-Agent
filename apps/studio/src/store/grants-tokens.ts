/**
 * Confirm tokens + abuse limits for the grant endpoints (W516 §5.5, §6.4).
 *
 * A grant can only be POSTed with a one-shot token that a BROWSER interaction
 * obtained: `GET /api/sessions/{id}/grants/confirm-token` requires same-origin
 * evidence. The token is bound to `(session, cap, scope_hash)`, lives 60s and
 * is burned on first use.
 *
 * W9206-03: the same-origin check ALONE was not enough, because `Sec-Fetch-Site`
 * and `Origin` are ordinary request headers and the session's own `http_request`
 * tool forwards arbitrary headers — so the tool could mint a token for itself
 * and then self-grant. The token is now ALSO bound to an HttpOnly nonce cookie
 * (`GRANT_NONCE_COOKIE`): the mint sets it, the POST must present it, and
 * `http_request` can neither READ `Set-Cookie` (the tool's response view is the
 * HEADER_SUBSET, which excludes it) nor GUESS the random value. Forging the
 * headers is no longer sufficient, which is the property the header check only
 * appeared to provide.
 *
 * The limiter is the anti-confirmation-fatigue half: at most 3 grant requests
 * per session per minute (429), and 3 consecutive rejections put that session in
 * a 5-minute cooldown (409 + remaining seconds).
 */

import { timingSafeEqual } from "node:crypto";

export const CONFIRM_HEADER = "x-celestea-grant-confirm";
/**
 * W9206-03: the HttpOnly nonce that binds a confirm token to the browser that
 * minted it. Set by the mint, required by the POST, and unreadable by the
 * session's own `http_request` tool (the tool's response view is the
 * HEADER_SUBSET, which excludes `set-cookie`), so forging the request headers
 * is no longer enough to self-grant.
 */
export const GRANT_NONCE_COOKIE = "celestea_grant_nonce";
/** 32 bytes of randomness, hex-encoded (same width as the confirm token). */
const NONCE_BYTES = 32;
export const SEC_FETCH_SITE = "sec-fetch-site";
export const SEC_FETCH_MODE = "sec-fetch-mode";
export const ORIGIN_HEADER = "origin";
export const CONFIRM_TTL_SEC = 60;
export const RATE_LIMIT_MAX = 3;
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const DENIAL_THRESHOLD = 3;
export const DENIAL_COOLDOWN_MS = 5 * 60_000;

export interface IssuedToken {
  token: string;
  expiresAt: number;
  /** W9206-03: the nonce the minting browser must echo back on the POST. */
  nonce: string;
}

export type TokenVerdict = "ok" | "used" | "invalid";

interface StoredToken extends IssuedToken {
  session: string;
  cap: string;
  scopeHash: string;
  used: boolean;
}

/** One-shot `(session, cap, scope_hash)` tokens with a 60s TTL. */
export class GrantTokenStore {
  private readonly tokens = new Map<string, StoredToken>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(session: string, cap: string, scopeHash: string): IssuedToken {
    this.gc();
    const token = randomToken();
    // W9206-03: the nonce is issued WITH the token and stored beside it; the
    // mint returns it so the caller can set it as an HttpOnly cookie.
    const nonce = randomToken();
    const expiresAt = Math.floor(this.now() / 1000) + CONFIRM_TTL_SEC;
    this.tokens.set(token, { token, nonce, session, cap, scopeHash, expiresAt, used: false });
    return { token, nonce, expiresAt };
  }

  /**
   * Burn the token. `used` is reported separately from `invalid` so the caller
   * can answer `409 confirmation token already used` (a replay) instead of 403.
   */
  consume(session: string, cap: string, scopeHash: string, token: string, nonce: string | null): TokenVerdict {
    this.gc();
    const found = this.tokens.get(token);
    if (found === undefined) return "invalid";
    if (found.session !== session || found.cap !== cap || found.scopeHash !== scopeHash) return "invalid";
    // W9206-03: the nonce is a REQUIRED part of the binding. A caller that
    // cannot present it (a tool that forged the headers but never saw the
    // Set-Cookie) is refused exactly like a wrong session.
    if (nonce === null || !timingSafeEqualString(nonce, found.nonce)) return "invalid";
    if (found.used) return "used";
    found.used = true;
    return "ok";
  }

  /** Drop only EXPIRED tokens: a burned one must stay recognizable as `used`. */
  private gc(): void {
    const deadline = Math.floor(this.now() / 1000);
    for (const [key, value] of this.tokens) if (value.expiresAt <= deadline) this.tokens.delete(key);
  }
}

export type LimitVerdict = { ok: true } | { ok: false; status: 429 | 409; retryAfterSec: number };

/** Per-session grant-request rate limit + consecutive-denial cooldown. */
export class GrantRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly denials = new Map<string, number>();
  private readonly cooldown = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Called once per POST attempt, before validation. */
  allow(session: string): LimitVerdict {
    const now = this.now();
    const until = this.cooldown.get(session) ?? 0;
    if (now < until) return { ok: false, status: 409, retryAfterSec: Math.ceil((until - now) / 1000) };
    const recent = (this.hits.get(session) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (recent.length >= RATE_LIMIT_MAX) {
      const oldest = recent[recent.length - RATE_LIMIT_MAX] ?? now;
      return { ok: false, status: 429, retryAfterSec: Math.max(1, Math.ceil((oldest + RATE_LIMIT_WINDOW_MS - now) / 1000)) };
    }
    recent.push(now);
    this.hits.set(session, recent);
    return { ok: true };
  }

  /** A rejected request counts toward the cooldown; a grant resets it. */
  recordDenial(session: string): void {
    const count = (this.denials.get(session) ?? 0) + 1;
    if (count >= DENIAL_THRESHOLD) {
      this.denials.set(session, 0);
      this.cooldown.set(session, this.now() + DENIAL_COOLDOWN_MS);
      return;
    }
    this.denials.set(session, count);
  }

  recordSuccess(session: string): void {
    this.denials.set(session, 0);
    this.cooldown.delete(session);
  }
}

function randomToken(): string {
  const bytes = new Uint8Array(NONCE_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string equality for the nonce (length mismatch is false). */
function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}