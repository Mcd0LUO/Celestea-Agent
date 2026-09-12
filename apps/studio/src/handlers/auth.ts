/**
 * W767 — the three endpoints of Studio's OWN login-cookie gate.
 *
 *   GET  /login        the self-contained login page (always reachable)
 *   POST /auth/login   verify against Studio's password file, then Set-Cookie
 *   GET  /auth/check   200/401 for nginx `auth_request` (the actual gate)
 *
 * nginx asks `/auth/check` for every other path and rewrites a 401 into a
 * redirect to `/login`; these three are the only paths exempted there. The
 * backend therefore stays usable from localhost with no cookie (the engine's own
 * API is unchanged) while the public host is gated by the cookie.
 *
 * Hard rules kept here:
 *   - the password is verified through `htpasswd -vbi` (stdin, never argv);
 *   - a SUCCESSFUL login answers 200 with `Set-Cookie` AND the navigation in the
 *     same response (never a 302 — some mobile clients drop the cookie on a
 *     redirect);
 *   - the cookie value never reaches a log line, and a wrong password and an
 *     unknown user are indistinguishable (401 both ways).
 */

import type { Context, Hono } from "hono";
import type { RouteTable } from "../routes.js";
import { failJson, type Deps } from "./common.js";
import {
  AUTH_COOKIE,
  AUTH_MAX_FAILURES,
  AUTH_WINDOW_MS,
  authCookie,
  cookieValue,
  createFailureLimiter,
  loadAuthSecret,
  loginPage,
  LOGIN_OK_PAGE,
  mintToken,
  verifyPassword,
  verifyToken,
  type FailureLimiter,
} from "../auth/index.js";

const HTML = "text/html; charset=utf-8";
const NO_STORE = "no-store";

/** The gate's own state: one limiter + one lazily-created secret per app. */
interface Gate {
  limiter: FailureLimiter;
  htpasswdFile: string;
  secret(): Buffer;
}

export function registerAuth(app: Hono, deps: Deps, table: RouteTable): string[] {
  const gate = createGate(deps);
  const page = table.get("get_login");
  const login = table.get("post_auth_login");
  const check = table.get("get_auth_check");

  app.on(page.method, page.honoPath, () => pageResponse(loginPage(), 200));

  app.on(check.method, check.honoPath, (c) => {
    const user = cookieUser(c, gate);
    return user === null
      ? jsonResponse({ ok: false, error: "unauthorized" }, 401)
      : jsonResponse({ ok: true, user }, 200);
  });

  app.on(login.method, login.honoPath, (c) => loginResponse(c, gate));
  return [page.id, login.id, check.id];
}

function createGate(deps: Deps): Gate {
  const limiter = createFailureLimiter({ now: Date.now, windowMs: AUTH_WINDOW_MS, maxFailures: AUTH_MAX_FAILURES });
  const htpasswdFile = deps.config.paths.authHtpasswdFile;
  let secret: Buffer | null = null;
  return {
    limiter,
    htpasswdFile,
    secret: (): Buffer => (secret ??= loadAuthSecret(deps.config.paths.authSecretFile)),
  };
}

/** The user of a valid cookie, or null (missing / tampered / expired / unknown). */
function cookieUser(c: Context, gate: Gate): string | null {
  const raw = cookieValue(c.req.header("cookie"), AUTH_COOKIE);
  if (raw === null) return null;
  const verdict = verifyToken(raw, gate.secret(), Math.floor(Date.now() / 1000));
  return verdict.ok ? verdict.user : null;
}

/** One failed attempt is counted against BOTH the username and the client IP. */
function attemptKeys(c: Context, user: string): string[] {
  return [`u:${user.toLowerCase()}`, `ip:${clientIp(c)}`];
}

async function loginResponse(c: Context, gate: Gate): Promise<Response> {
  const wantsJson = prefersJson(c);
  const creds = await credentialsOf(c);
  if (creds === null) return denied(c, wantsJson, 401, "invalid username or password", "用户名或密码不正确");
  const keys = attemptKeys(c, creds.user);
  if (keys.some((key) => gate.limiter.blocked(key))) {
    return wantsJson
      ? failJson(c, 429, "too many failed login attempts", { retry_after: AUTH_WINDOW_MS / 1000 })
      : pageResponse(loginPage("尝试次数过多，请稍后再试"), 429);
  }
  const verdict = verifyPassword(gate.htpasswdFile, creds.user, creds.pass);
  if (verdict !== "ok") {
    for (const key of keys) gate.limiter.fail(key);
    if (verdict === "error") {
      warn(`password check failed to run (file=${gate.htpasswdFile}) — login denied`);
      return denied(c, wantsJson, 500, "credential store unavailable", "凭据校验服务不可用，请联系管理员");
    }
    return denied(c, wantsJson, 401, "invalid username or password", "用户名或密码不正确");
  }
  for (const key of keys) gate.limiter.clear(key);
  const token = mintToken(creds.user, gate.secret(), Math.floor(Date.now() / 1000));
  return wantsJson
    ? jsonResponse({ ok: true, user: creds.user }, 200, { "set-cookie": authCookie(token) })
    : pageResponse(LOGIN_OK_PAGE, 200, { "set-cookie": authCookie(token) });
}

function denied(c: Context, wantsJson: boolean, status: number, error: string, pageError: string): Response {
  return wantsJson ? failJson(c, status, error) : pageResponse(loginPage(pageError), status);
}

/** `{username, password}` out of a form post OR a JSON body; null when absent. */
async function credentialsOf(c: Context): Promise<{ user: string; pass: string } | null> {
  let raw: string;
  try {
    raw = await c.req.text();
  } catch {
    return null;
  }
  if (raw.trim() === "") return null;
  const type = (c.req.header("content-type") ?? "").toLowerCase();
  if (type.includes("json")) {
    try {
      return pickCredentials(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      return null;
    }
  }
  return pickCredentials(Object.fromEntries(new URLSearchParams(raw)));
}

function pickCredentials(body: Record<string, unknown>): { user: string; pass: string } | null {
  const user = body["username"];
  const pass = body["password"];
  if (typeof user !== "string" || typeof pass !== "string") return null;
  return user.trim() === "" || pass === "" ? null : { user: user.trim(), pass };
}

/** JSON clients (curl/API) get JSON; a browser form post gets a page back. */
function prefersJson(c: Context): boolean {
  const type = (c.req.header("content-type") ?? "").toLowerCase();
  const accept = (c.req.header("accept") ?? "").toLowerCase();
  return type.includes("json") || accept.includes("application/json");
}

/** The client IP nginx reports, else the (local) caller is one bucket. */
function clientIp(c: Context): string {
  const real = c.req.header("x-real-ip");
  if (real !== undefined && real.trim() !== "") return real.trim();
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded !== undefined) {
    const first = forwarded.split(",")[0]?.trim();
    if (first !== undefined && first !== "") return first;
  }
  return "local";
}

function pageResponse(body: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": HTML, "cache-control": NO_STORE, ...extra },
  });
}

function jsonResponse(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": NO_STORE, ...extra },
  });
}

function warn(message: string): void {
  process.stderr.write(`studio auth: ${message}\n`);
}
