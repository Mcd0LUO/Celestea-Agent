/**
 * W866 · 用户 → worker 的发言（POST /api/turn {session:'worker:<sid>'}）。
 *
 * 背景：`spawn_worker` 派发的 worker 会话是**引擎内存**里的会话
 * （`worker:<sid>`，归属某个宿主会话的 WorkerRegistry），不在任何工作区目录里。
 * 因此 `/api/turn` 的目标解析（`sessions.require`）对它是必然 404，而
 * `startTurn/inject` 更会为一个不存在的 id 组合出幽灵实例（W833 已修过一次）。
 *
 * 本轮给 `/api/turn` 加了 worker 专线：`workerSidOf()` 认出前缀后走
 * `workerTurn()` —— 投递本身复用模型的 `send_message` 工具
 * （`runtime.workerSend`，见 worker-bridge.ts），所以用户路径与模型路径
 * 不可能漂移；附件与空输入在同一入口被拒，未注册/已结束的 worker 拒绝而不是
 * 假装成功（消息排进没人驱动的队列 = 静默丢失）。
 *
 * 为什么单开一个文件：apps/studio/src/app-domains.test.ts 已 468 行，
 * 加进去会撞 ESLint 的 max-lines(400，跳过空行/注释) —— 与仓库里
 * `runtime/worker-spawn-session.test.ts` 的既有做法一致，按主题分文件。
 */
import { afterEach, describe, expect, it } from "vitest";
import { getJson, jsonRequest, makeHarness, type StudioHarness } from "./harness.test-util.js";

const harnesses: StudioHarness[] = [];

function make(): StudioHarness {
  const h = makeHarness();
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

describe("POST /api/turn 的 worker 专线（W866）", () => {
  it("worker:<sid> 的发言投进该 worker 的收件箱，并回送达回执", async () => {
    const h = make();
    const spawn = await getJson(h.app, "/api/worker/spawn", jsonRequest("POST", { wid: "W866", brief: "brief", title: "互动" }));
    expect(spawn.body).toEqual({ ok: true, sessionId: "session-1", title: "互动", wid: "W866" });

    const res = await getJson(h.app, "/api/turn", jsonRequest("POST", { input: "用户对 worker 说话", session: "worker:session-1" }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      delivered: true,
      injected: false,
      pending: 0,
      placement: "context",
      worker: "session-1",
      status: "RUNNING",
      state: "idle",
    });

    // 消息落在该 worker 自己的转录里（不是某个 filesystem 会话的日志）。
    const messages = await getJson(h.app, "/api/sessions/worker%3Asession-1/messages");
    const rows = messages.body["messages"] as Array<Record<string, unknown>>;
    expect(rows[rows.length - 1]).toEqual({ role: "user", content: "用户对 worker 说话" });
  });

  it("未注册的 worker 是 404，绝不回落成「按会话 id 解析」的路径", async () => {
    const h = make();
    const ghost = await getJson(h.app, "/api/turn", jsonRequest("POST", { input: "hi", session: "worker:session-9" }));
    expect(ghost.status).toBe(404);
    expect(ghost.body).toEqual({ ok: false, error: "unknown session 'worker:session-9'" });
  });

  it("worker 收件箱只收文本：附件 400（在写任何附件字节之前），空输入仍是既有的 400", async () => {
    const h = make();
    await getJson(h.app, "/api/worker/spawn", jsonRequest("POST", { wid: "W866", brief: "brief", title: "互动" }));

    const image = await getJson(
      h.app,
      "/api/turn",
      jsonRequest("POST", { input: "看图", session: "worker:session-1", attachments: [{ data: "aGk=" }] }),
    );
    expect(image.status).toBe(400);
    expect(image.body).toEqual({ ok: false, error: "worker sessions accept text only" });

    const empty = await getJson(h.app, "/api/turn", jsonRequest("POST", { input: "   ", session: "worker:session-1" }));
    expect(empty.status).toBe(400);
    expect(empty.body).toEqual({ error: "input must not be empty" });
  });
});
