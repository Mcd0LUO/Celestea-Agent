/**
 * W857 — a session's permission BASELINE must reach the REPORTED tool face.
 *
 * W9 (read-only / write-read / full-access) applies `toolDeny` twice: the
 * composed instance folds it into its `DisclosurePolicy.blocked`
 * (`engine-plugins.ts`), and `RealRuntimeAdapter.sessionTools` — the seam behind
 * `GET /api/tools?session=` and the settings page's tool list
 * (`handlers/config-shape.ts`) — has to apply the SAME rule (W791 §10.5 #2: the
 * prompt's `{{tools}}`, the HTTP answer and the registry the agent loop really
 * dispatches through are ONE face).
 *
 * Before W857 `sessionTools` only folded the MODE, so a read-only session still
 * reported `write_file` over HTTP while its own instance did not offer it.
 *
 * Level: the REAL adapter (`RealRuntimeAdapter` through `createStudioEngine`), a
 * throwaway data dir and throwaway session dirs. Deliberately NOT an
 * `engineTools` re-derivation: the divergence lived exactly between the composed
 * instance and this adapter path.
 */

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getJson, type StudioHarness } from "../harness.test-util.js";
import type { RealRuntimeAdapter } from "./real-runtime-adapter.js";
import { engineOf, makeEngineHarness } from "./test-util.js";

/**
 * The frozen standard face of the production registry (W791/W804/W7/W884: 14 names).
 * The SET is asserted (never "some substring is absent"): a tool that silently
 * disappears — or one that silently survives — fails here either way.
 */
const STANDARD_FACE: readonly string[] = [
  "ask_user_question",
  "http_request",
  "list_dir",
  "load_skill",
  "process_control",
  "read_file",
  "read_image",
  "run_code",
  "run_shell",
  "send_message",
  "spawn_worker",
  "stop_worker",
  "worker_status",
  "write_file",
].sort();

/** `read-only` (W9) = the standard face minus the preset's `toolDeny` (`write_file`). */
const READ_ONLY_FACE: readonly string[] = STANDARD_FACE.filter((name) => name !== "write_file");

/** The execution-mode face (W791 M7; W884 keeps load_skill): the mode fold, before any permission. */
const EXECUTION_FACE: readonly string[] = ["http_request", "load_skill", "process_control", "run_code", "send_message", "spawn_worker", "stop_worker", "worker_status"].sort();

const READ_ONLY_SESSION = "sample-ws/ro";
const BYSTANDER_SESSION = "sample-ws/full";

const harnesses: StudioHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

function engine(): StudioHarness {
  const h = makeEngineHarness({
    sessions: { ro: [], full: [] },
    // Pin the permission env: the developer's shell must not decide the preset
    // this test starts from (W9 reads CELESTEA_PERMISSION_DEFAULT/MAX).
    env: { CELESTEA_PERMISSION_DEFAULT: "", CELESTEA_PERMISSION_MAX: "" },
  });
  harnesses.push(h);
  return h;
}

/** Hand-write `<session dir>/permission.json` — the shape the W9 writer emits. */
function writePermission(h: StudioHarness, name: string, preset: string): void {
  writeFileSync(join(h.workspace, name, "permission.json"), JSON.stringify({ version: 1, session: `sample-ws/${name}`, preset, updated_at: 1_700_000_000 }));
}

/** `adapter.sessionTools(session)` — the seam both host readers call. */
function adapterFace(adapter: RealRuntimeAdapter, session: string): string[] {
  const sessionTools = adapter.sessionTools;
  if (sessionTools === undefined) throw new Error("the real adapter must implement sessionTools");
  return sessionTools.call(adapter, session).map((tool) => tool.name).sort();
}

/** The same face over the reported HTTP surface (`GET /api/tools?session=`). */
async function httpFace(h: StudioHarness, session: string): Promise<string[]> {
  const res = await getJson(h.app, `/api/tools?session=${encodeURIComponent(session)}`);
  expect(res.status).toBe(200);
  return (res.body["tools"] as Array<{ name: string }>).map((tool) => tool.name).sort();
}

describe("W857 · the permission baseline reaches the reported tool face", () => {
  it("removes write_file for a read-only session and puts it back on full-access", () => {
    const h = engine();
    const adapter = engineOf(h);

    // Baseline: no permission.json yet -> the full standard face, name for name.
    expect(adapterFace(adapter, READ_ONLY_SESSION)).toEqual(STANDARD_FACE);

    writePermission(h, "ro", "read-only");
    // The regression: before W857 this answered the 13-name standard face.
    expect(adapterFace(adapter, READ_ONLY_SESSION)).toEqual(READ_ONLY_FACE);
    expect(adapterFace(adapter, READ_ONLY_SESSION)).toContain("read_file");

    // The preset is read per call — no recompose, no re-activate.
    writePermission(h, "ro", "full-access");
    expect(adapterFace(adapter, READ_ONLY_SESSION)).toEqual(STANDARD_FACE);

    // Deleting the file resolves to the default (full-access) again (W9 order).
    rmSync(join(h.workspace, "ro", "permission.json"));
    expect(adapterFace(adapter, READ_ONLY_SESSION)).toEqual(STANDARD_FACE);
  });

  it("keeps the deny per session and agrees with the composed instance and HTTP", async () => {
    const h = engine();
    const adapter = engineOf(h);
    writePermission(h, "ro", "read-only");

    // A neighbour without the file keeps the full face: nothing leaked.
    expect(adapterFace(adapter, BYSTANDER_SESSION)).toEqual(STANDARD_FACE);

    // The COMPOSED INSTANCE — the registry the agent loop really dispatches
    // through — already applied toolDeny before W857. The reported face must
    // match it (W791 §10.5 #2's invariant; the divergence is the W857 defect).
    const composed = adapter.sessionContext(READ_ONLY_SESSION).tools.map((tool) => tool.name).sort();
    expect(composed).toEqual(READ_ONLY_FACE);
    expect(adapterFace(adapter, READ_ONLY_SESSION)).toEqual(composed);

    // The exact surface from the bug report.
    expect(await httpFace(h, READ_ONLY_SESSION)).toEqual(composed);
    expect(await httpFace(h, BYSTANDER_SESSION)).toEqual(STANDARD_FACE);
  });

  it("keeps the execution fold: toolDeny subtracts, it never restores a folded name", () => {
    const h = makeEngineHarness({
      sessions: { exec: [] },
      meta: { exec: { mode: "execution" } },
      env: { CELESTEA_PERMISSION_DEFAULT: "", CELESTEA_PERMISSION_MAX: "" },
    });
    harnesses.push(h);
    const adapter = engineOf(h);

    expect(adapterFace(adapter, "sample-ws/exec")).toEqual(EXECUTION_FACE);

    // read-only denies `write_file` AND `read_file` — both already folded by the
    // mode: the intersection is the execution face, nothing comes back.
    writePermission(h, "exec", "read-only");
    expect(adapterFace(adapter, "sample-ws/exec")).toEqual(EXECUTION_FACE);
    expect(adapterFace(adapter, "sample-ws/exec")).not.toContain("write_file");
    expect(adapterFace(adapter, "sample-ws/exec")).not.toContain("read_file");
  });
});
