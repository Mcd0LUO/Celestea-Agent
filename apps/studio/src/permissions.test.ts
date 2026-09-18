/**
 * W9 acceptance at the HTTP surface: the six permission endpoints.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getJson, jsonRequest, makeHarness, type StudioHarness } from "./harness.test-util.js";

const S1 = "sample-ws%2Fs1";
const harnesses: StudioHarness[] = [];

function open(): StudioHarness {
  const h = makeHarness({ session: { name: "s1", log: "" } });
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const preset = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  label: id,
  network: false,
  workspaceWritable: false,
  toolRootsWritable: false,
  writeRoots: [],
  unsandboxed: false,
  toolDeny: ["write_file"],
  ...over,
});

describe("W9 /api/permissions/presets", () => {
  it("lists the three built-ins and creates/updates/deletes a custom preset", async () => {
    const h = open();
    const first = await getJson(h.app, "/api/permissions/presets");
    expect(first.body["ok"]).toBe(true);
    expect((first.body["builtin"] as unknown[]).map((p) => (p as { id: string }).id)).toEqual(["read-only", "write-read", "full-access"]);
    expect(first.body["custom"]).toEqual([]);

    const created = await getJson(h.app, "/api/permissions/presets", jsonRequest("POST", { preset: preset("team-ro") }));
    expect(created.status).toBe(200);
    expect((created.body["preset"] as { id: string }).id).toBe("team-ro");

    const dup = await getJson(h.app, "/api/permissions/presets", jsonRequest("POST", { preset: preset("team-ro") }));
    expect(dup.status).toBe(409);

    const builtin = await getJson(h.app, "/api/permissions/presets", jsonRequest("POST", { preset: preset("read-only") }));
    expect(builtin.status).toBe(409);

    const updated = await getJson(h.app, "/api/permissions/presets/team-ro", jsonRequest("PUT", { preset: preset("team-ro", { workspaceWritable: true, toolDeny: [] }) }));
    expect(updated.status).toBe(200);
    expect((updated.body["preset"] as { workspaceWritable: boolean }).workspaceWritable).toBe(true);

    const del = await getJson(h.app, "/api/permissions/presets/team-ro", jsonRequest("DELETE"));
    expect(del.status).toBe(200);
    expect(del.body["deleted"]).toBe("team-ro");
    const after = await getJson(h.app, "/api/permissions/presets");
    expect(after.body["custom"]).toEqual([]);
  });
});

describe("W9 /api/sessions/{id}/permission", () => {
  it("defaults to full-access and persists an explicit preset", async () => {
    const h = open();
    const def = await getJson(h.app, `/api/sessions/${S1}/permission`);
    expect(def.status).toBe(200);
    expect(def.body["preset"]).toBe("full-access");
    expect((def.body["effective"] as { network: boolean }).network).toBe(true);

    const set = await getJson(h.app, `/api/sessions/${S1}/permission`, jsonRequest("PUT", { preset: "read-only" }));
    expect(set.status).toBe(200);
    const ro = await getJson(h.app, `/api/sessions/${S1}/permission`);
    expect(ro.body["preset"]).toBe("read-only");
    const eff = ro.body["effective"] as { network: boolean; workspaceWritable: boolean; toolDeny: string[] };
    expect(eff.network).toBe(false);
    expect(eff.workspaceWritable).toBe(false);
    expect(eff.toolDeny).toContain("write_file");

    const unknown = await getJson(h.app, `/api/sessions/${S1}/permission`, jsonRequest("PUT", { preset: "nope" }));
    expect(unknown.status).toBe(422);
  });
});

