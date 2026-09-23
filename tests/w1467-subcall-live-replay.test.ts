// ============================================================================
// tests/w1467-subcall-live-replay.test.ts — W1467：run_code 子调用树的
// **live 与 replay 一致性**门禁（本仓硬要求）。
//
// 与 w1467-subcall-tree.test.ts 的分工：那份测「树的形状规则」（服务端帧/历史行
// + 前端 buildToolCard/mountToolCard）；这份测**两条真实生产渲染路径**产出同一棵树 ——
//
//   live   路径：chat.ts 的 onTool 回调 → ui/toolcards.ts pushToolCard(ToolPayload)
//   replay 路径：ui/restore.ts restoreSessionHistory → renderToolMessage(HistoryMsg)
//
// 两条路径的 DOM 必须逐节点同形。它们曾经是各写一份构造代码的（W752 的教训：
// 「live 与恢复各写一份 → 默认态分叉」），所以这里不测「各自对」，只测「彼此同」。
//
// replay 一侧跑的是**真实的 restoreSessionHistory**（fetch 打桩喂历史），不是
// 重写一遍规则 —— 否则门禁只能证明「我抄得对」，证明不了生产代码对。
// ============================================================================
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleFrontend, depthOfCards, El, installDom, treeSkeleton } from "./lib/w1467-dom.js";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const WIN = globalThis as unknown as Record<string, unknown>;

interface ToolcardsMod {
  pushToolCard: (ctx: unknown, p: Record<string, unknown>) => El;
  applyToolResult: (ctx: unknown, p: Record<string, unknown>) => void;
}
interface RestoreMod {
  restoreSessionHistory: (ctx: unknown) => Promise<void>;
}

let tc: ToolcardsMod;
let restore: RestoreMod;
let tmpDir = "";

beforeAll(async () => {
  installDom();
  tmpDir = mkdtempSync(join(tmpdir(), "w1467-lr-"));
  const tcOut = join(tmpDir, "toolcards.mjs");
  await bundleFrontend(
    "export { pushToolCard, applyToolResult } from './apps/web/src/ui/toolcards.ts';",
    tcOut,
  );
  tc = (await import(pathToFileURL(tcOut).href)) as ToolcardsMod;
  const rOut = join(tmpDir, "restore.mjs");
  await bundleFrontend("export { restoreSessionHistory } from './apps/web/src/ui/restore.ts';", rOut);
  restore = (await import(pathToFileURL(rOut).href)) as RestoreMod;
});

afterAll(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

/** 一个够 pushToolCard / restoreSessionHistory 用的会话容器（SessionPane 的相关字段）。 */
function fakePane(): Record<string, unknown> {
  return {
    id: "w1467-fixture",
    el: new El("div"),
    hint: new El("div"),
    streaming: false,
    assistant: null,
    lastTextCol: null,
    thinkSeg: null,
    render: { timer: null, deadline: Number.NEGATIVE_INFINITY },
    ops: new Map(),
    step: 0,
    hidden: false,
    stickBottom: true,
    restoreOps: new Map(),
    histToolStep: 0,
    restored: false,
    dedup: { tail: null, guardActive: false, guardBuf: "", guardAll: false },
  };
}

function elOf(pane: Record<string, unknown>): El { return pane["el"] as El; }

/** 同一份逻辑数据，两种线格式：SSE 帧（live）与历史行（replay）。 */
const ROWS = [
  { id: "rc-1", name: "run_code", args: { code: "..." } },
  { id: "rc-1:c1", name: "read_file", args: { path: "/x" } },
  { id: "rc-1:c2", name: "run_shell", args: { command: "echo hi" } },
];

describe("W1467 · live (SSE) and replay (history) render the SAME sub-call tree", () => {
  it("produces an identical tree from a parent + two sub-calls", async () => {
    // live：SSE tool 帧 —— 子调用带 parent_id。
    const livePane = fakePane();
    for (const row of ROWS) {
      const parent = row.id.includes(":") ? "rc-1" : undefined;
      tc.pushToolCard(livePane, { id: row.id, name: row.name, args: row.args, ...(parent === undefined ? {} : { parent_id: parent }) });
    }
    // replay：真实 restoreSessionHistory —— 子调用带 tool_parent_id。
    const replayPane = fakePane();
    WIN["fetch"] = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        messages: ROWS.map((row) => ({
          role: "tool",
          kind: "call",
          tool_call_id: row.id,
          tool_name: row.name,
          tool_args: row.args,
          ...(row.id.includes(":") ? { tool_parent_id: "rc-1" } : {}),
        })),
      }),
    });
    await restore.restoreSessionHistory(replayPane);

    // ① 两条路径的**工具树骨架**逐节点同形：父卡 + 它的两个缩进子项。
    //    （比骨架而不是整棵树：live 抓的是结果未回的时刻，正文必然不同；
    //     本仓要求一致的是「谁缩进在谁之下」这个结构。）
    expect(treeSkeleton(elOf(livePane))).toBe(treeSkeleton(elOf(replayPane)));
    //    骨架读法：顶层 mcol 里一张父卡 + 一个 subs；subs 里两个子项，各带一个空 subs。
    //    （subs 是 .mcol 的子节点而不是 <details> 的子节点 —— 这正是「折叠父卡
    //      仍然看得见子项」的结构前提，w1467-subcall-tree 有专门一条断言守着。）
    expect(treeSkeleton(elOf(livePane))).toBe(
      "mcol[card,subs[mcol[card,subs],mcol[card,subs]]]",
    );
    // ② 而且确实是「父 + 两个缩进子项」的树，不是三张平铺的卡。
    expect(depthOfCards(elOf(livePane))).toEqual([0, 1, 1]);
    expect(depthOfCards(elOf(replayPane))).toEqual([0, 1, 1]);
    // ③ 顶层只挂一张卡（父卡），两个子项都在它的 subs 里。
    expect(elOf(livePane).childNodes).toHaveLength(1);
    expect(elOf(replayPane).querySelectorAll(".mcol")).toHaveLength(3);
  });

  it("keeps sub-calls OUT of the model-level step count on both paths", async () => {
    const livePane = fakePane();
    for (const row of ROWS) {
      const parent = row.id.includes(":") ? "rc-1" : undefined;
      tc.pushToolCard(livePane, { id: row.id, name: row.name, args: row.args, ...(parent === undefined ? {} : { parent_id: parent }) });
    }
    // live：只有父卡算一步（子调用是程序内部的桥接调用，不是模型的一步）。
    expect(livePane["step"]).toBe(1);

    const replayPane = fakePane();
    WIN["fetch"] = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        messages: ROWS.map((row) => ({
          role: "tool",
          kind: "call",
          tool_call_id: row.id,
          tool_name: row.name,
          tool_args: row.args,
          ...(row.id.includes(":") ? { tool_parent_id: "rc-1" } : {}),
        })),
      }),
    });
    await restore.restoreSessionHistory(replayPane);
    // replay：同口径 —— 刷新后的「第 N 步」不会比实时多出子调用的数量。
    expect(replayPane["histToolStep"]).toBe(1);
  });

  it("labels the sub-call c<n> on both paths (same id parsing)", async () => {
    const livePane = fakePane();
    for (const row of ROWS) {
      const parent = row.id.includes(":") ? "rc-1" : undefined;
      tc.pushToolCard(livePane, { id: row.id, name: row.name, args: row.args, ...(parent === undefined ? {} : { parent_id: parent }) });
    }
    const liveTags = [...elOf(livePane).querySelectorAll(".step-tag")].map((n) => n.textContent);
    expect(liveTags.includes("c1")).toBe(true);
    expect(liveTags.includes("c2")).toBe(true);

    const replayPane = fakePane();
    WIN["fetch"] = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        messages: ROWS.map((row) => ({
          role: "tool",
          kind: "call",
          tool_call_id: row.id,
          tool_name: row.name,
          tool_args: row.args,
          ...(row.id.includes(":") ? { tool_parent_id: "rc-1" } : {}),
        })),
      }),
    });
    await restore.restoreSessionHistory(replayPane);
    const replayTags = [...elOf(replayPane).querySelectorAll(".step-tag")].map((n) => n.textContent);
    expect(replayTags.includes("c1")).toBe(true);
    expect(replayTags.includes("c2")).toBe(true);
  });
});
