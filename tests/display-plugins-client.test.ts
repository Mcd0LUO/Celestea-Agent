// @vitest-environment jsdom
/**
 * W895-C1 — the display-component switches read/write the SERVER table.
 *
 * Covered here (the W859 settings-page test keeps the UI half):
 *   · GET fails            -> degrade to "all ON" (never fabricate, never crash);
 *   · PUT fails            -> the switch rolls back and the in-memory mirror is
 *                             left untouched;
 *   · server table is the source of truth (a disabled id is not mounted);
 *   · the localStorage migration happens EXACTLY once (only when the server
 *     table is empty), and only for known ids.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at, doc, flush, reply, resetHarness } from "./lib/w795-dom.js";

const KEY = "celestea-studio.client-plugins-disabled";

interface ApplyMod {
  startClientPlugins(): void;
  whenClientPluginsReady(): Promise<void>;
  setClientPlugin(id: string, on: boolean): Promise<{ ok: boolean; text: string }>;
  isClientPluginOn(id: string): boolean;
}
interface StoreMod {
  disabledPlugins(): string[];
  displayPluginsLoaded(): boolean;
  displayPluginsServerAvailable(): boolean;
}
interface LsLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  clear(): void;
}
const ls = (globalThis as unknown as { localStorage: LsLike }).localStorage;

/** The stubbed server's durable state + failure knobs. */
const server = { disabled: [] as string[], failGet: false, failPut: false, puts: [] as string[][] };

function stubServer(): void {
  const base = (globalThis as unknown as { fetch: (u: unknown, i?: { method?: string; body?: unknown }) => Promise<unknown> }).fetch;
  vi.stubGlobal("fetch", (url: unknown, init?: { method?: string; body?: unknown }) => {
    if (!String(url).startsWith("/api/display-plugins")) return base(url, init);
    const method = String(init?.method ?? "GET").toUpperCase();
    if (method === "PUT") {
      if (server.failPut) return Promise.resolve(reply(500, { ok: false, error: "write failed" }));
      const parsed = JSON.parse(String(init?.body ?? "{}")) as { disabled?: unknown };
      const list = Array.isArray(parsed.disabled) ? (parsed.disabled as string[]) : [];
      server.disabled = list;
      server.puts.push([...list]);
      return Promise.resolve(reply(200, { ok: true, disabled: list }));
    }
    if (server.failGet) return Promise.resolve(reply(404, { ok: false }));
    return Promise.resolve(reply(200, { ok: true, disabled: server.disabled }));
  });
}

/** Boot the real modules and wait for "table fetched + mount reconciled". */
async function boot(): Promise<{ apply: ApplyMod; store: StoreMod }> {
  const apply = (await import(/* @vite-ignore */ at("plugins/apply.ts"))) as ApplyMod;
  const store = (await import(/* @vite-ignore */ at("plugins/store.ts"))) as StoreMod;
  apply.startClientPlugins();
  await apply.whenClientPluginsReady();
  await flush(2);
  return { apply, store };
}

beforeEach(() => {
  resetHarness();
  ls.clear();
  server.disabled = [];
  server.failGet = false;
  server.failPut = false;
  server.puts = [];
  stubServer();
});
afterEach(() => {
  vi.unstubAllGlobals();
  doc.body.replaceChildren();
});

describe("W895-C1 显示组件启用表 · 服务端真源", () => {
  it("读服务端失败 ⇒ 如实降级为全开（不崩、不伪造）", async () => {
    server.failGet = true;
    const { apply, store } = await boot();
    expect(apply.isClientPluginOn("hint-text-card")).toBe(true);
    expect(apply.isClientPluginOn("rail-preview")).toBe(true);
    expect(apply.isClientPluginOn("display.codeCopy")).toBe(true);
    expect(store.disabledPlugins()).toEqual([]);
    expect(store.displayPluginsLoaded()).toBe(true);
    expect(store.displayPluginsServerAvailable()).toBe(false);
  });

  it("服务端表是真源：已关闭的组件不挂载，其余照开", async () => {
    server.disabled = ["hint-text-card"];
    const { apply } = await boot();
    expect(apply.isClientPluginOn("hint-text-card")).toBe(false);
    expect(apply.isClientPluginOn("rail-preview")).toBe(true);
    expect(apply.isClientPluginOn("display.codeCopy")).toBe(true);
  });

  it("PUT 失败 ⇒ 开关回滚且不改内存镜像（服务端也没动）", async () => {
    const { apply, store } = await boot();
    server.failPut = true;
    const r = await apply.setClientPlugin("hint-text-card", false);
    expect(r.ok).toBe(false);
    expect(apply.isClientPluginOn("hint-text-card")).toBe(true); // 真挂载回滚
    expect(store.disabledPlugins()).toEqual([]); // 内存镜像没动
    expect(server.disabled).toEqual([]); // 服务端也没动
  });

  it("PUT 成功 ⇒ 落库 + 更新镜像；重开后仍为关", async () => {
    const first = await boot();
    const ok = await first.apply.setClientPlugin("display.codeCopy", false);
    expect(ok.ok).toBe(true);
    expect(server.disabled).toEqual(["display.codeCopy"]);
    expect(first.store.disabledPlugins()).toEqual(["display.codeCopy"]);
    resetHarness(); // 模块重建；服务端状态保留（= 重开页面）
    stubServer();
    const second = await boot();
    expect(second.apply.isClientPluginOn("display.codeCopy")).toBe(false);
  });

  it("迁移只发生一次：服务端空 + localStorage 有旧值 ⇒ 一次 PUT；此后不再迁移", async () => {
    ls.setItem(KEY, JSON.stringify(["hint-text-card"]));
    server.disabled = [];
    const first = await boot();
    expect(server.puts).toHaveLength(1);
    expect(server.disabled).toEqual(["hint-text-card"]);
    expect(first.apply.isClientPluginOn("hint-text-card")).toBe(false);
    // 第二次加载：服务端已非空 ⇒ 不再 PUT（旧键还在也不迁移）
    resetHarness();
    stubServer();
    await boot();
    expect(server.puts).toHaveLength(1);
  });

  it("重新打开组件后不会被旧值再关掉（迁移**真的**只一次）", async () => {
    // 这条是独立复核补的：只断言「服务端非空 ⇒ 不迁移」不够 —— 用户把组件重新打开后
    // 服务端表会**再次变空**，若旧键还在，下次加载就会把旧值搬回来静默关掉它。
    ls.setItem(KEY, JSON.stringify(["hint-text-card"]));
    server.disabled = [];
    const first = await boot();
    expect(server.puts).toHaveLength(1);
    expect(first.apply.isClientPluginOn("hint-text-card")).toBe(false);

    // 用户把它重新打开 ⇒ 服务端表变回空
    await first.apply.setClientPlugin("hint-text-card", true);
    expect(server.disabled).toEqual([]);

    // 重新加载：服务端表为空，但旧键已被服务端应答作废 ⇒ 不得再次迁移
    resetHarness();
    stubServer();
    const again = await boot();
    expect(server.puts).toHaveLength(2); // 迁移 1 次 + 开关 1 次，没有第 3 次
    expect(server.disabled).toEqual([]);
    expect(again.apply.isClientPluginOn("hint-text-card")).toBe(true);
  });
  it("迁移遇到未知 id：只迁移已知项", async () => {
    ls.setItem(KEY, JSON.stringify(["ghost-plugin", "rail-preview"]));
    server.disabled = [];
    const { apply } = await boot();
    expect(server.puts).toEqual([["rail-preview"]]);
    expect(apply.isClientPluginOn("rail-preview")).toBe(false);
    expect(apply.isClientPluginOn("hint-text-card")).toBe(true);
  });
});
