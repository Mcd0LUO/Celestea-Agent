/**
 * W767 — the HTTP surface of Studio's own login-cookie gate:
 * `GET /login`, `POST /auth/login`, `GET /auth/check`.
 *
 * The password file is a throwaway `{SHA}` htpasswd line and the signing secret
 * lives in the harness' own data directory, so no test can read Studio's real
 * credential file or reuse its real secret.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUTH_COOKIE, AUTH_MAX_FAILURES } from "./auth/index.js";
import { makeHarness, type StudioHarness } from "./harness.test-util.js";

const USER = "studio-admin";
const PASS = "correct horse battery staple";
const dirs: string[] = [];
const harnesses: StudioHarness[] = [];

const HAS_HTPASSWD = spawnSync("htpasswd", ["-vbi"], { encoding: "utf8" }).error === undefined;

/** A throwaway password file (the format `htpasswd -s` writes). */
function passwordFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "studio-authfile-"));
  dirs.push(dir);
  const path = join(dir, "htpasswd-studio");
  const hash = createHash("sha1").update(PASS).digest("base64");
  writeFileSync(path, `${USER}:{SHA}${hash}\n`);
  return path;
}

function harness(): StudioHarness {
  const h = makeHarness({
    session: { name: "s1", log: `${JSON.stringify({ type: "user_message", text: "hi" })}\n` },
    paths: { authHtpasswdFile: passwordFile() },
  });
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** A browser form post (what the login page does). */
function form(user: string, pass: string): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
    body: new URLSearchParams({ username: user, password: pass }).toString(),
  };
}

function cookieOf(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  const value = raw.split(";")[0] ?? "";
  expect(value.startsWith(`${AUTH_COOKIE}=`)).toBe(true);
  return value;
}

describe("login page", () => {
  it("serves Studio's own self-contained page with no cookie and no cache", async () => {
    const res = await harness().app.request("/login");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("Celestea Studio");
    expect(html).toContain('action="/auth/login"');
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe.skipIf(!HAS_HTPASSWD)("POST /auth/login", () => {
  it("answers 200 + Set-Cookie + the in-page navigation (never a 302)", async () => {
    const res = await harness().app.request("/auth/login", form(USER, PASS));
    expect(res.status).toBe(200); // NOT 302: a redirect may drop Set-Cookie
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${AUTH_COOKIE}=`);
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=2592000");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(await res.text()).toContain(`location.replace("/")`);
  });

  it("accepts a JSON client too and returns the verified user", async () => {
    const res = await harness().app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: USER, password: PASS }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain(`${AUTH_COOKIE}=`);
    expect(await res.json()).toEqual({ ok: true, user: USER });
  });

  it("401s a wrong password and an unknown user alike, without a cookie", async () => {
    const h = harness();
    const wrong = await h.app.request("/auth/login", form(USER, "nope"));
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect(await wrong.text()).toContain("用户名或密码不正确");
    const ghost = await h.app.request("/auth/login", { ...form("ghost", PASS), headers: { "content-type": "application/json" } });
    expect(ghost.status).toBe(401);
    expect(await ghost.json()).toEqual({ ok: false, error: "invalid username or password" });
    const empty = await h.app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(empty.status).toBe(401);
  });

  it("429s after the window's failures and clears the counter on success", async () => {
    const h = harness();
    for (let i = 0; i < AUTH_MAX_FAILURES; i++) {
      expect((await h.app.request("/auth/login", form(USER, "nope"))).status).toBe(401);
    }
    // The 6th attempt is refused BEFORE the password is looked at, so even the
    // correct password is 429 inside the window.
    const blocked = await h.app.request("/auth/login", form(USER, PASS));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("set-cookie")).toBeNull();
    // ... and so is another username from the same client: the IP key counts the
    // same failures (per-username AND per-IP, by design).
    expect((await h.app.request("/auth/login", form("someone-else", PASS))).status).toBe(429);
  });

  it("does not count a success against the limiter (login, fail, login again)", async () => {
    const h = harness();
    expect((await h.app.request("/auth/login", form(USER, PASS))).status).toBe(200);
    expect((await h.app.request("/auth/login", form(USER, "nope"))).status).toBe(401);
    expect((await h.app.request("/auth/login", form(USER, PASS))).status).toBe(200);
  });
});

describe.skipIf(!HAS_HTPASSWD)("GET /auth/check (the nginx gate)", () => {
  it("200s a valid cookie, 401s a missing / forged / expired one", async () => {
    const h = harness();
    const login = await h.app.request("/auth/login", form(USER, PASS));
    const cookie = cookieOf(login);
    const ok = await h.app.request("/auth/check", { headers: { cookie } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, user: USER });

    expect((await h.app.request("/auth/check")).status).toBe(401);
    const forged = await h.app.request("/auth/check", { headers: { cookie: `${AUTH_COOKIE}=not.a.token` } });
    expect(forged.status).toBe(401);
    expect(forged.headers.get("cache-control")).toBe("no-store");
    // A tampered user part keeps the shape but must not verify.
    const [name, value] = cookie.split("=");
    const parts = (value ?? "").split(".");
    const tampered = `${name}=${Buffer.from("root").toString("base64url")}.${parts.slice(1).join(".")}`;
    expect((await h.app.request("/auth/check", { headers: { cookie: tampered } })).status).toBe(401);
  });

  it("keeps the signing secret in Studio's own data dir, mode 0600", async () => {
    const h = harness();
    const path = join(h.root, "studio-auth.secret");
    expect(existsSync(path)).toBe(false); // created lazily, on first use
    await h.app.request("/auth/login", form(USER, PASS));
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8").trim().length).toBeGreaterThan(20);
  });
});
