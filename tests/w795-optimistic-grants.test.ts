// @vitest-environment jsdom
/**
 * W795 ②③④ 权限面板（真实 ui/grants.ts + 真实 DOM 事件 + 真实 fetch 路径）：
 *   ② 乐观路径：调用后**同步**（同一帧内、未 await 网络）就能看到终态；
 *   ③ 回滚路径：请求失败 → 界面复原 + 出现失败提示；
 *   ④ 授权乐观：多步授予中途失败 → **只有失败项**回滚，已成功项保持。
 *
 * 为什么用 jsdom 加载真实模块（pathToFileURL 动态 import，不复刻逻辑）：本机在这里
 * 没有浏览器可跑；真机（headless Blink + CDP 在网络层暂停真实 POST）的同一帧实测见报告。
 * 夹具在 tests/lib/w795-dom.ts。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  at,
  badgeOf,
  bootGrants,
  btnWith,
  click,
  confirmOk,
  el,
  flush,
  grantViaUi,
  note,
  panel,
  panelText,
  presetBtn,
  resetHarness,
  rowOf,
  shieldBadge,
  stub,
  textOf,
  type GrantsMod,
} from "./lib/w795-dom.js";

let grants: GrantsMod;

beforeEach(async () => {
  resetHarness();
  grants = await bootGrants();
});
afterEach(() => {
  grants?.stopGrants();
});

describe("W795 ②③ 权限面板：授予 / 撤销的当帧终态与失败回滚", () => {
  it("② 面板打开即整块画出（有快照时同一帧），且点「授予」后请求在飞时界面已是终态", async () => {
    stub.grantHangCaps.add("network"); // 请求发出后永不返回：界面若没有先画终态就抓不到
    click(el("slGrant"));

    // —— 同一帧：没有 await 任何东西，面板已经整块在屏幕上 ——
    expect(panel(), "点盾牌当帧就要有面板（不能先给空壳/占位）").not.toBeNull();
    expect(badgeOf("network")).toBe("未授予");
    expect(panelText()).not.toMatch(/正在|加载中|读取中|切换中|提交中/);

    click(btnWith("network", "授予"));
    await flush(2); // 确认弹窗（用户确认，不是加载态）
    expect(panelText()).not.toMatch(/正在|加载中|读取中|切换中|提交中/);

    let atRequest = "";
    stub.onRequest = (u, method) => {
      if (method === "POST" && u.endsWith("/grants")) atRequest = badgeOf("network");
    };
    click(confirmOk());
    await flush(4); // 请求已发出、仍在飞

    expect(atRequest, "请求发出的那一刻，界面就必须已经是终态").toBe("已授予 · 永久");
    expect(badgeOf("network")).toBe("已授予 · 永久");
    expect(btnWith("network", "撤销"), "终态 = 出现「撤销」按钮").not.toBeNull();
    expect(shieldBadge(), "盾牌计数同步乐观").toBe("1");
    expect(textOf(".grant-preview")).toContain("访问互联网与内网");
  });

  it("② 撤销：点下去当帧即按「已撤销」画（请求挂起也照样是终态）", async () => {
    click(el("slGrant"));
    await grantViaUi("network");
    expect(badgeOf("network")).toBe("已授予 · 永久");
    expect(shieldBadge()).toBe("1");

    stub.revokeHang = true; // 撤销请求挂起
    click(btnWith("network", "撤销"));
    // —— 同一帧（同步、无 await）——
    expect(badgeOf("network")).toBe("未授予");
    expect(btnWith("network", "撤销")).toBeNull();
    expect(btnWith("network", "授予")).not.toBeNull();
    expect(shieldBadge()).toBe("");
    expect(textOf(".grant-preview")).toContain("不能访问网络");
  });

  it("③ 授予失败 → 该项回滚到「未授予」+ 面板与状态栏都说明原因", async () => {
    stub.grantFailCaps.add("network");
    click(el("slGrant"));
    await grantViaUi("network");

    expect(badgeOf("network")).toBe("未授予");
    expect(btnWith("network", "授予")).not.toBeNull();
    expect(btnWith("network", "撤销")).toBeNull();
    expect(shieldBadge()).toBe("");
    expect(note()).toContain("放宽失败");
    expect(note()).toContain("服务暂时不可用"); // 500 → api 层统一短语
    expect(el("statusText").textContent ?? "").toContain("放宽失败");
    expect(panelText()).not.toMatch(/正在|加载中|切换中|提交中/);
  });

  it("③ 撤销失败 → 该项回滚到「已授予」+ 说明原因", async () => {
    click(el("slGrant"));
    await grantViaUi("network");
    stub.revokeFail = true;
    click(btnWith("network", "撤销"));
    await flush(4);

    expect(badgeOf("network")).toBe("已授予 · 永久");
    expect(btnWith("network", "撤销")).not.toBeNull();
    expect(shieldBadge()).toBe("1");
    expect(note()).toContain("撤销失败");
    expect(note()).toContain("服务暂时不可用");
  });
});

describe("W795 ②④ 快捷授权多步 / 竞态快照 / 事件路径", () => {
  it("④ 快捷授权多步：全部步骤当帧画成已授予；中途失败只回滚失败项", async () => {
    stub.grantFailCaps.add("net_hosts"); // 第 2 步失败
    click(el("slGrant"));
    const preset = presetBtn("本机服务"); // 访问网络 + 指定站点（两步，逐项 POST）
    expect(preset, "预设按钮必须存在").not.toBeNull();
    click(preset);
    await flush(2);
    click(confirmOk());

    let atStep2 = "";
    let atFailure = "";
    let sawNetHostsPost = false;
    stub.onRequest = (u, method, body) => {
      if (method === "POST" && u.endsWith("/grants") && body.includes("net_hosts")) {
        atStep2 = badgeOf("network") + " | " + badgeOf("net_hosts"); // 第 2 步发出时两步都该是已授予
        sawNetHostsPost = true;
        return;
      }
      if (sawNetHostsPost && method === "GET" && u.endsWith("/grants")) {
        atFailure = badgeOf("network") + " | " + badgeOf("net_hosts"); // 权威快照回来之前的这一帧
      }
    };
    await flush(6);

    expect(atStep2).toBe("已授予 · 永久 | 已授予 2 项");
    // 这一帧发生在服务端快照回来之前 ⇒ 结论只可能来自「失败项单独回滚」
    expect(atFailure, "失败项已回滚、已成功项仍保持").toBe("已授予 · 永久 | 未授予");
    expect(badgeOf("network"), "已成功的那一步必须保持已授予").toBe("已授予 · 永久");
    expect(badgeOf("net_hosts"), "只有失败的那一步回滚").toBe("未授予");
    expect(note()).toContain("快捷授权中断");
    expect(note()).toContain("已成功：访问网络");
    expect(panelText()).not.toMatch(/正在|进行中|加载中/);
  });

  it("② 竞态：授予请求还在飞时，一次后台快照刷新不会把已画的终态抹掉", async () => {
    // 真机（headless Blink + CDP 在网络层暂停真实 POST）实测到过这个竞态：请求仍挂着、
    // 服务端快照里当然还没有这一项，若「见到快照就清乐观层」，用户会看到
    // 已授予 → 未授予 → 已授予的闪回。乐观项的「请求结束时刻」与「快照发起时刻」比先后即可避免。
    stub.grantHangCaps.add("network");
    click(el("slGrant"));
    click(btnWith("network", "授予"));
    await flush(2);
    click(confirmOk());
    await flush(4);
    expect(badgeOf("network")).toBe("已授予 · 永久");

    click(el("slGrant")); // 收起
    click(el("slGrant")); // 再打开 → openPanel 会 await refresh(true)（真实并发快照）
    await flush(6);
    expect(badgeOf("network"), "在飞的乐观项不该被竞态快照带走").toBe("已授予 · 永久");
    expect(shieldBadge()).toBe("1");
  });

  it("② 真人点击（事件冒泡）：乐观重绘摘下了被点的按钮，不许被误判成「点了外面」", async () => {
    // 真机 Blink 实测的坑：授予/撤销会**当帧重绘**面板，被点的那颗按钮随即被摘下来；
    // 「点外部即收起」若用 contains() 判定，就会把这一次点击误判成点了外面，面板自己收起
    // （改用事件路径 composedPath() 后不再是问题）。
    click(el("slGrant"));
    await grantViaUi("network");
    expect(badgeOf("network")).toBe("已授予 · 永久");

    stub.revokeHang = true; // 请求挂着：只看这一帧的界面
    click(btnWith("network", "撤销"), true); // ← 冒泡，与真人点击一致
    expect(badgeOf("network")).toBe("未授予");
    expect(panel(), "面板不许因为重绘而收起").not.toBeNull();
    expect(btnWith("network", "授予")).not.toBeNull();
  });

  it("② 乐观层的结算规则（纯模块）：在飞的不被否掉；请求已结束 ⇒ 以服务端事实收口", async () => {
    const st = (await import(/* @vite-ignore */ at("ui/grants/state.ts"))) as {
      optimisticGrant(cap: string, entry: Record<string, unknown>): void;
      optimisticRevoke(cap: string): void;
      optimisticSettle(cap: string | null): void;
      settleOptimistic(grants: readonly Record<string, unknown>[], askedAt: number): void;
      optimisticView(): { granted: { cap?: string }[]; revoked: ReadonlySet<string>; revokeAll: boolean };
    };
    st.optimisticGrant("network", { cap: "network", scope: {}, expires_at: null });
    st.settleOptimistic([], Date.now()); // 请求还在飞：空快照不许否掉它
    expect(st.optimisticView().granted.map((g) => g.cap)).toEqual(["network"]);
    st.optimisticSettle("network"); // 请求结束
    st.settleOptimistic([], Date.now() + 50); // 之后的服务端事实里没有它 ⇒ 真值收口
    expect(st.optimisticView().granted).toEqual([]);

    st.optimisticSettle(null);
    st.optimisticRevoke("read_roots"); // 撤销在飞：快照还列着它，也必须继续按已撤销画
    st.settleOptimistic([{ cap: "read_roots" }], Date.now());
    expect(st.optimisticView().revoked.has("read_roots")).toBe(true);
    st.optimisticSettle("read_roots");
    st.settleOptimistic([], Date.now() + 50); // 快照确认没了 ⇒ 乐观标记作废（真源接管）
    expect(st.optimisticView().revoked.has("read_roots")).toBe(false);
  });

  it("面板行的 data-cap 与本用例用到的能力位一致（防选择器漂移）", () => {
    click(el("slGrant"));
    expect(rowOf("network").getAttribute("data-cap")).toBe("network");
  });
});
