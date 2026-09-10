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
  it("queues an interjection without starting anything", () => {
    const { runtime } = runtimeWithInbox();
    runtime.inject("插话");
    expect(runtime.pendingInjections()).toBe(1);
    expect(runtime.isBusy).toBe(false);
    runtime.inject("再来一条");
    expect(runtime.pendingInjections()).toBe(2);
  });

  it("drains the inbox BEFORE the mailbox, and both before the turn input", async () => {
    const { runtime, log } = runtimeWithInbox();
    const host = runtime.hostSessionId ?? "";
    runtime.workers?.mailbox.send(host, "WORKER_W1_DONE 报告 results/W1-x.md", "session-0");
    runtime.inject("用户的插话");
    expect(runtime.pendingReceipts()).toBe(1);

    expect(await runtime.runTurn("正式输入")).toBe("completed");

    expect(userTexts(log)).toEqual(["用户的插话", "[from session-0] WORKER_W1_DONE 报告 results/W1-x.md", "正式输入"]);
    expect(runtime.pendingInjections()).toBe(0);
    expect(runtime.pendingReceipts()).toBe(0);
  });

  it("keeps the inbox per runtime instance (two sessions cannot see each other)", () => {
    const a = runtimeWithInbox();
    const b = runtimeWithInbox();
    a.runtime.inject("给 A 的");
    expect(b.runtime.pendingInjections()).toBe(0);
    expect(a.runtime.pendingInjections()).toBe(1);
  });
});
