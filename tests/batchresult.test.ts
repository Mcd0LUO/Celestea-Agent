/**
 * W792 · 批量端点响应（`failed[]`）→ 面向用户的失败文案。
 *
 * 直接跑生产模块 apps/web/src/ui/batchresult.ts（pathToFileURL 动态 import，不是复刻），
 * fixture 全部是**真实录制**的响应体，来源与时刻如下（不造假形状）：
 *   · REC_DELETE_PARTIAL —— 本会话（W792）2026-09-16 23:47(+08) 对运行中的 3777 实发：
 *       POST /api/sessions/batch-delete {"ids":["<一个已归档会话>","<不存在的 id>"]}
 *       → HTTP 200 {"ok":true,"deleted":1,"failed":[{"id":"<不存在的 id>",
 *         "error":"unknown session '<不存在的 id>'"}]}
 *   · REC_ACTIVE —— 由 harness 架构哥（session-56597d5b）在生产 3777 实测后转述，
 *       原始形态：HTTP 200 {"ok":true,"deleted":0,"failed":[{"id":"…",
 *         "error":"active session … cannot be deleted"}]}（id 与引号被来源省略，
 *       `active session` 与 `cannot be deleted` 为原文）。
 *   · REC_UNKNOWN_WS —— 同上转述：删除伪工作区 engine 的 worker 行 →
 *       {"ok":true,"deleted":0,"failed":[{"id":"…","error":"unknown workspace 'engine'"}]}
 *   · REC_LEGACY —— legacy 服务只回 {"ok":true}（无 deleted/archived/failed）。
 *
 * 重点纪律：服务端英文 error 原文**只写 console、绝不出现在文案里**；
 * 而且**不**为 active 之类做「换个会话再来」的特例（用户裁决：active 只是状态标记）。
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

interface BatchResultModule {
  batchFailureText(verb: string, resp: unknown): string;
  batchDoneCount(resp: unknown): number | undefined;
  batchFailedIds(resp: unknown): string[];
  failedTail(it: { id?: string }): string;
  failureReasonText(err: unknown): string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const mod = (await import(
  /* @vite-ignore */ pathToFileURL(join(HERE, "..", "apps/web/src/ui/batchresult.ts")).href
)) as BatchResultModule;

const REC_DELETE_PARTIAL = {
  ok: true,
  deleted: 1,
  failed: [
    {
      id: "CelesteaTeamAPI/w792-nope-0000000000000.000000000",
      error: "unknown session 'CelesteaTeamAPI/w792-nope-0000000000000.000000000'",
    },
  ],
};
const REC_ACTIVE = {
  ok: true,
  deleted: 0,
  failed: [
    { id: "CelesteaTeamAPI/live-1789000000.000000000", error: "active session 'CelesteaTeamAPI/live-1789000000.000000000' cannot be deleted" },
  ],
};
const REC_UNKNOWN_WS = {
  ok: true,
  deleted: 0,
  failed: [{ id: "engine/w1-1789000000.000000000", error: "unknown workspace 'engine'" }],
};
const REC_LEGACY = { ok: true };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("W792 · failed[] 呈现", () => {
  it("无失败（含 legacy 缺省 failed）⇒ 空串：调用方按成功处理", () => {
    expect(mod.batchFailureText("删除", { ok: true, deleted: 2, failed: [] })).toBe("");
    expect(mod.batchFailureText("删除", REC_LEGACY)).toBe("");
    expect(mod.batchFailureText("删除", null)).toBe("");
    expect(mod.batchFailureText("删除", undefined)).toBe("");
  });

  it("未知会话（真实录制）：失败必须被说出，且带可理解的原因", () => {
    const t = mod.batchFailureText("删除", REC_DELETE_PARTIAL);
    expect(t).toContain("删除失败");
    expect(t).toContain("已不存在");
    expect(t).toContain("已成功 1 个"); // 成功条数来自响应（deleted），不臆造
    expect(t, "不得透传英文原文").not.toContain("unknown session");
    expect(mod.batchDoneCount(REC_DELETE_PARTIAL)).toBe(1);
    expect(mod.batchFailedIds(REC_DELETE_PARTIAL)).toEqual([
      "CelesteaTeamAPI/w792-nope-0000000000000.000000000",
    ]);
  });

  it("活动会话失败（真实形态）：不得把 active 当成「换个会话才行」", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = mod.batchFailureText("删除", REC_ACTIVE);
    expect(t).toContain("删除失败");
    expect(t, "active 只是状态标记，不是保护理由").not.toContain("切换");
    expect(mod.failureReasonText("active session 'x' cannot be deleted")).toBe("");
    expect(t).toContain(mod.failedTail(REC_ACTIVE.failed[0] as { id?: string })); // 退回 id 末段
    expect(warn, "原文只进 console").toHaveBeenCalled();
  });

  it("未知工作区（真实形态）：给得出原因，仍不透传原文", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = mod.batchFailureText("删除", REC_UNKNOWN_WS);
    expect(t).toContain("删除失败");
    expect(t).toContain("工作区");
    expect(t).not.toContain("unknown workspace");
  });

  it("多项失败：报数 + 列出前几个（id 末段）+ 成功条数", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failed = ["a-1", "b-2", "c-3", "d-4", "e-5"].map((n) => ({
      id: "ws/" + n,
      error: "unknown session 'ws/" + n + "'",
    }));
    const resp = { ok: true, deleted: 1, failed };
    const t = mod.batchFailureText("删除", resp);
    expect(t).toContain("删除失败 5 个");
    expect(t).toContain("a-1");
    expect(t).toContain("b-2");
    expect(t).toContain("c-3");
    expect(t).not.toContain("d-4"); // 超出上限只报数，别把提示行刷爆
    expect(t).toContain("等 5 个");
    expect(t).toContain("已成功 1 个");
    expect(mod.batchFailedIds(resp)).toEqual(["ws/a-1", "ws/b-2", "ws/c-3", "ws/d-4", "ws/e-5"]);
  });

  it("归档端点用 archived 计成功条数；id 缺失也不炸", () => {
    const t = mod.batchFailureText("归档", {
      ok: true,
      archived: 2,
      failed: [{ error: "unknown session 'x'" }],
    });
    expect(t).toContain("归档失败");
    expect(t).toContain("已成功 2 个");
    expect(mod.failedTail({})).toBe("(未知)");
    expect(mod.batchDoneCount({ ok: true })).toBeUndefined();
  });
});
