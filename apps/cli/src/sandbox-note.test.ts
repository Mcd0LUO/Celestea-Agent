import { describe, expect, it } from "vitest";
import type { HostProbe } from "@celestea/tools";
import { sandboxStartupNote } from "./sandbox-note.js";

function probe(usable: boolean, reason: string | null): HostProbe {
  return { platform: "linux", bwrapPath: usable ? "/usr/bin/bwrap" : null, bwrapVersion: usable ? "bubblewrap 0.9" : null, bwrapUsable: usable, bwrapRejectReason: reason, prlimitPath: null, shellUlimitWorks: true, uidThreads: null };
}

describe("sandboxStartupNote", () => {
  it("says bwrap when the probe is usable", () => {
    expect(sandboxStartupNote({ env: {}, probe: probe(true, null) })).toContain("sandbox: bwrap");
  });
  it("SAYS the degradation (Windows / no bwrap) instead of pretending isolation", () => {
    const note = sandboxStartupNote({ env: {}, probe: probe(false, "no bwrap on PATH") });
    expect(note).toContain("DEGRADED to userspace");
    expect(note).toContain("no bwrap on PATH");
    expect(note).toContain("CELESTEA_SANDBOX_FALLBACK=userspace");
  });
  it("reports a fail-closed refusal without throwing", () => {
    const note = sandboxStartupNote({ env: { CELESTEA_SANDBOX_FALLBACK: "fail" }, probe: probe(false, "no bwrap") });
    expect(note).toContain("refusing to execute");
  });
  it("reports an invalid fallback value (fail-closed)", () => {
    expect(sandboxStartupNote({ env: { CELESTEA_SANDBOX_FALLBACK: "typo" }, probe: probe(false, "x") })).toContain("invalid CELESTEA_SANDBOX_FALLBACK");
  });
});
