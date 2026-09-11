/**
 * Confirm tokens + abuse limits for the grant endpoints (W516 §5.5, §6.4).
 *
 * A grant can only be POSTed with a one-shot token that a BROWSER interaction
 * obtained: `GET /api/sessions/{id}/grants/confirm-token` requires same-origin
 * evidence, so the session's own `http_request` tool cannot mint one even when
 * it can reach `127.0.0.1` (a tool call carries no browser `Sec-Fetch-*`
 * headers). The token is bound to `(session, cap, scope_hash)`, lives 60s and
 * is burned on first use.
 *
 * The limiter is the anti-confirmation-fatigue half: at most 3 grant requests
 * per session per minute (429), and 3 consecutive rejections put that session in
 * a 5-minute cooldown (409 + remaining seconds).
 */

export const CONFIRM_HEADER = "x-celestea-grant-confirm";
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
    const expiresAt = Math.floor(this.now() / 1000) + CONFIRM_TTL_SEC;
    this.tokens.set(token, { token, session, cap, scopeHash, expiresAt, used: false });
    return { token, expiresAt };
  }

  /**
   * Burn the token. `used` is reported separately from `invalid` so the caller
   * can answer `409 confirmation token already used` (a replay) instead of 403.
   */
  consume(session: string, cap: string, scopeHash: string, token: string): TokenVerdict {
    this.gc();
    const found = this.tokens.get(token);
    if (found === undefined) return "invalid";
    if (found.session !== session || found.cap !== cap || found.scopeHash !== scopeHash) return "invalid";
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
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
