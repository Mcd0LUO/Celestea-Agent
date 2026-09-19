/**
 * H-security · the non-loopback refusal + the self-cert token, over a REAL socket.
 *
 * Threat this pins: `celestea web --bind 0.0.0.0` used to expose
 * `POST /api/exec` (arbitrary shell as this user) to anyone who could reach the
 * port. The rule is fail-closed: refuse a non-loopback bind with no token, and
 * once a token is set require it on every `/api/*` request except `/api/health`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InsecureBindError } from "@celestea/studio";
import { describe, expect, it } from "vitest";
import { runWeb } from "./web.js";

const TOKEN = "s3cret-token";

function quietDeps(env: NodeJS.ProcessEnv) {
  return { env, open: () => ({ opened: false as const, reason: "test" }), onSignal: () => {} };
}

function exec(home: string, port: number, headers: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/exec`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ command: "true" }),
  });
}

describe("celestea web · non-loopback bind is fail-closed", () => {
  it("REFUSES --bind 0.0.0.0 with no token and prints actionable guidance", () => {
    const home = mkdtempSync(join(tmpdir(), "celestea-h-sec-"));
    try {
      expect(() => runWeb({ port: 0, bind: "0.0.0.0", open: false }, quietDeps({ CELESTEA_HOME: home }))).toThrow(InsecureBindError);
      try {
        runWeb({ port: 0, bind: "0.0.0.0", open: false }, quietDeps({ CELESTEA_HOME: home }));
      } catch (e) {
        const message = e instanceof Error ? e.message : "";
        expect(message).toContain("refusing to bind 0.0.0.0 without authentication");
        expect(message).toContain("--token");
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("allows a non-loopback bind once CELESTEA_AUTH_TOKEN is set", async () => {
    const home = mkdtempSync(join(tmpdir(), "celestea-h-sec-"));
    const result = runWeb(
      { port: 0, bind: "0.0.0.0", open: false },
      quietDeps({ CELESTEA_HOME: home, CELESTEA_AUTH_TOKEN: TOKEN }),
    );
    try {
      const bound = await result.handle.listening;
      expect(bound.port).toBeGreaterThan(0);
    } finally {
      await result.handle.stop("SIGTERM");
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("celestea web · token gate on /api/*", () => {
  it("401 without a token, 200 with it; /api/health stays public", async () => {
    const home = mkdtempSync(join(tmpdir(), "celestea-h-sec-"));
    const result = runWeb({ port: 0, bind: "127.0.0.1", open: false, token: TOKEN }, quietDeps({ CELESTEA_HOME: home }));
    try {
      const { port } = await result.handle.listening;
      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(health.status).toBe(200);

      const noToken = await exec(home, port, {});
      expect(noToken.status).toBe(401);
      expect(await noToken.json()).toEqual({ ok: false, error: "unauthorized" });

      const wrong = await exec(home, port, { "x-celestea-token": "wrong" });
      expect(wrong.status).toBe(401);

      const bearer = await exec(home, port, { authorization: `Bearer ${TOKEN}` });
      expect(bearer.status).toBe(200);

      const header = await exec(home, port, { "x-celestea-token": TOKEN });
      expect(header.status).toBe(200);
      const body = (await header.json()) as { ok?: unknown; exit_code?: unknown };
      expect(body.ok).toBe(true);
      expect(body.exit_code).toBe(0);
    } finally {
      await result.handle.stop("SIGTERM");
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("loopback with NO token keeps the historical open behavior", async () => {
    const home = mkdtempSync(join(tmpdir(), "celestea-h-sec-"));
    const result = runWeb({ port: 0, bind: "127.0.0.1", open: false }, quietDeps({ CELESTEA_HOME: home }));
    try {
      const { port } = await result.handle.listening;
      const res = await exec(home, port, {});
      expect(res.status).toBe(200);
    } finally {
      await result.handle.stop("SIGTERM");
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("celestea web · browser bootstrap cookie (GET /auth/token)", () => {
  it("sets an HttpOnly cookie and 302s to / for the right token, then the cookie alone authorizes /api/sessions", async () => {
    const home = mkdtempSync(join(tmpdir(), "celestea-h-cookie-"));
    const result = runWeb({ port: 0, bind: "127.0.0.1", open: false, token: TOKEN }, quietDeps({ CELESTEA_HOME: home }));
    try {
      const { port } = await result.handle.listening;
      const bootstrap = await fetch(`http://127.0.0.1:${port}/auth/token?token=${TOKEN}`, { redirect: "manual" });
      expect(bootstrap.status).toBe(302);
      expect(bootstrap.headers.get("location")).toBe("/");
      const setCookie = bootstrap.headers.getSetCookie().join("\n");
      expect(setCookie).toContain("celestea_api_token=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");
      expect(setCookie).toContain("Path=/");
      // The raw token must never be the cookie value.
      expect(setCookie).not.toContain(`celestea_api_token=${TOKEN}`);

      const cookie = (setCookie.split("\n")[0] ?? "").split(";")[0] ?? "";
      // No Authorization / x-celestea-token header: the cookie alone must pass.
      const sessions = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { cookie } });
      expect(sessions.status).toBe(200);
      // The real list payload, not the 401 body (which is {ok:false,error}).
      const body = (await sessions.json()) as { error?: unknown; sessions?: unknown };
      expect(body.error).toBeUndefined();
      expect(Array.isArray(body.sessions)).toBe(true);
    } finally {
      await result.handle.stop("SIGTERM");
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("401s a wrong token and sets NO cookie", async () => {
    const home = mkdtempSync(join(tmpdir(), "celestea-h-cookie-"));
    const result = runWeb({ port: 0, bind: "127.0.0.1", open: false, token: TOKEN }, quietDeps({ CELESTEA_HOME: home }));
    try {
      const { port } = await result.handle.listening;
      const res = await fetch(`http://127.0.0.1:${port}/auth/token?token=wrong`, { redirect: "manual" });
      expect(res.status).toBe(401);
      expect(res.headers.getSetCookie()).toEqual([]);
      const missing = await fetch(`http://127.0.0.1:${port}/auth/token`, { redirect: "manual" });
      expect(missing.status).toBe(401);
      expect(missing.headers.getSetCookie()).toEqual([]);
    } finally {
      await result.handle.stop("SIGTERM");
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

