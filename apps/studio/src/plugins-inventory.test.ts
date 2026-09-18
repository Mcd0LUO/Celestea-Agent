/**
 * W860 — GET /api/plugins must be the MOUNTED host plugins, never a transcription.
 *
 * composeStudio records pluginNames(storePlugins(...)) + pluginNames(hostPlugins(...))
 * at mount time (StudioServices.hostPluginNames). This test re-derives the SAME
 * names from the same two factories and compares them name for name with the
 * endpoint: if the handler went back to a hand-kept constant while plugins.ts
 * gained a plugin, this test turns red immediately.
 *
 * Boundary asserted too: the inventory is the HOST startup layer (layer "host",
 * hot false). Plugins the engine mounts while composing a session are not part
 * of it, and activating a session must not change the answer.
 */

import { afterEach, describe, expect, it } from "vitest";
import { pluginNames } from "@celestea/core";
import { FIXED_NOW, getJson, jsonRequest, makeHarness, type StudioHarness } from "./harness.test-util.js";
import { hostPlugins, storePlugins } from "./plugins.js";

const harnesses: StudioHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

function open(): StudioHarness {
  const h = makeHarness({ session: { name: "s1", log: "" } });
  harnesses.push(h);
  return h;
}

interface PluginRow {
  name: string;
  layer: string;
  hot: boolean;
}

describe("W860 GET /api/plugins", () => {
  it("returns exactly the names storePlugins()/hostPlugins() mounted, in mount order", async () => {
    const h = open();
    const res = await getJson(h.app, "/api/plugins");
    expect(res.status).toBe(200);
    expect(res.body["ok"]).toBe(true);
    const rows = res.body["plugins"] as PluginRow[];

    // Re-derived from the LIVE factories — the anti-drift assertion (a
    // hand-copied constant in the handler fails here the day plugins.ts grows).
    const expected = [
      ...pluginNames(storePlugins(h.studio.services.config, () => FIXED_NOW)),
      ...pluginNames(hostPlugins(h.runtime, h.studio.services.bus)),
    ];
    expect(rows.map((row) => row.name)).toEqual(expected);
    // The record the handler reads IS that mount record.
    expect(h.studio.services.hostPluginNames).toEqual(expected);

    // Frozen contents today: the five store plugins + the three host singletons.
    expect(rows.map((row) => row.name)).toEqual([
      "studio/workspaces",
      "studio/sessions",
      "studio/session-ops",
      "studio/providers",
      "studio/prompts",
      "studio/bus",
      "studio/runtime",
      "studio/settings",
    ]);
    expect(new Set(rows.map((row) => row.name)).size).toBe(rows.length);

    // The two frozen per-row fields of the host layer.
    for (const row of rows) {
      expect(row.layer).toBe("host");
      expect(row.hot).toBe(false);
      expect(Object.keys(row).sort()).toEqual(["hot", "layer", "name"]);
    }
  });

  it("is a startup snapshot: activating a session adds no row", async () => {
    const h = open();
    const before = (await getJson(h.app, "/api/plugins")).body["plugins"];
    await getJson(h.app, "/api/sessions/sample-ws%2Fs1/activate", jsonRequest("POST"));
    const after = (await getJson(h.app, "/api/plugins")).body["plugins"];
    expect(after).toEqual(before);
  });
});
