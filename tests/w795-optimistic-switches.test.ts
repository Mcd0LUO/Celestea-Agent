// @vitest-environment jsdom
/**
 * W795 ②③ statusline 与其余乐观交互的当帧终态 + 失败回滚（真实模块 + 真实 DOM 事件）：
 *   · 工作方式徽标切换（statusline/mode.ts）
 *   · 模型 / 推理档位切换（statusline/picker.ts，冷启动清单也不再写占位）
 *   · 目录选择弹窗的面包屑（ui/fsbrowser.ts）
 *   · 提问卡片的提交（ui/question/card.ts）
 * 夹具在 tests/lib/w795-dom.ts。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// 夹具一律走**静态** import：vi.resetModules() 之后再动态 import 夹具会拿到新实例，
// 那时它与这里持有的旋钮对象（statusBySession/configStub/modeStub）就不是同一份了。
import {
  all,
  at,
  click,
  configStub,
  doc,
  el,
  Ev,
  flush,
  modeStub,
  resetHarness,
  sessionModelStub,
  statusBySession,
  type ElLike,
  type SlMod,
} from "./lib/w795-dom.js";

describe("W795 ②③ statusline：工作方式 / 模型 / 推理档位", () => {
  let sl: SlMod;

  beforeEach(async () => {
    resetHarness();
    Object.assign(statusBySession, {
      "ws/s1": { ok: true, mode: "standard", model: "m-old", reasoning_effort: "low" },
    });
    sl = (await import(/* @vite-ignore */ at("statusline.ts"))) as SlMod;
    sl.statusline.setSession("ws/s1");
    await flush();
  });
  afterEach(() => {
    sl?.statusline.stop();
  });

  it("②③ 工作方式：点「执行模式」同步就换徽标；409 回滚 + 冻结文案就地可见", async () => {
    expect(el("slMode").textContent).toBe("标准");
    click(el("slMode"));
    await flush(); // 弹层 + 能力位探测（清单当帧就已渲染）
    const opts = all("#statusline .sl-opt");
    expect(opts).toHaveLength(2);

    modeStub.status = 409;
    modeStub.payload = { ok: false, error: "turn 进行中，无法切换模式" };
    click(opts[1]);
    // —— 同一帧（同步、未 await 网络）：徽标已经是「执行」——
    expect(el("slMode").textContent).toBe("执行");
    await flush();
    expect(el("slMode").textContent, "409 = 本轮没切过去 ⇒ 必须回滚").toBe("标准");
    expect(el("slHint").textContent).toBe("turn 进行中，无法切换模式");
    expect(doc.querySelector("#statusline .sl-popup")?.textContent ?? "").not.toContain("切换中");
  });

  it("② 工作方式（真人点击·事件冒泡）：乐观重绘后弹层仍在屏幕上", async () => {
    click(el("slMode"));
    await flush();
    const opts = all("#statusline .sl-opt");
    modeStub.status = 409;
    modeStub.payload = { ok: false, error: "turn 进行中，无法切换模式" };
    click(opts[1], true); // ← 冒泡，与真人点击一致
    expect(el("slMode").textContent).toBe("执行"); // 当帧终态
    await flush();
    expect(el("slMode").textContent).toBe("标准"); // 409 ⇒ 回滚
    expect(doc.querySelector("#statusline .sl-popup"), "弹层必须留在屏幕上（用户可重选）").not.toBeNull();
    expect(doc.querySelector("#statusline .sl-popup-status")?.textContent).toBe("turn 进行中，无法切换模式");
  });

  it("②③ 模型：点一行同步就换成新模型；写入失败回滚到原模型并说明原因", async () => {
    const cfg = configStub;
    cfg.resp = {
      ok: true,
      model: "m-old",
      reasoning_effort: "low",
      available: {
        models: [
          { id: "m-old", name: "Old", provider_id: "p1", active: true },
          { id: "m-new", name: "New", provider_id: "p1" },
        ],
      },
    };
    click(el("slModel"));
    // 冷启动（无配置缓存）：模型清单确无本地真源 ⇒ 正文先留空，**不写任何占位**
    expect(doc.querySelector("#statusline .sl-popup-body")?.textContent ?? "").toBe("");
    await flush(2);

    const row = all("#statusline .sl-opt").find(
      (b) => (b.querySelector(".sl-opt-val")?.textContent ?? "") === "m-new",
    );
    expect(row, "m-new 行必须渲染出来").toBeTruthy();

    // W870：有聚焦会话 ⇒ 模型切换打会话级端点，故障注入也打在那里（断言不变）。
    sessionModelStub.status = 500; // 写入失败
    click(row ?? null);
    // —— 同一帧（同步、未 await 网络）：模型格已经是新模型 ——
    expect(el("slModel").textContent).toBe("m-new");
    await flush(4);
    expect(el("slModel").textContent, "写入失败 ⇒ 回滚到原模型").toBe("m-old");
    const status = doc.querySelector("#statusline .sl-popup-status");
    expect(status?.textContent ?? "").toContain("切换失败");
    expect(status?.textContent ?? "").toContain("已恢复原设置");
  });

  it("② 推理档位：清单是静态候选，冷启动也当帧画出来（零占位、零等待）", async () => {
    click(el("slEffort"));
    // —— 同一帧（同步、未 await 配置请求、无缓存）——
    const opts = all("#statusline .sl-opt");
    expect(opts.map((b) => b.querySelector(".sl-opt-name")?.textContent)).toEqual([
      "标准（清除）",
      "low",
      "high",
      "max",
    ]);
    // 「当前」项来自状态栏快照（快照里有 low），说明乐观渲染不是空清单
    const current = opts
      .filter((b) => b.querySelector(".sl-opt-tag") !== null)
      .map((b) => b.querySelector(".sl-opt-name")?.textContent);
    expect(current).toEqual(["low"]);
    expect(doc.querySelector("#statusline .sl-popup-body")?.textContent ?? "").not.toMatch(/加载|正在/);
  });
});

describe("W795 ②③ 目录选择弹窗：面包屑当帧即到目标目录，失败回滚", () => {
  interface FsMod {
    openFsBrowser(opts: {
      title: string;
      confirmLabel: string;
      busyLabel: string;
      onPick: (path: string, ui: { close(): void }) => void;
    }): void;
  }
  let fs: FsMod;

  beforeEach(async () => {
    resetHarness();
    // 服务端事实：'' 与 '/' → 根目录（子目录 a）；'/a' → 子目录 b；更深 → 拒绝
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url);
      const path = decodeURIComponent(/path=([^&]*)/.exec(u)?.[1] ?? "");
      if (!u.startsWith("/api/fs/browse")) return { ok: false, status: 404, json: async () => ({ ok: false }) };
      if (path === "" || path === "/") return { ok: true, status: 200, json: async () => ({ ok: true, path: "/", dirs: ["a"] }) };
      if (path === "/a") return { ok: true, status: 200, json: async () => ({ ok: true, path: "/a", dirs: ["b"] }) };
      return { ok: true, status: 200, json: async () => ({ ok: false, error: "no such dir" }) };
    });
    fs = (await import(/* @vite-ignore */ at("ui/fsbrowser.ts"))) as FsMod;
  });

  const crumbs = (): string[] => all(".ws-fs-crumbs button").map((b) => b.textContent ?? "");
  const dirNames = (): string[] => all(".ws-fs-dir-name").map((n) => n.textContent ?? "");
  const statusText = (): string => doc.querySelector(".ws-fs-status")?.textContent ?? "";
  const clickDir = (name: string): void => {
    click(all(".ws-fs-dir").find((r) => (r.querySelector(".ws-fs-dir-name")?.textContent ?? "") === name) ?? null);
  };

  it("②③ 点子目录：面包屑同步就往前走；服务端拒绝时回滚到原目录并说明原因", async () => {
    fs.openFsBrowser({ title: "选择目录", confirmLabel: "选择此目录", busyLabel: "处理中…", onPick: () => {} });
    await flush(2);
    expect(crumbs()).toEqual(["/"]);
    expect(dirNames()).toEqual(["a"]);

    clickDir("a");
    expect(crumbs(), "同一帧：面包屑已经到 /a").toEqual(["/", "a"]);
    await flush(2);
    expect(crumbs()).toEqual(["/", "a"]);
    expect(dirNames()).toEqual(["b"]);
    expect(statusText()).toContain("已选择目录");

    clickDir("b");
    expect(crumbs()).toEqual(["/", "a", "b"]); // 乐观：当帧就到目标
    await flush(2);
    // 服务端说这个目录不行 ⇒ 面包屑回滚到动作前（没跳过去就不装作到了那里）+ 说明原因
    expect(crumbs()).toEqual(["/", "a"]);
    expect(statusText()).toContain("浏览失败");
    expect(statusText()).not.toContain("加载中");
  });
});

describe("W795 ②③ 提问卡片：提交当帧终态，失败回滚", () => {
  interface CardMod {
    renderQuestionCard(ctx: unknown, raw: unknown): unknown;
  }
  const FRAME = {
    session: "ws/s1",
    id: "q-795",
    expires_at: Date.now() + 300_000,
    timeout_ms: 300_000,
    questions: [
      { id: "pick", question: "选哪个？", header: "确认", options: [{ label: "方案 A" }, { label: "方案 B" }] },
    ],
  };
  let card: CardMod;
  let answerStatus = 200;

  const pane = (): { id: string; el: ElLike; hint: ElLike; streaming: boolean; stickBottom: boolean } => {
    const container = doc.createElement("div");
    const hint = doc.createElement("div");
    doc.body.appendChild(container);
    doc.body.appendChild(hint);
    // 会话容器的最小真形状：卡片挂载时要 hideEmptyHint(ctx)（读 ctx.hint）并判定贴底
    return { id: "ws/s1", el: container, hint, streaming: false, stickBottom: false };
  };
  const pick = (p: { el: ElLike }, label: string): void => {
    const input = Array.from(p.el.querySelectorAll(".q-opt-input")).find(
      (r) => (r as unknown as { value: string }).value === label,
    ) as unknown as (ElLike & { checked: boolean }) | undefined;
    if (input) {
      input.checked = true;
      input.dispatchEvent(new Ev("change"));
    }
  };

  beforeEach(async () => {
    resetHarness();
    answerStatus = 200;
    vi.stubGlobal("fetch", async () => ({
      ok: answerStatus < 300,
      status: answerStatus,
      json: async () => (answerStatus < 300 ? { ok: true } : { ok: false, error: "answer failed" }),
    }));
    card = (await import(/* @vite-ignore */ at("ui/question/card.ts"))) as CardMod;
  });

  it("② 点「提交作答」当帧就是「已作答」终态（零占位文案）", async () => {
    const p = pane();
    card.renderQuestionCard(p, FRAME);
    pick(p, "方案 A");
    click(p.el.querySelector(".q-submit"));
    expect(p.el.querySelector(".q-card")?.dataset["state"], "同一帧（同步、未 await 网络）").toBe("done");
    expect(p.el.querySelector(".q-result")?.textContent ?? "").toContain("方案 A");
    expect(p.el.querySelector(".q-submit")?.disabled).toBe(true);
    expect(p.el.textContent ?? "").not.toMatch(/提交中|正在提交/);
    await flush(2);
    expect(p.el.querySelector(".q-card")?.dataset["state"]).toBe("done");
  });

  it("③ 提交失败：回滚到可作答 + 说明原因（可重试）", async () => {
    answerStatus = 500;
    const p = pane();
    card.renderQuestionCard(p, FRAME);
    pick(p, "方案 B");
    click(p.el.querySelector(".q-submit"));
    await flush(2);
    expect(p.el.querySelector(".q-card")?.dataset["state"]).toBe("pending");
    expect(p.el.querySelector(".q-submit")?.disabled).toBe(false);
    expect(p.el.querySelector(".q-hint")?.textContent ?? "").toContain("提交失败");
    expect(p.el.querySelector(".q-hint")?.textContent ?? "").toContain("可重试");
    expect(p.el.textContent ?? "").not.toMatch(/提交中|正在提交/);
  });
});

describe("W795 ②③ SSE done 后的挂起重试：当帧画终态，失败回滚", () => {
  interface SlHost extends SlMod {
    statusline: SlMod["statusline"] & {
      onSseDone(): void;
      pendingPatch: Record<string, unknown> | null;
      pendingPick: { model: string; providerId: string } | null;
    };
  }
  let sl: SlHost;

  beforeEach(async () => {
    resetHarness();
    Object.assign(statusBySession, {
      "ws/s1": { ok: true, mode: "standard", model: "m-old", reasoning_effort: "low" },
    });
    sl = (await import(/* @vite-ignore */ at("statusline.ts"))) as SlHost;
    sl.statusline.setSession("ws/s1");
    await flush();
  });
  afterEach(() => {
    sl?.statusline.stop();
  });

  it("② pendingPatch（409 挂起的档位切换）：本轮结束时当帧就画上新档位；失败回滚", async () => {
    expect(el("slEffort").textContent).toBe("low");
    configStub.saveStatus = 500; // 写入失败
    sl.statusline.pendingPatch = { reasoning_effort: "max" };
    sl.statusline.onSseDone();
    // —— 同一帧（同步、未 await 网络）：档位已经画上，且没有任何「正在应用切换…」占位 ——
    expect(el("slEffort").textContent).toBe("max");
    expect(el("slHint").textContent).not.toMatch(/正在|加载中/);
    await flush(4);
    expect(el("slEffort").textContent, "写入失败 ⇒ 回滚到原档位").toBe("low");
    expect(el("slHint").textContent).toContain("切换失败");
    expect(el("slHint").textContent).toContain("已恢复原设置");
  });

  it("② pendingPick（409 挂起的模型切换）：本轮结束时当帧就画上新模型；失败回滚", async () => {
    expect(el("slModel").textContent).toBe("m-old");
    // W870：会话级路径的故障注入（断言不变）。
    sessionModelStub.status = 500;
    sl.statusline.pendingPick = { model: "m-new", providerId: "" };
    sl.statusline.onSseDone();
    expect(el("slModel").textContent).toBe("m-new");
    expect(el("slHint").textContent).not.toMatch(/正在|加载中/);
    await flush(4);
    expect(el("slModel").textContent).toBe("m-old");
    expect(el("slHint").textContent).toContain("已恢复原设置");
  });
});
