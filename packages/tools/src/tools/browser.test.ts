/**
 * F4 step 2b -- browser tool argument handling (no browser).
 *
 * The manager is replaced by a recording double (cast through unknown: the real
 * class has private state, which is exactly what a structural double cannot
 * satisfy), so this file pins only the tool-layer contract: the http(s) gate,
 * the action enum, the required ref, and value pass-through.
 */

import { describe, expect, it } from "vitest";

import type { BrowserManager, BrowserResult } from "../browser/session.js";
import { assertHttpUrl, browserActSpec, browserActTool, browserOpenSpec, browserOpenTool } from "./browser.js";

interface Recorded {
  open: Array<{ url: string; viewport?: { width: number; height: number } }>;
  act: Array<Record<string, unknown>>;
}

function double(result?: Partial<BrowserResult>): { manager: BrowserManager; seen: Recorded } {
  const seen: Recorded = { open: [], act: [] };
  const value = { ok: true, url: "https://example.com/", title: "T", snapshot: { text: "", refs: [], truncated: false, truncation_reason: null, total_nodes: 0, included_nodes: 0 }, screenshot: null, attachments: [], isolation: {}, notes: [], ...result };
  const manager = {
    open: async (url: string, viewport?: { width: number; height: number }) => {
      seen.open.push({ url, ...(viewport === undefined ? {} : { viewport }) });
      return value;
    },
    act: async (request: Record<string, unknown>) => {
      seen.act.push(request);
      return value;
    },
  } as unknown as BrowserManager;
  return { manager, seen };
}

describe("F4b browser tool specs", () => {
  it("declares the desc label and additionalProperties:false on both", () => {
    for (const spec of [browserOpenSpec(), browserActSpec()]) {
      const properties = spec.parameters["properties"] as Record<string, unknown>;
      expect(properties["desc"]).toBeDefined();
      expect(spec.parameters["additionalProperties"]).toBe(false);
      expect(spec.description).toContain("RLIMIT_AS");
    }
    expect(browserOpenSpec().parameters["required"]).toEqual(["url"]);
    expect(browserActSpec().parameters["required"]).toEqual(["action"]);
  });

  it("gates the URL to http(s)", () => {
    expect(() => assertHttpUrl("https://example.com/")).not.toThrow();
    expect(() => assertHttpUrl("http://127.0.0.1:3777/")).not.toThrow();
    expect(() => assertHttpUrl("file:///etc/passwd")).toThrow(/code=invalid_arg/);
    expect(() => assertHttpUrl("data:text/html,hi")).toThrow(/code=invalid_arg/);
    expect(() => assertHttpUrl("not a url")).toThrow(/code=invalid_arg/);
  });
});

describe("F4b browser tool dispatch", () => {
  it("browser_open passes url + viewport through and returns the manager value", async () => {
    const { manager, seen } = double();
    const outcome = await browserOpenTool({ manager }).executeWith!({ call_id: "c1", name: "browser_open", args: { url: "https://example.com/", viewport: { width: 1280, height: 800 } } });
    expect(seen.open).toEqual([{ url: "https://example.com/", viewport: { width: 1280, height: 800 } }]);
    expect((outcome.value as { url: string }).url).toBe("https://example.com/");
  });

  it("browser_open refuses a non-http URL before touching the manager", async () => {
    const { manager, seen } = double();
    await expect(browserOpenTool({ manager }).executeWith!({ call_id: "c1", name: "browser_open", args: { url: "file:///etc/passwd" } })).rejects.toThrow(/code=invalid_arg/);
    expect(seen.open).toEqual([]);
  });

  it("browser_act requires a ref for click/type/scroll but not for key", async () => {
    const { manager, seen } = double();
    await expect(browserActTool({ manager }).executeWith!({ call_id: "c1", name: "browser_act", args: { action: "click" } })).rejects.toThrow(/code=invalid_arg/);
    const outcome = await browserActTool({ manager }).executeWith!({ call_id: "c2", name: "browser_act", args: { action: "key", key: "Enter" } });
    expect(seen.act[0]).toMatchObject({ action: "key", key: "Enter" });
    expect((outcome.value as { ok: boolean }).ok).toBe(true);
  });

  it("browser_act rejects an unknown action", async () => {
    const { manager } = double();
    await expect(browserActTool({ manager }).executeWith!({ call_id: "c1", name: "browser_act", args: { action: "explode" } })).rejects.toThrow(/code=invalid_arg/);
  });
});
