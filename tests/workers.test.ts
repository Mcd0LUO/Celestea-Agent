import { describe, expect, it } from "vitest";
import { getExtra, parseRegistryTsv, serializeRegistryTsv, summarize, workerState } from "@celestea/workers";

const TSV = [
  "W101\t2026-09-07_02:53:01Z\tRUNNING\tsess=session-1 title=t driven=yes report_to=cli-main proc=971216 state=idle",
  "W102\t2026-09-07_03:00:00Z\tDONE\tsess=session-2 proc=971216",
  "W103\t2026-09-07_04:00:00Z\tFAILED\tproc=971216",
  "bad-row",
  "W104\t2026-09-07_05:00:00Z\tWEIRD\tproc=971216",
  "",
].join("\n");

describe("registry.tsv", () => {
  const r = parseRegistryTsv(TSV);

  it("parses valid rows and skips bad ones without crashing", () => {
    expect(r.entries).toHaveLength(3);
    expect(r.skipped).toHaveLength(2);
    expect(r.skipped[0]?.reason).toContain("4 tab-separated");
    expect(r.skipped[1]?.reason).toContain("unknown status");
  });

  it("reads k=v tokens from extra", () => {
    const e = r.entries[0];
    expect(e).toBeDefined();
    expect(getExtra(e!, "sess")).toBe("session-1");
    expect(getExtra(e!, "proc")).toBe("971216");
    expect(getExtra(e!, "missing")).toBeNull();
    expect(workerState(e!)).toBe("idle");
  });

  it("round-trips byte-for-byte", () => {
    const text = serializeRegistryTsv(r.entries);
    expect(text.split("\n").filter((l) => l !== "")).toHaveLength(3);
    expect(parseRegistryTsv(text).entries).toEqual(r.entries);
  });

  it("summarizes by_status and by_state", () => {
    const s = summarize(r.entries);
    expect(s.total).toBe(3);
    expect(s.by_status).toEqual({ RUNNING: 1, DONE: 1, FAILED: 1 });
    expect(s.by_state).toEqual({ idle: 1, "in-turn": 0, running: 0 });
  });
});
