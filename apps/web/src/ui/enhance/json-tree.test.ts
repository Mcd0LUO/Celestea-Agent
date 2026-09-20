// @vitest-environment jsdom
/**
 * W895-C2 — JSON / JSONL 树。
 *
 * 触发判定（单文档优先、失败再逐行 JSONL）、诚实降级（解析失败原样保留）、
 * 原文可获取（原 pre 移进 <details>）、节点上限、幂等。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface JsonNode { kind: string; key?: string; value?: string; children?: JsonNode[] }
interface JsonMod {
  decideJson(text: string, lang: string): JsonNode[] | null;
  parseJsonTree(text: string): JsonNode[] | null;
  parseJsonlTree(text: string): JsonNode[] | null;
  renderJsonTree(nodes: readonly JsonNode[]): HTMLElement;
  jsonTreeEnhancer(): { id: string; enhance(c: Element): void };
  JSON_TREE_ID: string;
  MAX_JSON_NODES: number;
}

async function mod(): Promise<JsonMod> {
  return (await import(/* @vite-ignore */ "./json-tree")) as JsonMod;
}

function preWithCode(cls: string, text: string): { pre: HTMLElement; code: HTMLElement } {
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.className = cls;
  code.textContent = text;
  pre.appendChild(code);
  document.body.appendChild(pre);
  return { pre, code };
}

beforeEach(() => {
  vi.resetModules();
  document.body.replaceChildren();
});
afterEach(() => {
  document.body.replaceChildren();
});

describe("W895-C2 decideJson / parse（纯函数）", () => {
  it("单文档 JSON 解析成一棵树", async () => {
    const { decideJson } = await mod();
    const nodes = decideJson('{"a":1,"b":[true,null]}', "json");
    expect(nodes).toHaveLength(1);
    expect(nodes![0]!.kind).toBe("object");
    expect(nodes![0]!.children!.map((c) => c.kind)).toEqual(["number", "array"]);
  });

  it("多行 JSONL 逐行解析成多棵子树", async () => {
    const { decideJson } = await mod();
    const nodes = decideJson('{"a":1}\n{"b":2}', "json");
    expect(nodes).toHaveLength(2);
    expect(nodes!.map((n) => n.children![0]!.key)).toEqual(["a", "b"]);
  });

  it("解析失败 / 非 json 语言 / 空输入 → null（诚实降级）", async () => {
    const { decideJson } = await mod();
    expect(decideJson("not json at all", "json")).toBeNull();
    expect(decideJson('{"a":1}', "typescript")).toBeNull();
    expect(decideJson("", "json")).toBeNull();
    expect(decideJson('{"a":1}\nBROKEN', "json")).toBeNull();
  });

  it("超过节点上限 → null（退回原文，不卡主线程）", async () => {
    const { decideJson, MAX_JSON_NODES } = await mod();
    const huge = "[" + Array.from({ length: MAX_JSON_NODES + 50 }, () => "1").join(",") + "]";
    expect(decideJson(huge, "json")).toBeNull();
  });
});

describe("W895-C2 jsonTreeEnhancer（DOM）", () => {
  it("有效 JSON：出树、原文收进 <details>、标记 structured", async () => {
    const { jsonTreeEnhancer } = await mod();
    const { pre } = preWithCode("language-json hljs", '{"a":1,"b":2}');
    const container = document.createElement("div");
    container.appendChild(pre);
    jsonTreeEnhancer().enhance(container);
    expect(pre.dataset["structured"]).toBe("1");
    expect(container.querySelector(".json-tree")).not.toBeNull();
    expect(container.querySelectorAll(".json-node")).toHaveLength(1);
    expect(container.querySelector(".json-count")?.textContent).toContain("2");
    const raw = container.querySelector(".json-raw");
    expect(raw).not.toBeNull();
    expect(raw!.querySelector("pre")).toBe(pre);
  });

  it("解析失败：原样保留（无树、无标记）", async () => {
    const { jsonTreeEnhancer } = await mod();
    const { pre } = preWithCode("language-json", "{ broken");
    const container = document.createElement("div");
    container.appendChild(pre);
    jsonTreeEnhancer().enhance(container);
    expect(container.querySelector(".json-tree")).toBeNull();
    expect(pre.dataset["structured"]).toBeUndefined();
    expect(pre.parentElement).toBe(container);
  });

  it("幂等：重复增强不重复插树", async () => {
    const { jsonTreeEnhancer } = await mod();
    const { pre } = preWithCode("language-json", '{"a":1}');
    const container = document.createElement("div");
    container.appendChild(pre);
    const enh = jsonTreeEnhancer();
    enh.enhance(container);
    enh.enhance(container);
    expect(container.querySelectorAll(".json-tree")).toHaveLength(1);
    expect(container.querySelectorAll(".json-block")).toHaveLength(1);
  });
});
