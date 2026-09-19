/**
 * H · `/api/health.bind` must report the ACTUAL listener, not a constant.
 *
 * The rule this pins ("never lie to the operator"): if the CLI starts on
 * `--port N --bind A`, an operator reading `GET /api/health` must see `A:N`.
 * `--port 0` (ephemeral) must report the real port the OS assigned.
 *
 * This drives the REAL `runWeb` → real `startStudioServer` → real socket over a
 * throwaway CELESTEA_HOME, so it exercises the exact path the installed binary
 * takes (no mocked config).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runWeb } from "./web.js";

describe("celestea web · /api/health.bind", () => {
  it("reports <bind>:<actual port> for --port N --bind A", async () => {
    const home = mkdtempSync(join(tmpdir(), "celestea-h-bind-"));
    const result = runWeb({ port: 0, bind: "127.0.0.1", open: false }, {
      env: { CELESTEA_HOME: home },
      open: () => ({ opened: false, reason: "test" }),
      onSignal: () => {},
    });
    try {
      const bound = await result.handle.listening;
      expect(bound.port).toBeGreaterThan(0);
      const res = await fetch(`http://127.0.0.1:${bound.port}/api/health`);
      const body = (await res.json()) as { bind?: unknown };
      // The operator-facing rule: health.bind === the actual socket.
      expect(body.bind).toBe(`127.0.0.1:${bound.port}`);
    } finally {
      await result.handle.stop("SIGTERM");
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
