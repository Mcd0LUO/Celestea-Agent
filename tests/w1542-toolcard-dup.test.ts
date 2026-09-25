// ============================================================================
// tests/w1542-toolcard-dup.test.ts — W1542：工具卡**行内重复**门禁。
//
// 用户报障：每一行工具卡把同一个工具名印两遍 ——
//     Tool run_shell        ← .msg-caption（「工具」+ 名）
//     c8   run_shell        ← .toolcard-head 里的 .toolcard-name
//
// 真机实测（headless chrome + CDP，冻结快照 87 行，见 results/W1542-before.json）：
//   修复前：87/87 行带 caption；每行名字次数直方图 {1: 18, 2: 69}；
//           2 次的那 69 行**全部**是「卡头印工具名」的行（子行 36 + 父卡在窗口外
//           退回顶层的子行 32 + 顶层 1），1 次的那 18 行全部是「卡头印 desc」的行。
//           ⇒ 重复与「顶层/子行」无关，只与卡头印了什么有关。
//   修复后：子行 0 条 caption；顶层每条 1 条；名字次数恒 ≤1。
//
// 本门禁守这条**行内**不变量，并守住「修 A 不能弄坏 B」：
//   A. 每行自己的头部里工具名**最多出现一次**（2 = 用户报障的重复；卡头 title
//      恒为工具名 ⇒ 名字没丢，只是不再重复印）；
//   B. 子调用行**没有** .msg-caption；顶层行**有**（流级「这是工具调用」的标记
//      不许一起删掉）；
//   C. caption 只说卡头没说的事：卡头印 desc ⇒ caption 必须补工具名；
//      卡头印工具名 ⇒ caption 不得再印一遍；
//   D. **不同 call_id 的同 args 调用一张都不许少**（绝不许按 args 去重）；
//   E. live 与 replay 两条真实路径同规则（本仓硬要求）；
//   F. 父卡缺失退回顶层时仍是子行样式（判据是 id 不是挂载位置）；
//   G. 孤立工具结果行（无对应调用记录）仍保留 caption —— 降级路径不许被误伤。
//
// 「同命令重复」的定性（真机数据，见 results/W1542-before.json 的 oracle）：
//   冻结快照窗口内 87 条 call 行 / 87 个不同 call_id ⇒ 同 call_id 重复 0 条；
//   同 args 的 2 组全部是不同 call_id（同一探针的重复执行）= 模型的合法多次调用。
//   把 DOM 与历史行都归一成 (工具名, 规范化 args) 的有序序列后**逐元素相等**，
//   即「每条 call 恰好渲染一次」——D 条专门守着别把它们吃掉。
//
// 为什么自己写子节点导航而不是用 `:scope > …` 选择器：本仓共用的最小 DOM 垫片
// （tests/lib/w1467-dom.ts）只实现「最后一段」匹配，**祖先链不参与判定** ——
// 用后代选择器写「本行自己的 caption」会静默匹配到嵌套子行的 caption，
// 门禁就会假绿。这里逐级 childNodes 走，口径与真机度量脚本（results/W1542-audit.mjs）
// 逐字一致。
// ============================================================================
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleFrontend, El, installDom } from "./lib/w1467-dom.js";

const WIN = globalThis as unknown as Record<string, unknown>;

interface ToolcardsMod {
  pushToolCard: (ctx: unknown, p: Record<string, unknown>) => El;
  buildToolCard: (d: Record<string, unknown>) => { col: El; subs: El; card: El };
  mountToolCard: (ref: unknown, parentId: string | undefined, parents: Map<string, unknown>, fallback: El) => void;
}
interface RestoreMod { restoreSessionHistory: (ctx: unknown) => Promise<void>; }

let tc: ToolcardsMod;
let restore: RestoreMod;
let tmpDir = "";

beforeAll(async () => {
  installDom();
  tmpDir = mkdtempSync(join(tmpdir(), "w1542-dup-"));
  const tcOut = join(tmpDir, "toolcards.mjs");
  await bundleFrontend(
    "export { pushToolCard, buildToolCard, mountToolCard } from './apps/web/src/ui/toolcards.ts';",
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
    id: "w1542-fixture",
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

// ---- 逐级子节点导航（垫片不做祖先链匹配，见文件头） ----------------------------

/** 直接子元素里带该 class 的第一个（null = 无）。 */
function child(node: El | null, cls: string): El | null {
  if (node === null) return null;
  for (const c of node.childNodes) if (c.classList.contains(cls)) return c;
  return null;
}

/** 该行（.mcol）自己的卡片：.msg > .bubble > .toolcard。 */
function cardOf(row: El): El | null { return child(child(child(row, "msg"), "bubble"), "toolcard"); }
/** 该行**自己的** caption（不含嵌套子行）。 */
function captionOf(row: El): El | null { return child(child(row, "msg"), "msg-caption"); }
/** 该行**自己的**卡头。 */
function headOf(row: El): El | null { return child(cardOf(row), "toolcard-head"); }
/** 卡头里的行容器（.toolcard-head > .toolcard-row1）——名字/步标/状态都在它里面。 */
function row1Of(row: El): El | null { return child(headOf(row), "toolcard-row1"); }
/** 该行自己的卡头名字元素。 */
function nameElOf(row: El): El | null { return child(row1Of(row), "toolcard-name"); }
/** 该行自己的 step 标记。 */
function stepTagOf(row: El): El | null { return child(row1Of(row), "step-tag"); }

/** 一个容器下**直接**挂的工具行（顶层 = pane.el 的直接 .mcol；子行 = subs 的直接 .mcol）。 */
function rowsUnder(host: El): El[] {
  return host.childNodes.filter((c) => c.classList.contains("mcol") && cardOf(c) !== null);
}

/** 全部工具行（含嵌套）—— 用 .toolcard 反查所属 .mcol 需要父子映射，这里直接递归收集。 */
function allRows(host: El): El[] {
  const out: El[] = [];
  const walk = (n: El): void => {
    for (const c of n.childNodes) {
      if (c.classList.contains("mcol") && cardOf(c) !== null) out.push(c);
      walk(c);
    }
  };
  walk(host);
  return out;
}

/**
 * 节点子树的**全部文本**（递归拼接）。
 * 为什么不用 `textContent`：共用的最小 DOM 垫片（tests/lib/w1467-dom.ts）里
 * `textContent` 只回自己 `_text`，**不拼子节点** —— 而 caption 的文案在 span 里、
 * 卡头的文案在 .toolcard-row1 的 span 里。真机 DOM 的 textContent 是拼的，
 * 直接用垫片的会让「名字次数」恒为 0 而门禁假绿。
 */
function textOf(n: El | null): string {
  if (n === null) return "";
  let s = n.textContent;
  for (const c of n.childNodes) s += textOf(c);
  return s;
}

/**
 * 该行卡头名字元素上的**工具名**。
 * 构建方写的是 `nameEl.title = d.name`（属性赋值，真机 DOM 会反射成 title 属性）；
 * 共用的最小 DOM 垫片不做反射，只认 `.title` 这个属性 —— 所以先读属性、
 * 再回落 `getAttribute`，两种宿主下取到同一个值。
 */
function toolNameOf(row: El): string {
  const nameEl = nameElOf(row) as unknown as { title?: string } | null;
  if (nameEl === null) return "";
  const prop = typeof nameEl.title === "string" ? nameEl.title : "";
  return prop !== "" ? prop : (nameElOf(row)!.getAttribute("title") ?? "");
}

/** 卡头**印出来的**文本（.toolcard-name 的内容 = desc 或工具名）。 */
function headLabelOf(row: El): string { return textOf(nameElOf(row)); }

/**
 * 该行自己的头部里工具名出现几次 —— **正是真机度量的那条口径**
 * （caption 文本 + 卡头文本，不含嵌套子行）。
 * 期望恒 ≤1：0 = 卡头印 desc（名字只在 title 里），2 = 用户报障的行内重复。
 */
function nameOccurrencesInRow(row: El): number {
  const tool = toolNameOf(row);
  if (tool === "") return 0;
  const own = textOf(captionOf(row)) + " " + textOf(headOf(row));
  return own.split(tool).length - 1;
}

/** 一行是不是子调用（按 step 标记 c<n> 判 —— 与渲染判据同源）。 */
function isSubRow(row: El): boolean {
  const tag = stepTagOf(row);
  return tag !== null && /^c\d+$/.test(tag.textContent);
}

/** 每行的「行内形状」—— live / replay 必须逐字相同。 */
function shapeOfRow(row: El): string {
  return [
    isSubRow(row) ? "sub" : "top",
    captionOf(row) === null ? "nocap" : "cap",
    "n" + String(nameOccurrencesInRow(row)),
    "head:" + headLabelOf(row),
  ].join("|");
}

/**
 * 同一份逻辑数据，两种线格式：SSE 帧（live）与历史行（replay）。
 * 刻意把 desc / 无 desc、顶层 / 子调用、同 args 不同 id、父卡缺失四种组合都摆进来 ——
 * 少一种组合，门禁就守不住那条规则。
 */
const ROWS = [
  // 顶层 · 无 desc ⇒ 卡头印工具名
  { id: "rc-1", name: "run_code", args: { code: "..." } },
  // 子调用 · 无 desc
  { id: "rc-1:c1", name: "run_shell", args: { command: "echo hi" } },
  // 子调用 · 有 desc ⇒ 卡头印 desc，caption 必须补工具名
  { id: "rc-1:c2", name: "read_file", args: { path: "/x", desc: "读配置" } },
  // ★ D 条：同 args、**不同 call_id** 的合法多次调用（真机 2 组全属此类）
  { id: "rc-1:c3", name: "read_file", args: { path: "/x" } },
  // 顶层 · 有 desc
  { id: "rc-2", name: "read_file", args: { path: "/x", desc: "再读一次" } },
  // 顶层再来一次同 args（不同 id，无 desc）
  { id: "rc-3", name: "read_file", args: { path: "/x" } },
  // ★ F 条：父卡不在窗口里 ⇒ 前端退回顶层，但它仍是子调用（无 caption）
  { id: "rc-9:c1", name: "list_dir", args: { path: "/y" } },
];

function buildLive(): El {
  const pane = fakePane();
  for (const row of ROWS) {
    const parent = row.id.includes(":") ? row.id.slice(0, row.id.indexOf(":")) : undefined;
    tc.pushToolCard(pane, {
      id: row.id, name: row.name, args: row.args,
      ...(parent === undefined ? {} : { parent_id: parent }),
    });
  }
  return elOf(pane);
}

async function buildReplay(): Promise<El> {
  const pane = fakePane();
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
        ...(row.id.includes(":") ? { tool_parent_id: row.id.slice(0, row.id.indexOf(":")) } : {}),
      })),
    }),
  });
  await restore.restoreSessionHistory(pane);
  return elOf(pane);
}

/** 每行「自己的 caption 里有没有工具名」——C 条的判据。 */
function captionCarriesToolName(row: El): boolean {
  const cap = captionOf(row);
  const tool = toolNameOf(row);
  return cap !== null && tool !== "" && textOf(cap).includes(tool);
}

describe("W1542 · 工具卡行内重复（同一个工具名印两遍）", () => {
  it("A. 每行自己的头部里工具名最多出现一次（2 = 报障的重复）", () => {
    const rows = allRows(buildLive());
    expect(rows, "夹具里必须有 7 条工具行").toHaveLength(ROWS.length);
    const counts = rows.map(nameOccurrencesInRow);
    // 修复前是 {2: 69}；修复后只允许 0（卡头印 desc）或 1（卡头印名字）。
    expect(Math.max(...counts), "行内名字次数必须 ≤1，实际 " + JSON.stringify(counts)).toBeLessThanOrEqual(1);
    // 名字没丢：每行卡头的 title 恒为工具名（悬停可辨），且卡头必有文本。
    for (const r of rows) {
      expect(toolNameOf(r), "卡头 title 必须是工具名（名字不许消失）").not.toBe("");
      expect(headLabelOf(r), "卡头必须有可见文本").not.toBe("");
    }
  });

  it("B. 子调用行没有 .msg-caption；顶层行有（流级标记不许一起删掉）", () => {
    const rows = allRows(buildLive());
    // 夹具里 rc-9:c1 的父卡不在窗口 ⇒ 退回顶层，但它仍是子调用（按 id 判）。
    const subShaped = rows.filter(isSubRow);
    const topShaped = rows.filter((r) => !isSubRow(r));
    expect(subShaped, "夹具里必须有 4 条子调用行（rc-1:c1/c2/c3 + rc-9:c1）").toHaveLength(4);
    expect(topShaped, "夹具里必须有 3 条顶层行").toHaveLength(3);
    expect(subShaped.filter((r) => captionOf(r) !== null), "子调用行不许有 caption").toHaveLength(0);
    expect(topShaped.filter((r) => captionOf(r) === null), "顶层行必须有 caption").toHaveLength(0);
  });

  it("C. caption 只说卡头没说的事：卡头印 desc ⇒ 补名字；卡头印名字 ⇒ 不重复印", () => {
    const rows = allRows(buildLive());
    const headIsName = rows.filter((r) => headLabelOf(r) === toolNameOf(r));
    const headIsDesc = rows.filter((r) => headLabelOf(r) !== toolNameOf(r));
    // 两种卡头都得有，否则这条断言是空转。
    expect(headIsName.length, "夹具里必须有「卡头印工具名」的行").toBeGreaterThan(0);
    expect(headIsDesc.length, "夹具里必须有「卡头印 desc」的行").toBeGreaterThan(0);
    // 卡头印名字 ⇒ caption 绝不能再印一遍（这就是用户报障的重复）。
    expect(headIsName.filter(captionCarriesToolName), "卡头已印名字时 caption 不得再印").toHaveLength(0);
    // 卡头印 desc 的**顶层行** ⇒ caption 必须补上工具名（否则工具名只剩 title 悬停）。
    // 只对顶层行断言：子调用行按 B 条**根本没有** caption，那是刻意的（它靠父卡 +
    // c<n> 表明身份），不是「名字丢了」。
    const topDesc = headIsDesc.filter((r) => !isSubRow(r));
    expect(topDesc.length, "夹具里必须有「顶层且卡头印 desc」的行").toBeGreaterThan(0);
    expect(topDesc.filter(captionCarriesToolName), "卡头印 desc 时 caption 必须补名字").toHaveLength(topDesc.length);
  });

  it("D. 不同 call_id 的同 args 调用一张都不许少（绝不按 args 去重）", () => {
    const rows = allRows(buildLive());
    expect(rows).toHaveLength(ROWS.length);
    const readFile = rows.filter((r) => toolNameOf(r) === "read_file");
    expect(readFile, "夹具里 4 次 read_file 必须一张不少").toHaveLength(4);
    // 其中两次的 args **逐字相同**（{path:/x}）、call_id 不同 —— 真机那 2 组就是这一类。
    const sameArgs = readFile.filter((r) => child(cardOf(r), "toolcard-body") !== null
      && r !== null && String((child(cardOf(r), "toolcard-body")!.childNodes
        .find((c) => c.classList.contains("tool-args"))?.textContent ?? "")).replace(/\s+/g, "") === '{"path":"/x"}');
    expect(sameArgs, "同 args 不同 call_id 的两次调用都必须留下").toHaveLength(2);
    // 子调用行仍是三条（c1/c2/c3）—— 没有被「合并」掉。
    const subTags = rows.filter(isSubRow).map((r) => stepTagOf(r)!.textContent).sort();
    expect(subTags).toEqual(["c1", "c1", "c2", "c3"]);
  });

  it("E. live 与 replay 同规则（逐行形状逐字相同）", async () => {
    const live = allRows(buildLive()).map(shapeOfRow);
    const replay = allRows(await buildReplay()).map(shapeOfRow);
    expect(replay).toEqual(live);
    // 形状本身也要钉住（不然两边一起错也「相等」）：顶层 cap、子行 nocap。
    expect(live.filter((s) => s.startsWith("top")).every((s) => s.includes("|cap|"))).toBe(true);
    expect(live.filter((s) => s.startsWith("sub")).every((s) => s.includes("|nocap|"))).toBe(true);
  });

  it("F. 父卡缺失时子调用退回顶层 —— 仍然没有 caption（判据是 id 不是挂载位置）", () => {
    const host = new El("div");
    const ref = tc.buildToolCard({ step: 1, name: "run_shell", argsText: "{}", sub: 3 });
    tc.mountToolCard(ref, "gone-parent", new Map(), host);
    // 落到了顶层（父卡不在索引里）……
    const rows = rowsUnder(host);
    expect(rows).toHaveLength(1);
    // ……但它仍是子调用行，所以照样不该有 caption。
    expect(captionOf(rows[0]!)).toBeNull();
    expect(nameOccurrencesInRow(rows[0]!)).toBe(1);
  });

  it("G. 孤立工具结果行（无对应调用记录）仍保留 caption —— 降级路径不许被误伤", async () => {
    const pane = fakePane();
    WIN["fetch"] = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        messages: [{ role: "tool", kind: "result", tool_call_id: "nope", tool_value: "raw" }],
      }),
    });
    await restore.restoreSessionHistory(pane);
    const rows = allRows(elOf(pane));
    expect(rows, "孤立结果行也要有一行").toHaveLength(0); // 它没有 .toolcard（是 .content.restore-tool）
    const col = elOf(pane).childNodes.find((c) => c.classList.contains("mcol"));
    expect(col, "孤立结果行必须仍在").not.toBeUndefined();
    expect(captionOf(col!), "孤立结果行的 caption 是它唯一的「工具」标记，必须保留").not.toBeNull();
  });

  it("H. 子行仍然缩进在父卡的 .toolcard-subs 下（修 caption 没有弄坏树形）", () => {
    const host = buildLive();
    const top = rowsUnder(host);
    // 顶层挂 4 张：rc-1 / rc-2 / rc-3 / rc-9:c1（父卡缺失退回顶层）。
    expect(top, "顶层只挂 4 张卡").toHaveLength(4);
    const subs = child(top[0]!, "toolcard-subs");
    expect(subs, "父卡必须有子容器").not.toBeNull();
    expect(rowsUnder(subs!)).toHaveLength(3);
  });
});
