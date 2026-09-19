/**
 * H-security — the minimal self-contained API token (fail-closed).
 *
 * Why this exists: `handlers/auth.ts` delegates the browser gate to nginx
 * (`auth_request` -> `/auth/check`), and the backend is deliberately reachable
 * from localhost with no cookie. That is safe ONLY while the listener is on the
 * loopback. The CLI's `--bind` can move it to `0.0.0.0`, where the SAME backend
 * exposes `POST /api/exec` (arbitrary shell as this user), `GET /api/fs/list`
 * (any directory) and every agent endpoint to anyone who can reach the port.
 *
 * Rules, all "never silently allow":
 *   1. a NON-loopback bind is REFUSED unless a token is configured;
 *   2. when a token IS configured, every `/api/*` request except `/api/health`
 *      must present it — as `Authorization: Bearer`, `x-celestea-token`, or the
 *      cookie `GET /auth/token?token=…` sets — else 401.
 *
 * The browser problem (why the cookie exists): a browser never sends an
 * `Authorization` header, so a token-only gate leaves the UI unusable (every
 * fetch 401). `/auth/token` is the standard one-shot bootstrap: a correct token
 * sets an HttpOnly cookie and 302s to `/`; the middleware then accepts the
 * cookie. The cookie value is an HMAC of the token, never the plaintext token,
 * so the raw secret is not stored client-side.
 *
 * The loopback path is untouched (no token -> no middleware, no bootstrap), so
 * the existing nginx deployment and every existing test keep working.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { cookieValue } from "./token.js";

/** Env var carrying the token (the `--token` flag overrides it). */
export const ENV_AUTH_TOKEN = "CELESTEA_AUTH_TOKEN";
/** The token header (in addition to `Authorization: Bearer <token>`). */
export const AUTH_TOKEN_HEADER = "x-celestea-token";
/** The one API path that stays public (liveness probes, the UI's boot check). */
export const AUTH_EXEMPT_PATH = "/api/health";
/** The browser bootstrap path (NOT under /api, so the token gate never blocks it). */
export const AUTH_TOKEN_PATH = "/auth/token";
/** The HttpOnly cookie the bootstrap sets; distinct from the login cookie. */
export const AUTH_TOKEN_COOKIE = "celestea_api_token";
/** 30 days, the same lifetime the login cookie uses. */
export const AUTH_TOKEN_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

/** The host part of a `host` or `host:port` bind string (IPv6 aware). */
function hostOf(bind: string): string {
  const raw = bind.trim().toLowerCase();
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end === -1 ? raw : raw.slice(1, end);
  }
  const first = raw.indexOf(":");
  // Exactly one colon = "host:port"; two or more = a bare IPv6 literal.
  if (first !== -1 && raw.indexOf(":", first + 1) === -1) return raw.slice(0, first);
  return raw;
}

/** true only for an address that cannot be reached from another host. */
export function isLoopbackBind(bind: string): boolean {
  const host = hostOf(bind);
  if (host === "localhost" || host === "::1" || host === "127.0.0.1") return true;
  if (host.startsWith("127.")) return true;
  // IPv4-mapped IPv6 loopback (::ffff:127.0.0.1).
  if (host.startsWith("::ffff:127.")) return true;
  return false;
}

/** The configured token, or null when unset/blank. */
export function readAuthToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[ENV_AUTH_TOKEN];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/** The token a request presents, from either accepted header (or null). */
export function presentedToken(authHeader: string | undefined, tokenHeader: string | undefined): string | null {
  if (typeof tokenHeader === "string" && tokenHeader.trim() !== "") return tokenHeader.trim();
  if (typeof authHeader === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    const value = match?.[1];
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return null;
}

/** Constant-time string comparison (a length mismatch is a plain false). */
export function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The cookie value for a token. An HMAC keyed by the token, so the cookie the
 * browser stores is NOT the raw secret (a leaked cookie does not reveal the
 * token, and the token never appears in a page or a cookie jar verbatim).
 */
export function tokenCookieValue(token: string): string {
  return createHmac("sha256", token).update("celestea-api-token-v1").digest("hex");
}

/** true when the presented cookie value is this token's cookie value. */
export function cookieMatches(presented: string | null | undefined, token: string): boolean {
  if (typeof presented !== "string" || presented === "") return false;
  return tokensMatch(presented, tokenCookieValue(token));
}

/** The refusal when a non-loopback bind has no token. */
export class InsecureBindError extends Error {
  override readonly name = "InsecureBindError";
  constructor(bind: string) {
    super(
      `refusing to bind ${bind} without authentication: that would expose ` +
        `POST /api/exec (arbitrary shell as this user), GET /api/fs/list (any directory) ` +
        `and every agent endpoint to anyone who can reach the port.\n` +
        `  Fix it one of two ways:\n` +
        `    1. keep it local: --bind 127.0.0.1 (the default), or\n` +
        `    2. set a token: --token <secret> (or ${ENV_AUTH_TOKEN}=<secret>) and send it as ` +
        `'Authorization: Bearer <secret>' (or '${AUTH_TOKEN_HEADER}: <secret>') on every /api/* request.\n` +
        `  For a browser, visit /auth/token?token=<secret> once to set the session cookie.\n` +
        `  For the nginx login gate, put nginx in front and bind 127.0.0.1.`,
    );
  }
}

/** Refuse a non-loopback bind that has no token (throws [InsecureBindError]). */
export function assertBindIsSafe(bind: string, token: string | null): void {
  if (isLoopbackBind(bind) || token !== null) return;
  throw new InsecureBindError(bind);
}

/**
 * The token middleware: every `/api/*` request except `/api/health` must
 * present the token as a header OR the bootstrap cookie, else 401. `/auth/*`
 * and the static UI are not under `/api/*` and stay reachable.
 */
export function apiTokenMiddleware(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path === AUTH_EXEMPT_PATH) return next();
    const presented = presentedToken(c.req.header("authorization"), c.req.header(AUTH_TOKEN_HEADER));
    if (presented !== null && tokensMatch(presented, token)) return next();
    if (cookieMatches(cookieValue(c.req.header("cookie"), AUTH_TOKEN_COOKIE), token)) return next();
    return c.json({ ok: false, error: "unauthorized" }, 401);
  };
}

/** The `Set-Cookie` value: HttpOnly + SameSite=Strict + Path=/ (+Secure over TLS). */
export function apiTokenCookie(token: string, secure: boolean): string {
  const attrs = [`${AUTH_TOKEN_COOKIE}=${tokenCookieValue(token)}`, "Path=/", `Max-Age=${AUTH_TOKEN_COOKIE_MAX_AGE}`, "HttpOnly", "SameSite=Strict"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** `Secure` is set only when the request really arrived over TLS (nginx). */
function isSecureRequest(c: Context): boolean {
  const first = (c.req.header("x-forwarded-proto") ?? "").toLowerCase().split(",")[0];
  return first !== undefined && first.trim() === "https";
}

/**
 * `GET /auth/token?token=<secret>`: correct -> set the cookie and 302 to `/`;
 * wrong/missing -> 401 with NO cookie. Not a contract endpoint (a security-layer
 * route, registered outside the frozen route table).
 */
export function registerTokenBootstrap(app: Hono, token: string): void {
  app.get(AUTH_TOKEN_PATH, (c) => {
    const presented = c.req.query("token");
    if (presented === undefined || !tokensMatch(presented, token)) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
    c.header("set-cookie", apiTokenCookie(token, isSecureRequest(c)));
    return c.redirect("/", 302);
  });
}
