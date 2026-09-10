/**
 * W513 session inbox — the runtime side of mid-turn injection.
 *
 * The inbox is drained by the turn driver together with the host mailbox, at
 * turn start (receipts precede the input, W232) and at every step boundary
 * (W513). This file pins the two drains and their ORDER; the loop's own
 * step-boundary behaviour is covered by `@celestea/agent-loop`.
 */

import { describe, expect, it } from "vitest";
import { compose } from "./compose.js";
import { fakeLoop, memoryLog, memorySessionPlugin, testProfile } from "./fakes.test-util.js";

function runtimeWithInbox() {
  const log = memoryLog();
  const loop = fakeLoop(() => ({ text: "replied" }));
  const runtime = compose({
    profile: testProfile(),
    plugins: [memorySessionPlugin(log)],
    loopFactory: loop.factory,
    workers: { tsvPath: null },
  });
  return { runtime, log };
}

function userTexts(log: ReturnType<typeof memoryLog>): string[] {
  return log.events().filter((e) => e.type === "user_message").map((e) => (e.type === "user_message" ? e.text : ""));
}

describe("session inbox", () => {
  it("tracks the two lanes separately (W515 §1)", () => {
    const { runtime } = runtimeWithInbox();
    runtime.inject("排队等我下一轮开始", "next-turn");
    runtime.inject("插话：现在就转向 B 方案", "next-step");
    expect(runtime.pendingInjections()).toBe(2);
    expect(runtime.pendingInjections("next-turn")).toBe(1);
    expect(runtime.pendingInjections("next-step")).toBe(1);
    expect(runtime.isBusy).toBe(false);
  });

  it("drains the NEXT-TURN lane and the mailbox before the turn input", async () => {
    const { runtime, log } = runtimeWithInbox();
    const host = runtime.hostSessionId ?? "";
    runtime.workers?.mailbox.send(host, "WORKER_W1_DONE 报告 results/W1-x.md", "session-0");
    runtime.inject("排队等我下一轮", "next-turn");
    runtime.inject("只给 step 边界的插话", "next-step");
    expect(runtime.pendingReceipts()).toBe(1);

    expect(await runtime.runTurn("正式输入")).toBe("completed");

    // The next-turn lane and the mailbox precede the input; the next-step lane
    // is NOT drained at the turn start (there is no step boundary yet).
    expect(userTexts(log)).toEqual(["排队等我下一轮", "[from session-0] WORKER_W1_DONE 报告 results/W1-x.md", "正式输入"]);
    expect(runtime.pendingInjections("next-step")).toBe(1);
    expect(runtime.pendingReceipts()).toBe(0);
  });

  it("carries the receipt envelope and drops a duplicate id (W515 §3/§4)", () => {
    const { runtime } = runtimeWithInbox();
    const first = runtime.inject("WORKER_W1_DONE 报告 results/W1-x.md", "next-step", {
      from: "session-0",
      id: "mailbox:7",
      kind: "receipt",
      source: { kind: "subagent-settled", form: "notice", summary: "做完了", senderSessionId: "session-0" },
    });
    expect(first.duplicate).toBe(false);
    expect(first.kind).toBe("receipt");
    expect(first.source.kind).toBe("subagent-settled");
    expect(runtime.pendingInjections("next-step")).toBe(1);

    // The same receipt replayed by a restarted driver is injected ONCE.
    const again = runtime.inject("WORKER_W1_DONE 报告 results/W1-x.md", "next-step", { id: "mailbox:7", kind: "receipt" });
    expect(again.duplicate).toBe(true);
    expect(runtime.pendingInjections("next-step")).toBe(1);
  });

  it("keeps the inbox per runtime instance (two sessions cannot see each other)", () => {
    const a = runtimeWithInbox();
    const b = runtimeWithInbox();
    a.runtime.inject("给 A 的", "next-turn");
    expect(b.runtime.pendingInjections()).toBe(0);
    expect(a.runtime.pendingInjections()).toBe(1);
  });
});
