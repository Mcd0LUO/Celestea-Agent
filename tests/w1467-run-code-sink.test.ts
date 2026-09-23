// ============================================================================
// tests/w1467-run-code-sink.test.ts — W1467：run_code 子调用行的**端到端接线**门禁。
//
// 背景：W1467 之前，run_code 的子调用虽然由 broker 正确 dispatch，但**没有任何
// 消费者** —— `assembleTools` 从不传 `runCode.events`，于是：
//   · 会话日志里没有 `parent_id` 行（真机实测：92 行日志 0 条 parent_id，
//     而 run_code 调用有 20 次，程序里的 read_file/list_dir/run_shell 全丢了）；
//   · SSE 自然也没有子调用帧；
//   · 前端拿不到缩进信息 —— 用户看到的只能是平铺的一张 run_code 卡。
//
// 本门禁跑**真实生产装配**（assembleTools + 真 run_code 工具 + 真 broker + 真沙箱），
// 只把四个 SDK 工具换成 echo 替身（这样断言不依赖磁盘状态，且与 broker.test.ts
// 的 echo 矩阵同一手法）。断言子调用行确实到达注入的 sink，且行形状满足下游两个
// 消费者：
//   A. 会话日志：type/id/name/parent_id 齐全（→ projectMessages 的 tool_parent_id）；
//   B. SSE 帧：subCallFrame 能把它变成带 parent_id 的 tool / tool_result 帧；
//   C. 顶层 run_code 自己的行**不**走子调用通道（否则每张卡出现两遍）；
//   D. 没注入 sink 时行为与改动前一致（照常执行，只是没人记录）。
// ============================================================================
import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleTools, fnTool, userspaceSandboxWith } from "@celestea/tools";
import { subCallFrame } from "@celestea/runtime";
import { projectMessages } from "@celestea/session";
import type { SessionEvent, StudioMessage, Tool, ToolSpec } from "@celestea/core";

// 收集期就探针（与 broker.test.ts 同一手法）：跳过必须是**可见的 skip**，
// 而不是「提前 return 当通过」。沙箱走 @celestea/tools 的公开 API（包外只能
// 从 src/index.ts 导入，见 .dependency-cruiser.cjs 的 entry-only-tools）。
const dir = mkdtempSync(join(tmpdir(), "w1467-sink-"));
const sandbox = userspaceSandboxWith({ workdir: dir, root: dir, timeoutMs: 30_000, maxTimeoutMs: 120_000, maxOutputBytes: 64 * 1024 });
const pythonReady = await sandbox
  .run({ command: "python3 -c 'print(1)'" })
  .then(() => true)
  .catch(() => false);
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

/** 四个 SDK 工具的 echo 替身（覆盖 broker 子调用用到的全部参数名）。 */
function echoSpec(name: string): ToolSpec {
  return {
    name,
    description: name + " echo (run_code sink test double)",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        command: { type: "string" },
        content: { type: "string" },
        workdir: { type: "string" },
        timeout_ms: { type: "integer" },
      },
      additionalProperties: false,
    },
  };
}

function echoTools(): Tool[] {
  return ["read_file", "write_file", "list_dir", "run_shell"].map((name) =>
    fnTool(echoSpec(name), async (args) => ({ echo: name, args })),
  );
}

function isToolRow(m: StudioMessage): m is Extract<StudioMessage, { role: "tool" }> {
  return m.role === "tool";
}

const PY = [
  "async def main():",
  "    a = tools.read_file(path='/x/a.txt')",
  "    b = tools.list_dir(path='/x')",
  "    return {'a': a, 'b': b}",
].join("\n");

/** 装配一个「真 run_code + echo 子工具 + 注入 sink」的 assembly。 */
function assemblyWith(rows: SessionEvent[] | null) {
  return assembleTools({
    sandbox,
    guard: null,
    tools: echoTools(),
    ...(rows === null ? {} : { runCode: { events: (event: SessionEvent) => rows.push(event) } }),
  });
}

describe.skipIf(!pythonReady)("W1467 · run_code sub-calls reach the sink (log + SSE)", () => {
  it("emits one parent_id row per sub-call through the real assembly", async () => {
    const rows: SessionEvent[] = [];
    const out = await assemblyWith(rows).registry.dispatch({
      call_id: "rc-sink",
      name: "run_code",
      args: { code: PY, language: "python" },
    });
    expect(out.error).toBeNull();
    // 两次子调用 → 两条 call + 两条 result，全部带 parent_id。
    expect(rows).toHaveLength(4);
    const calls = rows.filter((r) => r.type === "tool_call");
    expect(calls.map((c) => (c.type === "tool_call" ? c.id : ""))).toEqual(["rc-sink:c1", "rc-sink:c2"]);
    expect(calls.map((c) => (c.type === "tool_call" ? c.name : ""))).toEqual(["read_file", "list_dir"]);
    for (const row of rows) {
      const parent = row.type === "tool_call" || row.type === "tool_result" ? row.parent_id : undefined;
      expect(parent).toBe("rc-sink");
    }
  });

  it("those rows satisfy BOTH consumers (history + SSE frame)", async () => {
    const rows: SessionEvent[] = [];
    await assemblyWith(rows).registry.dispatch({ call_id: "rc-both", name: "run_code", args: { code: PY, language: "python" } });

    // A. 会话日志投影：每行都带 tool_parent_id（刷新后重建树的依据）。
    const history = projectMessages(rows);
    expect(history).toHaveLength(4);
    for (const m of history) {
      expect(isToolRow(m) ? m.tool_parent_id : null).toBe("rc-both");
    }

    // B. SSE 帧：tool 与 tool_result 各两帧，全部带 parent_id（实时建树的依据）。
    const frames = rows.map((row) => subCallFrame(row)).filter((f) => f !== null);
    expect(frames).toHaveLength(4);
    expect(frames.filter((f) => f!.event === "tool")).toHaveLength(2);
    expect(frames.filter((f) => f!.event === "tool_result")).toHaveLength(2);
    for (const f of frames) expect(f!.payload["parent_id"]).toBe("rc-both");
  });

  it("a TOP-LEVEL run_code row never enters the sub-call channel", async () => {
    const rows: SessionEvent[] = [];
    await assemblyWith(rows).registry.dispatch({ call_id: "rc-top", name: "run_code", args: { code: PY, language: "python" } });
    // 通道里只有子调用；run_code 自己的行由 agent loop 写，不由这个 sink 写 ——
    // 否则日志会出现两条 rc-top（一条 loop 写、一条 sink 写）。
    expect(rows.some((r) => r.type === "tool_call" && r.id === "rc-top")).toBe(false);
    for (const row of rows) {
      const id = row.type === "tool_call" || row.type === "tool_result" ? row.id : "";
      expect(id).toContain(":c");
    }
  });

  it("works with no sink mounted (pre-W1467 behaviour)", async () => {
    const out = await assemblyWith(null).registry.dispatch({ call_id: "rc-nosink", name: "run_code", args: { code: PY, language: "python" } });
    expect(out.error).toBeNull(); // 子调用照常执行，只是没人记录
  });
});
