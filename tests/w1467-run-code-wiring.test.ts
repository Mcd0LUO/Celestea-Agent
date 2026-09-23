// ============================================================================
// tests/w1467-run-code-wiring.test.ts — W1467：**宿主侧**子调用接线门禁。
//
// 与 w1467-run-code-sink.test.ts 的分工：那份从 assembleTools 往下测（工具层）；
// 这份从 SessionComposer 往上测（宿主层）—— 因为真机上的子调用行要同时进
// **会话日志**（刷新后重建树的依据）与 **SSE 总线**（实时建树的依据），
// 而这两条都在 composer 的 runCodeSink 里接线。
//
// 断言：
//   A. publishRunCodeEvent 未接线 ⇒ 装配里没有 sink（改动前的行为，字节不变）；
//   B. 接线后，一次 run_code 的每个子调用都**同时**产生：
//        · 一条带 parent_id 的会话日志行（→ 刷新后有 tool_parent_id）
//        · 一次 publishRunCodeEvent 回调（→ 实时帧）
//   C. 顶层 run_code 自己的行不经过这个 sink（不重复）。
// ============================================================================
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userspaceSandboxWith } from "@celestea/tools";
import { SESSION_LOG_SERVICE, TOOL_REGISTRY_SERVICE, type SessionEvent, type SessionLog } from "@celestea/core";
import type { Profile } from "@celestea/runtime";
import type { StudioHarness } from "../apps/studio/src/harness.test-util.js";
import { createOfflineLlm } from "../apps/studio/src/runtime/offline-llm.js";
import { SessionComposer } from "../apps/studio/src/runtime/session-compose.js";
import { sessionWorkspaceOf } from "../apps/studio/src/store/sessions.js";
import { makeEngineHarness, plantSession, turns } from "../apps/studio/src/runtime/test-util.js";

const harnesses: StudioHarness[] = [];
afterEach(() => { for (const h of harnesses.splice(0)) h.cleanup(); });

// 收集期探针（与 broker.test.ts 同一手法）：跳过必须是**可见的 skip**。
// 沙箱走 @celestea/tools 的公开 API（包外只能从 src/index.ts 导入）。
const dir = mkdtempSync(join(tmpdir(), "w1467-wire-"));
const sandbox = userspaceSandboxWith({ workdir: dir, root: dir, timeoutMs: 30_000, maxTimeoutMs: 120_000, maxOutputBytes: 64 * 1024 });
const pythonReady = await sandbox
  .run({ command: "python3 -c 'print(1)'" })
  .then(() => true)
  .catch(() => false);
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

/** 子调用行（tool_call / tool_result）的 parent_id；其他行类型返回 undefined。 */
function toolParentOf(row: SessionEvent): string | undefined {
  return row.type === "tool_call" || row.type === "tool_result" ? row.parent_id : undefined;
}

const PROFILE: Profile = {
  model: "offline-model",
  base_url: "http://127.0.0.1:9/v1",
  api_key_env: "CELESTEA_API_KEY",
  api_key_file: null,
  max_steps: 4096,
  max_parallel_tool_calls: 4,
  reasoning_effort: null,
  max_output_tokens: null,
  context_window_tokens: 1_000_000,
  system_prompt: "engine identity prompt",
  request_format: "chat_completions",
  temperature: null,
};

/** 一个单会话 harness + 指定接线方式的 composer。 */
function composerWith(publish?: (sessionId: string | null, event: SessionEvent) => void) {
  const h = makeEngineHarness({ sessions: { s1: turns(1) } });
  harnesses.push(h);
  const services = h.studio.services;
  const composer = new SessionComposer({
    env: {},
    baseProfile: () => PROFILE,
    llm: () => createOfflineLlm({}),
    workers: false,
    ledgerFile: null,
    sandbox,
    resolveSession: (id) => {
      const r = services.sessions.resolve(id);
      if (r.ok !== true) return null;
      // workspace 必须是解析后的 SessionWorkspace 对象（不是路径串）。
      return { sessionId: id, dir: r.value.dir, workspace: sessionWorkspaceOf(r.value) };
    },
    ...(publish === undefined ? {} : { publishRunCodeEvent: publish }),
  });
  const resolved = services.sessions.resolve("sample-ws/s1");
  if (!resolved.ok) throw new Error("the harness session must resolve");
  const runtime = composer.compose("sample-ws/s1", resolved.value.dir);
  return { h, runtime };
}

/** 直接拿到 run_code 的装配（不经模型），驱动一次真子调用。 */
async function runOneSubCall(runtime: { ctx: { get<T>(t: string): T | undefined } }): Promise<void> {
  const registry = runtime.ctx.get<{ dispatch(i: { call_id: string; name: string; args: unknown }): Promise<unknown> }>(TOOL_REGISTRY_SERVICE);
  expect(registry).toBeDefined();
  await registry!.dispatch({
    call_id: "rc-wire",
    name: "run_code",
    args: { code: "async def main():\n    return tools.list_dir(path='/x')", language: "python" },
  });
}

describe("W1467 · the HOST wires run_code sub-calls to BOTH the log and the bus", () => {
  it("mounts no sink at all when the host publishes nothing (pre-W1467 bytes)", async () => {
    const { runtime } = composerWith();
    try {
      const before = runtime.session.events().length;
      await runOneSubCall(runtime);
      const rows = runtime.session.events();
      // 没有接线 ⇒ 子调用行一条都不落盘（这正是改动前的真机现象）。
      expect(rows.length).toBe(before);
      expect(rows.some((r) => r.type === "tool_call" && r.parent_id !== undefined)).toBe(false);
    } finally { runtime.release(); }
  });

  it.skipIf(!pythonReady)(
    "appends one parent_id log row AND publishes one callback per sub-call",
    async () => {
      const seen: SessionEvent[] = [];
      const { runtime } = composerWith((_sid, event) => seen.push(event));
      try {
        await runOneSubCall(runtime);
        const rows = runtime.session.events().filter((r) => r.type === "tool_call" || r.type === "tool_result");
        const subRows = rows.filter((r) => r.type === "tool_call" && toolParentOf(r) === "rc-wire");
        // A. 日志：子调用行带 parent_id（刷新后重建树的依据）。
        expect(subRows.length).toBeGreaterThan(0);
        expect(subRows.every((r) => r.id.startsWith("rc-wire:c"))).toBe(true);
        // B. 总线：同一次子调用也回调了（实时建树的依据）。
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.every((r) => toolParentOf(r) === "rc-wire")).toBe(true);
        // C. 两条通道行数一致（同一次子调用不会只走一边）。
        expect(seen.length).toBe(runtime.session.events().filter((r) => toolParentOf(r) === "rc-wire").length);
      } finally { runtime.release(); }
    },
  );
});
