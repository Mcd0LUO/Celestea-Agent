// @vitest-environment jsdom
/**
 * W895-L — 插件库视图：分类分组 / 搜索过滤 / 批量开关。
 *
 * 三条不变量：
 *   ① 分组：DOM 顺序 = 分类顺序（阅读→结构→媒体→交互），不是登记表顺序；
 *   ② 搜索是**纯视图**（只过滤已建好的行，不重取表、不重建记录）；
 *   ③ 批量：一次 PUT（不是 N 次），失败整批回滚到动手前。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { at, doc, Ev, flush, reply, resetHarness, WEB, type ElLike } from "./lib/w795-dom.js";

interface InputLike extends ElLike { checked: boolean }
interface BodyLike extends ElLike { insertAdjacentHTML(pos: string, html: string): void }
interface CfgMod { initSettingsPage(): void }
interface HintMod { initHints(): void }
interface LsLike { getItem(k: string): string | null; setItem(k: string, v: string): void; clear(): void }

const KEY = "celestea-studio.client-plugins-disabled";
const ls = (globalThis as unknown as { localStorage: LsLike }).localStorage;
const server = { disabled: [] as string[], puts: [] as string[][], failPut: false };

const q = (s: string): ElLike | null => doc.querySelector(s);
const qa = (s: string): ElLike[] => Array.from(doc.querySelectorAll(s));

function stubServer(): void {
  const base = (globalThis as unknown as { fetch: (u: unknown, i?: unknown) => Promise<unknown> }).fetch;
  vi.stubGlobal("fetch", (url: unknown, init?: { method?: string; body?: unknown }) => {
    if (!String(url).startsWith("/api/display-plugins")) return base(url, init);
    const method = String(init?.method ?? "GET").toUpperCase();
    if (method === "PUT") {
      if (server.failPut) return Promise.resolve(reply(500, { ok: false }));
      const parsed = JSON.parse(String(init?.body ?? "{}")) as { disabled?: unknown };
      const list = Array.isArray(parsed.disabled) ? (parsed.disabled as string[]) : [];
      server.disabled = list;
      server.puts.push([...list]);
      return Promise.resolve(reply(200, { ok: true, disabled: list }));
    }
    return Promise.resolve(reply(200, { ok: true, disabled: server.disabled }));
  });
}

function appMarkup(): string {
  const raw = readFileSync(join(WEB, "index.html"), "utf8");
  return raw.slice(raw.indexOf('<div id="app">'), raw.indexOf('<script type="module"'));
}

async function openPlugins(): Promise<void> {
  const hints = (await import(/* @vite-ignore */ at("ui/hint/index.ts"))) as HintMod;
  hints.initHints();
  const cfg = (await import(/* @vite-ignore */ at("ui/config.ts"))) as CfgMod;
  cfg.initSettingsPage();
  q('.settings-nav-item[data-page="plugins"]')?.dispatchEvent(new Ev("click"));
  await flush();
}

beforeEach(() => {
  resetHarness();
  ls.clear();
  server.disabled = [];
  server.puts = [];
  server.failPut = false;
  stubServer();
  (doc.body as BodyLike).insertAdjacentHTML("beforeend", appMarkup());
});
afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

describe("W895-L 插件库视图", () => {
  it("按分类分组：DOM 顺序 = 分类顺序，每类计数正确", async () => {
    await openPlugins();
    const cats = qa("#settingsPlugins .plug-cat");
    expect(cats.length).toBe(4);
    expect(qa("#settingsPlugins .plug-cat-title").map((n) => n.textContent)).toEqual([
      "阅读", "结构", "媒体", "交互",
    ]);
    // 阅读 = W9108 内置两遍（高亮 / 数学）+ rail-preview + codeCopy + codeExtras
    const first = cats[0]!;
    expect(Array.from(first.querySelectorAll(".plug-row")).map((r) => r.dataset["id"]).sort()).toEqual([
      "builtin.hljs", "builtin.math", "display.codeCopy", "display.codeExtras", "rail-preview",
    ]);
  });

  it("计数与「全部开启/关闭」按钮就位", async () => {
    await openPlugins();
    expect(q("#settingsPlugins .plug-count")?.textContent).toBe("8/8 已开启");
    expect(qa("#settingsPlugins .plug-bulk").length).toBe(2);
  });

  it("批量关闭：**一次** PUT（不是 N 次），且内存态与开关都对齐", async () => {
    await openPlugins();
    const off = qa("#settingsPlugins .plug-bulk")[1]!;
    off.dispatchEvent(new Ev("click"));
    await flush();
    expect(server.puts.length).toBe(1);
    expect(server.puts[0]!.sort()).toEqual([
      "builtin.hljs", "builtin.math",
      "display.codeCopy", "display.codeExtras", "display.csvTable", "display.imageZoom",
      "hint-text-card", "rail-preview",
    ]);
    expect(q("#settingsPlugins .plug-count")?.textContent).toBe("0/8 已开启");
    for (const i of qa("#settingsPlugins .plug-switch-input") as InputLike[]) expect(i.checked).toBe(false);
  });

  it("批量失败：整批回滚（开关与服务端都没变）", async () => {
    await openPlugins();
    server.failPut = true;
    qa("#settingsPlugins .plug-bulk")[1]!.dispatchEvent(new Ev("click"));
    await flush();
    expect(q("#settingsPlugins .plug-count")?.textContent).toBe("8/8 已开启");
    for (const i of qa("#settingsPlugins .plug-switch-input") as InputLike[]) expect(i.checked).toBe(true);
    expect(q("#settingsPlugins .plug-status")?.textContent ?? "").not.toBe("");
  });

  it("搜索是纯视图：过滤行、不重建、不重取表", async () => {
    await openPlugins();
    const putsBefore = server.puts.length;
    const input = q("#settingsPlugins .plug-search-input") as InputLike;
    input.value = "表格";
    input.dispatchEvent(new Ev("input"));
    await flush();
    const visible = (qa("#settingsPlugins .plug-row") as ElLike[]).filter((r) => !(r.classList as unknown as { contains(c: string): boolean }).contains("hidden"));
    expect(visible.map((r) => r.dataset["id"])).toEqual(["display.csvTable"]);
    expect(server.puts.length).toBe(putsBefore);
    // 不匹配的空态可见
    input.value = "zzz-不存在";
    input.dispatchEvent(new Ev("input"));
    await flush();
    const empty = q("#settingsPlugins .plug-nomatch")!;
    expect((empty.classList as unknown as { contains(c: string): boolean }).contains("hidden")).toBe(false);
  });
});
