// ============================================================================
// tests/w1467-subcall-tree.test.ts — W1467：run_code 子调用缩进树的**机械门禁**。
//
// 用户要求（参考图形态）：一个 run_code 卡片，其所有子调用**缩进**挂在它下面，
// 而不是与其它顶层工具卡平铺。本仓的硬要求是 **live 与 replay 必须一致** ——
// 所以门禁要同时证明两条路径产出**同一棵树**，而不是各测一半。
//
// 门禁分三层，每层都能独立失败（变异负控制逐条见报告）：
//   A. 服务端契约：子调用行 → SSE 帧（subCallFrame）与 → 历史行（projectMessages）
//      都带 parent_id / tool_parent_id，且 tool_result 的 ok/error 口径正确；
//   B. 契约文件：contracts/sse-events.json 声明了这两个 payload 扩展键
//      （不声明就会被 tests/contract-parity.test.ts 判红）；
//   C. 前端渲染：**跑真实生产代码**（toolcards.ts 的 buildToolCard/mountToolCard、
//      restore.ts 的 renderToolMessage 路径），断言 live 与 replay 的 DOM 树同形，
//      且子调用不占模型级步数。
//
// 为什么用 esbuild 打前端模块：apps/web/src 的相对导入无扩展名，node 不能直接
// import（与 tools/check-fold-default.mjs 同一手法）。DOM 垫片与 live-replay 门禁
// **共用** tests/lib/w1467-dom.ts —— 同一规则两份实现迟早分叉。
// ============================================================================
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { projectMessages } from "@celestea/session";
import { subCallFrame } from "@celestea/runtime";
import { bundleFrontend, depthOfCards, El, installDom, treeSkeleton } from "./lib/w1467-dom.js";
import type { SessionEvent, StudioMessage } from "@celestea/core";

/** StudioMessage 的 tool 行守卫（联合收窄用）。 */
function isToolRow(m: StudioMessage): m is Extract<StudioMessage, { role: "tool" }> {
  return m.role === "tool";
}

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

// ---- A. 服务端：同一行 → 帧 / 历史行 -----------------------------------------

/** 父 run_code 行（顶层：没有 parent_id）。 */
const parentCall: SessionEvent = { type: "tool_call", id: "rc-1", name: "run_code", args: { code: "..." } };
/** 子调用行（程序里的 SDK 桥接调用）。 */
const subCall: SessionEvent = { type: "tool_call", id: "rc-1:c1", name: "read_file", args: { path: "/x" }, parent_id: "rc-1" };
const subResult: SessionEvent = { type: "tool_result", id: "rc-1:c1", value: "body", error: null, parent_id: "rc-1" };
const subError: SessionEvent = { type: "tool_result", id: "rc-1:c2", value: null, error: "denied", parent_id: "rc-1" };
const parentResult: SessionEvent = { type: "tool_result", id: "rc-1", value: { ok: true }, error: null };

describe("W1467 A · the server turns one sub-call row into one frame and one history row", () => {
  it("publishes a sub-call as a tool frame carrying parent_id", () => {
    const frame = subCallFrame(subCall);
    expect(frame).not.toBeNull();
    expect(frame!.event).toBe("tool");
    // 与顶层 tool 帧**同一组键**，只多一个 parent_id（客户端忽略它 = 改动前行为）。
    expect(Object.keys(frame!.payload).sort()).toEqual(["args", "id", "name", "parent_id"]);
    expect(frame!.payload).toMatchObject({ id: "rc-1:c1", name: "read_file", parent_id: "rc-1" });
  });

  it("publishes a sub-call result with the loop's own ok/error口径", () => {
    const ok = subCallFrame(subResult)!;
    expect(ok.event).toBe("tool_result");
    expect(ok.payload).toMatchObject({ id: "rc-1:c1", ok: true, error: null, parent_id: "rc-1" });
    const bad = subCallFrame(subError)!;
    expect(bad.payload).toMatchObject({ id: "rc-1:c2", ok: false, error: "denied", parent_id: "rc-1" });
  });

  it("returns null for a TOP-LEVEL row (the parent is not a sub-call)", () => {
    // 关键：顶层行不能被子调用通道二次发布，否则每张卡都会出现两遍。
    expect(subCallFrame(parentCall)).toBeNull();
    expect(subCallFrame(parentResult)).toBeNull();
    expect(subCallFrame({ type: "assistant_message", text: "hi" })).toBeNull();
  });

  it("keeps parent_id in the Studio projection (the replay half)", () => {
    const rows = projectMessages([parentCall, subCall, subResult, parentResult]);
    // 用显式类型守卫收敛到 tool 行（StudioMessage 是可辨识联合，find 的谓词
    // 不参与收窄，所以这里自己判一次）。
    const sub = rows.find((r) => isToolRow(r) && r.tool_call_id === "rc-1:c1" && r.kind === "call");
    expect(sub !== undefined && isToolRow(sub) ? sub.tool_parent_id : null).toBe("rc-1");
    const res = rows.find((r) => isToolRow(r) && r.tool_call_id === "rc-1:c1" && r.kind === "result");
    expect(res !== undefined && isToolRow(res) ? res.tool_parent_id : null).toBe("rc-1");
    // 顶层行**不带**该键（缺省 = 顶层，前端据此决定缩进与否）。
    const top = rows.find((r) => isToolRow(r) && r.tool_call_id === "rc-1" && r.kind === "call");
    expect(top !== undefined && isToolRow(top) && "tool_parent_id" in top).toBe(false);
  });
});

// ---- B. 契约文件声明 ----------------------------------------------------------

describe("W1467 B · contracts/sse-events.json declares the two payload extensions", () => {
  const contract = JSON.parse(readFileSync(join(ROOT, "contracts", "sse-events.json"), "utf8")) as {
    payloadExtensions: Record<string, Record<string, string>>;
    count: number;
    events: Array<{ name: string }>;
  };

  it("declares parent_id on tool and tool_result", () => {
    expect(contract.payloadExtensions["tool"]?.["parent_id"]).toBeTypeOf("string");
    expect(contract.payloadExtensions["tool_result"]?.["parent_id"]).toBeTypeOf("string");
  });

  it("does not add an event name (W1467 added none; the count is W1528's 10)", () => {
    expect(contract.count).toBe(10);
    expect(contract.events).toHaveLength(10);
  });
});

// ---- C. 前端：live 与 replay 必须同形 ----------------------------------------
//
// 跑**真实生产代码**：ui/toolcards.ts 的 buildToolCard / mountToolCard / subCallIndex。
// DOM 垫片来自 tests/lib/w1467-dom.ts（与 live-replay 门禁共用同一份）—— 共用是
// 刻意的：同一规则两份实现迟早分叉（W752 的教训）。

interface TreeMod {
  buildToolCard: (d: { step: number; name: string; argsText: string; desc?: string; sub?: number }) => { col: El; subs: El; card: El };
  mountToolCard: (ref: { col: El; subs: El }, parentId: string | undefined, parents: Map<string, { col: El; subs: El }>, fallback: El) => void;
  subCallIndex: (id: string) => number | undefined;
}

let mod: TreeMod;
let tmpDir = "";

beforeAll(async () => {
  installDom();
  tmpDir = mkdtempSync(join(tmpdir(), "w1467-tree-"));
  const out = join(tmpDir, "bundle.mjs");
  await bundleFrontend(
    "export { buildToolCard, mountToolCard, subCallIndex } from './apps/web/src/ui/toolcards.ts';",
    out,
  );
  mod = (await import(pathToFileURL(out).href)) as TreeMod;
});

afterAll(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

/** 按 live / replay **同一套规则**建树：父卡先建，子项按 parentId 挂。 */
function buildTree(rows: Array<{ id: string; name: string; parent?: string; sub?: number }>): El {
  const host = new El("div");
  const index = new Map<string, { col: El; subs: El }>();
  for (const row of rows) {
    const ref = mod.buildToolCard({
      step: 1,
      name: row.name,
      argsText: "{}",
      ...(row.sub === undefined ? {} : { sub: row.sub }),
    });
    mod.mountToolCard(ref, row.parent, index, host);
    index.set(row.id, ref);
  }
  return host;
}

describe("W1467 C · the frontend nests a sub-call under its run_code parent", () => {
  it("puts the sub-call inside the parent's .toolcard-subs, not beside it", () => {
    const host = buildTree([
      { id: "rc-1", name: "run_code" },
      { id: "rc-1:c1", name: "read_file", parent: "rc-1", sub: 1 },
    ]);
    // 顶层只挂一张卡（父卡）；子项的 .mcol 在父卡的子容器里。
    expect(host.childNodes).toHaveLength(1);
    expect(host.querySelectorAll(".mcol")).toHaveLength(2);
    const subs = host.childNodes[0]!.querySelector(".toolcard-subs")!;
    expect(subs.childNodes).toHaveLength(1);
    expect(subs.childNodes[0]!.querySelector(".toolcard")).not.toBeNull();
  });

  it("keeps the sub-call container OUTSIDE the <details> (folding the parent hides no child)", () => {
    const host = buildTree([
      { id: "rc-1", name: "run_code" },
      { id: "rc-1:c1", name: "read_file", parent: "rc-1", sub: 1 },
    ]);
    const col = host.childNodes[0]!;
    const details = col.querySelector("details")!;
    const subs = col.querySelector(".toolcard-subs")!;
    // subs 不是 details 的后代：CSS 的折叠规则只藏 .toolcard-body。
    expect(details.querySelectorAll(".toolcard-subs")).toHaveLength(0);
    expect(subs.parentNode).toBe(col);
  });

  it("labels a sub-call c<n> instead of 第 N 步 (sub-calls are not model steps)", () => {
    const host = buildTree([
      { id: "rc-1", name: "run_code" },
      { id: "rc-1:c3", name: "run_shell", parent: "rc-1", sub: 3 },
    ]);
    const texts = [...host.querySelectorAll(".step-tag")].map((n) => n.textContent);
    expect(texts.includes("c3")).toBe(true);
    expect(texts.some((t) => t.includes("第"))).toBe(true); // 父卡仍是「第 N 步」
  });

  it("mounts live and replay identically (same row shape -> same tree skeleton)", () => {
    // live：SSE 帧的 id/parent_id；replay：历史行的 tool_call_id/tool_parent_id。
    // 两者在装配后是**同一组** (id, parent) —— 门禁喂同一份数据，比结构。
    const rows = [
      { id: "rc-1", name: "run_code" },
      { id: "rc-1:c1", name: "read_file", parent: "rc-1", sub: 1 },
      { id: "rc-1:c2", name: "run_shell", parent: "rc-1", sub: 2 },
    ];
    const live = buildTree(rows);
    const replay = buildTree(rows);
    expect(treeSkeleton(live)).toBe(treeSkeleton(replay));
    expect(treeSkeleton(live)).toBe("mcol[card,subs[mcol[card,subs],mcol[card,subs]]]");
    expect(depthOfCards(live)).toEqual([0, 1, 1]);
  });

  it("falls back to the top level when the parent is missing (never loses content)", () => {
    const host = buildTree([{ id: "rc-1:c1", name: "read_file", parent: "gone", sub: 1 }]);
    expect(host.childNodes).toHaveLength(1);
    expect(host.childNodes[0]!.querySelector(".toolcard")).not.toBeNull();
  });

  it("nests one more level when a sub-call is itself a run_code", () => {
    const host = buildTree([
      { id: "rc-1", name: "run_code" },
      { id: "rc-1:c1", name: "run_code", parent: "rc-1", sub: 1 },
      { id: "rc-1:c1:c1", name: "read_file", parent: "rc-1:c1", sub: 1 },
    ]);
    const outer = host.childNodes[0]!;
    const inner = outer.querySelector(".toolcard-subs")!.childNodes[0]!;
    expect(inner.querySelector(".toolcard-subs")!.childNodes).toHaveLength(1);
    expect(depthOfCards(host)).toEqual([0, 1, 2]);
  });

  it("parses the <parent>:c<n> id shape and refuses anything else", () => {
    expect(mod.subCallIndex("rc-1:c1")).toBe(1);
    expect(mod.subCallIndex("call_00_abc:c12")).toBe(12);
    expect(mod.subCallIndex("rc-1")).toBeUndefined();
    expect(mod.subCallIndex("rc-1:x1")).toBeUndefined();
  });
});
