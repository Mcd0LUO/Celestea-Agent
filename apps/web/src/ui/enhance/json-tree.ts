// ============================================================================
// ui/enhance/json-tree.ts — JSON / JSONL 树（W895-C2 · 可选组件）
// ----------------------------------------------------------------------------
// 触发：`code` 的 language-json（renderers 把 .jsonl 也映射到 json）且内容能解析。
//   · 单文档 JSON.parse 成功 ⇒ 一棵树；
//   · 否则逐行 JSON.parse（JSONL）⇒ 每行一棵子树；
//   · 都失败 ⇒ **原样保留代码块**（诚实降级：不清空、不报错）。
// 渲染：<details>/<summary> 可折叠树（白名单内、零 JS 交互）；对象/数组显示条目数，
//   标量按类型着色。原文可获取性：把原 `pre`（连同复制按钮的 .code-wrap）移进一个
//   `<details class="json-raw">原文</details>`，默认收起 —— 零 JS 状态即可回到原文。
// 上限：节点数超过 MAX_JSON_NODES ⇒ 放弃结构化（返回 null），交给普通代码块处理，
//   避免一棵巨型树卡死主线程。幂等：pre.dataset.structured 标记。
// ============================================================================
import { t } from "../../i18n";
import { languageOf } from "./code-extras";
import type { Enhancer } from "./registry";

/** 登记表 / 设置页 / 测试共用的身份。 */
export const JSON_TREE_ID = "display.jsonTree";
/** 结构化上限：超过就退回原文。 */
export const MAX_JSON_NODES = 2000;

export type JsonKind = "object" | "array" | "string" | "number" | "boolean" | "null";

export interface JsonNode {
  kind: JsonKind;
  /** 对象键或数组下标；根节点无 key。 */
  key?: string;
  /** 标量的展示文本。 */
  value?: string;
  children?: JsonNode[];
}

/** 一个「JSON 树」遍（工厂：幂等，可反复调用）。 */
export function jsonTreeEnhancer(): Enhancer {
  return { id: JSON_TREE_ID, enhance: applyJsonTree };
}

/**
 * 判定并解析：单文档优先，失败再逐行（JSONL）。返回根节点数组，失败返回 null。
 */
export function decideJson(text: string, lang: string): JsonNode[] | null {
  if (!lang.includes("json")) return null;
  const single = parseJsonTree(text);
  if (single !== null) return single;
  return parseJsonlTree(text);
}

/** 单文档 JSON → 一个根节点；解析失败或超限返回 null。 */
export function parseJsonTree(text: string): JsonNode[] | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const budget = { n: 0 };
  const root = toJsonNode(value, undefined, budget);
  return root === null ? null : [root];
}

/** JSONL：每行一个 JSON 值（空行跳过）；任一行失败或超限返回 null。 */
export function parseJsonlTree(text: string): JsonNode[] | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length === 0) return null;
  const budget = { n: 0 };
  const out: JsonNode[] = [];
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return null;
    }
    const node = toJsonNode(value, undefined, budget);
    if (node === null) return null;
    out.push(node);
  }
  return out;
}

/** 值 → 节点（带节点预算；超限返回 null）。 */
export function toJsonNode(value: unknown, key: string | undefined, budget: { n: number }): JsonNode | null {
  budget.n += 1;
  if (budget.n > MAX_JSON_NODES) return null;
  if (value === null) return { kind: "null", key };
  if (typeof value === "string") return { kind: "string", key, value };
  if (typeof value === "number") return { kind: "number", key, value: String(value) };
  if (typeof value === "boolean") return { kind: "boolean", key, value: String(value) };
  if (typeof value !== "object") return null;
  const children: JsonNode[] = [];
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const child = toJsonNode(value[i], String(i), budget);
      if (child === null) return null;
      children.push(child);
    }
    return { kind: "array", key, children };
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const child = toJsonNode(v, k, budget);
    if (child === null) return null;
    children.push(child);
  }
  return { kind: "object", key, children };
}

function applyJsonTree(container: Element): void {
  for (const pre of Array.from(container.querySelectorAll<HTMLElement>("pre"))) {
    if (pre.dataset["structured"] === "1") continue;
    const code = pre.querySelector("code");
    if (!code) continue;
    const nodes = decideJson(code.textContent ?? "", languageOf(code));
    if (nodes === null) continue; // 诚实降级：原样保留
    attachTree(pre, nodes);
  }
}

function attachTree(pre: HTMLElement, nodes: readonly JsonNode[]): void {
  const raw: HTMLElement = pre.closest(".code-wrap") ?? pre;
  const holder = document.createElement("div");
  holder.className = "json-block";
  holder.appendChild(renderJsonTree(nodes));
  const details = document.createElement("details");
  details.className = "json-raw";
  const summary = document.createElement("summary");
  summary.textContent = t("chat.structured.raw");
  details.appendChild(summary);
  (raw.parentNode ?? pre.parentNode)?.insertBefore(holder, raw);
  details.appendChild(raw);
  holder.appendChild(details);
  pre.dataset["structured"] = "1";
  holder.dataset["jsonTree"] = "1";
}

/** 渲染整棵（多根）树。 */
export function renderJsonTree(nodes: readonly JsonNode[]): HTMLElement {
  const box = document.createElement("div");
  box.className = "json-tree";
  for (const node of nodes) box.appendChild(renderNode(node, 0));
  return box;
}

function renderNode(node: JsonNode, depth: number): HTMLElement {
  if (node.kind === "object" || node.kind === "array") return renderBranch(node, depth);
  return renderLeaf(node);
}

function renderBranch(node: JsonNode, depth: number): HTMLElement {
  const details = document.createElement("details");
  details.className = "json-node";
  details.open = depth < 1; // 只默认展开根层，深层收起
  const summary = document.createElement("summary");
  summary.className = "json-summary";
  if (node.key !== undefined) summary.appendChild(span("json-key", node.key));
  summary.appendChild(span("json-count", t("chat.jsonTree.items", { n: node.children?.length ?? 0 })));
  details.appendChild(summary);
  const kids = document.createElement("div");
  kids.className = "json-children";
  for (const child of node.children ?? []) kids.appendChild(renderNode(child, depth + 1));
  details.appendChild(kids);
  return details;
}

function renderLeaf(node: JsonNode): HTMLElement {
  const row = document.createElement("div");
  row.className = "json-leaf";
  if (node.key !== undefined) row.appendChild(span("json-key", node.key));
  row.appendChild(span("json-" + node.kind, node.value ?? ""));
  return row;
}

function span(cls: string, text: string): HTMLElement {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}
