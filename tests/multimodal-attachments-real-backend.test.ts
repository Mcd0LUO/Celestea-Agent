/**
 * W805 · 多模态附件 P0 —— **对真实运行服务 + 真实前端 api 层**的端到端回归。
 *
 * 本文件不造假数据：唯一的 fetch 包装器只把相对路径补成绝对 URL 并转发给真服务
 * （缺省 127.0.0.1:3777，可用 CELESTEA_E2E_BASE 覆盖），**不构造任何响应**；发请求
 * 走的是生产前端模块 apps/web/src/api.ts（pathToFileURL 动态 import）。服务不可达
 * 时整体跳过（打印提示），绝不用桩数据冒充验收。覆盖：
 *   ① 真发一张小图（内联 base64）→ 202 接受 → GET messages 出现附件引用；
 *   ② 会话日志只存引用、不存 base64（同时校验附件字节确实落在 attachments/）；
 *   ③ 无视觉模型 deepseek-v4-flash-0731 → 捕获 IMAGE_UNSUPPORTED 状态帧，
 *      断言 placeholder / message / hint（可执行建议）齐备，不是静默失败。
 *
 * W855 · 确定性编排（只改测试，不改产品）：
 *   旧版两个用例共用一条**全局** /api/events，且第一个用例发完图不等自己的回合
 *   结束就放行；第二个用例于是可能读到别的会话/回合的帧，或在共享运行时/上游上撞到
 *   前一个在飞回合。现在：
 *     · 每个用例用 ?session=<id> **会话锚定**的 SSE，并按帧信封的 session 复核，
 *       别的会话（以及 session=null 的进程级帧）一律丢弃；
 *     · 每个用例先建好自己的流再发 turn，结束时等本会话的 turn_end（turn 锚定），
 *       并在 finally 里取消 + 等 busy=false 收敛，绝不把在飞回合漏给下一个用例；
 *     · 两个用例串行、各自等自己的回合收敛，不依赖共享全局流的“首个匹配”。
 *   断言一条不删、不放宽。
 *
 * 自建会话一律 w805- 前缀（celestea_harness 工作区），收尾连回收目录条目一并清理，
 * 并把被本套件 activate 过的共享 active_session 拨回进入时的值（失败即断言）。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { E2E_OPT_IN, reachable, requireOptIn } from "./lib/real-backend-gate.js";

const BASE = process.env["CELESTEA_E2E_BASE"] ?? "http://127.0.0.1:3777";
const WS = "celestea_harness";
const STAMP = String(Date.now()).slice(-7);
/** 真实 32x32 PNG（左上红圆 + 右下蓝方块）；sha256 = attachment_id。 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAh0lEQVR4nGP8//8/Ay0BE01NHxYWsOCSuCsqisxVfv2aPAuw+wDNdKwi5FuAyyzy7EC3AL8pZNiBYgEx+km1Y+gn02FmATG5idQch+4D/PrJyM9YggiXKeSVFtjjANMssssiRlpXODhLU/xAVPMufgWvrytDGMMsH4xaMGrBCLWA5mXR0A8iAL61JzklqscKAAAAAElFTkSuQmCC",
  "base64",
);
const SHA = createHash("sha256").update(PNG).digest("hex");

/** SSE 换行符（避免在生成源码里写反斜杠转义）。 */
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web");
const at = (rel: string): string => pathToFileURL(join(WEB, "src", rel)).href;

/** 真 HTTP 包装器：补 base + 记账，**不构造响应**。 */
const realFetch = globalThis.fetch;
const seen: string[] = [];
vi.stubGlobal("fetch", async (input: unknown, init?: Record<string, unknown>) => {
  const raw =
    typeof input === "string" ? input : String((input as { url?: string } | null)?.url ?? input);
  const abs = /^https?:/.test(raw) ? raw : BASE + raw;
  seen.push(abs.slice(BASE.length));
  return await realFetch(abs, init as RequestInit);
});

interface UserRow {
  role?: string;
  content?: string;
  attachments?: Array<Record<string, unknown>>;
}
interface ApiMod {
  health(): Promise<{ ok?: boolean }>;
  workspaces(): Promise<{ workspaces?: Array<{ name: string; path: string }> }>;
  sessions(opts?: { archived?: boolean }): Promise<{ sessions?: UserRow[]; active_session?: string | null }>;
  createSession(r: unknown): Promise<{ id?: string }>;
  activateSession(id: string): Promise<unknown>;
  messages(id: string): Promise<{ messages?: UserRow[] }>;
  status(session?: string): Promise<{ busy?: boolean; session?: string | null }>;
  cancel(session?: string): Promise<unknown>;
  turn(
    input: string,
    session?: string,
    mode?: "steer" | "queue",
    attachments?: Array<{ data: string; name?: string }>,
  ): Promise<{ turn?: number }>;
  batchDeleteSessions(ids: string[]): Promise<unknown>;
}
const apiMod = (await import(/* @vite-ignore */ at("api.ts"))) as unknown as { api: ApiMod };
const api = apiMod.api;

// W862（显式选入 · 真人事故）：默认门禁绝不碰在线服务 —— 未设 CELESTEA_E2E=1 时
// **不探测、不发任何 HTTP**，整文件以可见的 skip 结束并打印选入口令。门禁真源见
// tests/lib/real-backend-gate.ts；设了才真跑（服务不可达也不静默跳过）。
requireOptIn("W805");
const LIVE = await reachable(() => realFetch(BASE + "/api/health").then((r) => r.ok), "W805", BASE);

// 兜底门禁：只有显式选入才收集执行；未选入时整文件 VISIBLE skip（不是静默消失）。
const live = describe.skipIf(!E2E_OPT_IN);
const created: string[] = [];
let WS_PATH = "";
/** 进入本套件时的共享 active_session（收尾拨回；W792 同款纪律）。 */
let activeBefore = "";

async function createSession(model: string, title: string): Promise<string> {
  const r = await api.createSession({ workspace: WS, title: "w805-" + title + "-" + STAMP, model });
  const id = String(r.id ?? "");
  expect(id, "建会话失败：" + JSON.stringify(r)).not.toBe("");
  await api.activateSession(id);
  created.push(id);
  return id;
}

/** 轮询到「带附件的用户消息」出现（真实 turn 是异步的）。 */
async function waitAttachment(id: string, timeoutMs: number): Promise<UserRow | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = (await api.messages(id)).messages ?? [];
    const hit = rows.find((m) => m.role === "user" && Array.isArray(m.attachments));
    if (hit) return hit;
    if (Date.now() > deadline) return null;
    await new Promise((res) => setTimeout(res, 1000));
  }
}

/**
 * 轮询 GET /api/status?session=<id> 直到该会话的回合槽空闲 —— 「回合终态」的服务端
 * 权威观测（busy 由运行时注册表的 inFlight 位驱动）。
 */
async function waitSettled(id: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = await api.status(id);
    if (snap.busy !== true) return;
    if (Date.now() > deadline) throw new Error("会话回合未在 " + timeoutMs + "ms 内收敛：" + id);
    await new Promise((res) => setTimeout(res, 500));
  }
}

/** 用例收尾：取消自己的回合并等槽位真正释放（失败也不外抛，finally 用）。 */
async function settleAndCancel(id: string): Promise<void> {
  try {
    await api.cancel(id);
  } catch {
    /* 回合已结束 / 不可取消 */
  }
  try {
    await waitSettled(id, 30000);
  } catch {
    /* 尽力而为：取消后仍未收敛也不静默，交给用例断言 */
  }
}

/** GET /api/events 的一帧：事件名 + W513 信封（v/session/turn/seq/payload）。 */
interface SseFrame {
  event: string;
  session: string | null;
  turn: number;
  payload: Record<string, unknown>;
}

/** 单个 SSE 块（以空行分隔）→ 帧；非 data 块或坏 JSON 返回 null。 */
function parseFrame(block: string): SseFrame | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split(LF)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) {
      const raw = line.slice(5);
      data.push(raw.startsWith(" ") ? raw.slice(1) : raw);
    }
  }
  if (data.length === 0) return null;
  try {
    const env = JSON.parse(data.join(LF)) as {
      session?: string | null;
      turn?: number;
      payload?: unknown;
    };
    const payload =
      env.payload !== null && typeof env.payload === "object"
        ? (env.payload as Record<string, unknown>)
        : {};
    return { event, session: env.session ?? null, turn: env.turn ?? 0, payload };
  } catch {
    return null;
  }
}

/**
 * **会话锚定**的 SSE 读取器：服务端用 ?session=<id> 收窄，这里再按帧信封的 session
 * 复核，别的会话与进程级帧一律丢弃。先建流、后发 turn，因此不会漏帧。
 */
function openSessionStream(session: string): {
  frames: SseFrame[];
  waitFor(pred: (f: SseFrame) => boolean, timeoutMs: number): Promise<SseFrame | null>;
  close(): void;
} {
  const ctrl = new AbortController();
  const frames: SseFrame[] = [];
  interface Waiter {
    pred: (f: SseFrame) => boolean;
    resolve: (f: SseFrame | null) => void;
    timer: ReturnType<typeof setTimeout>;
  }
  const waiters: Waiter[] = [];
  let closed = false;

  /** 会话锚定 + 广播给等待者（从读循环里抽出，避免超深嵌套）。 */
  const deliver = (frame: SseFrame): void => {
    if (frame.session !== session) return;
    frames.push(frame);
    for (const w of [...waiters]) {
      if (!w.pred(frame)) continue;
      clearTimeout(w.timer);
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(frame);
    }
  };

  const pump = (async () => {
    try {
      const res = await realFetch(BASE + "/api/events?session=" + encodeURIComponent(session), {
        signal: ctrl.signal,
        headers: { accept: "text/event-stream" },
      });
      const reader = res.body?.getReader();
      if (!reader) throw new Error("SSE 无响应体");
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        buf = buf.split(CRLF).join(LF);
        for (;;) {
          const idx = buf.indexOf(LF + LF);
          if (idx < 0) break;
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const frame = parseFrame(block);
          if (frame) deliver(frame);
        }
      }
    } catch {
      /* aborted / stream closed */
    } finally {
      for (const w of waiters.splice(0)) {
        clearTimeout(w.timer);
        w.resolve(null);
      }
      closed = true;
    }
  })();

  return {
    frames,
    async waitFor(pred, timeoutMs) {
      const hit = frames.find(pred);
      if (hit) return hit;
      if (closed) return null;
      return await new Promise<SseFrame | null>((resolve) => {
        const timer = setTimeout(() => {
          const i = waiters.findIndex((w) => w.resolve === resolve);
          if (i >= 0) waiters.splice(i, 1);
          resolve(null);
        }, timeoutMs);
        waiters.push({ pred, resolve, timer });
      });
    },
    close() {
      ctrl.abort();
      void pump.catch(() => undefined);
    },
  };
}

live("W805 · 多模态附件对真实 3777 的端到端", () => {
  beforeAll(async () => {
    const list = (await api.workspaces()).workspaces ?? [];
    WS_PATH = list.find((w) => w.name === WS)?.path ?? "";
    try {
      activeBefore = String((await api.sessions()).active_session ?? "");
    } catch {
      activeBefore = "";
    }
  });

  /** 把共享 active 拨回进入时的值：重试 3 次；失败抛出，由 afterAll 统一上报。 */
  async function restoreActive(attempts = 3): Promise<void> {
    if (!LIVE || activeBefore === "") return;
    let last = "";
    for (let i = 1; i <= attempts; i += 1) {
      try {
        await api.activateSession(activeBefore);
        const restored = String((await api.sessions()).active_session ?? "");
        if (restored === activeBefore) {
          console.log("[W805] 活动会话已拨回：" + activeBefore);
          return;
        }
        last = "active=" + restored;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("active_session 拨回失败（重试 " + attempts + " 次）：want=" + activeBefore + " last=" + last);
  }

  /** 真删本套件建的临时会话，并复核缺省/归档两个列表都不再包含它们。 */
  async function deleteCreated(): Promise<void> {
    if (created.length === 0) return;
    await api.batchDeleteSessions(created);
    const afterDefault = ((await api.sessions()).sessions ?? []) as Array<{ id?: string }>;
    const afterArchived = ((await api.sessions({ archived: true })).sessions ?? []) as Array<{ id?: string }>;
    const alive = new Set([...afterDefault, ...afterArchived].map((r) => String(r.id ?? "")));
    const stuck = created.filter((id) => alive.has(id));
    if (stuck.length > 0) throw new Error("临时会话未删干净：" + stuck.join(", "));
  }

  /** 一步清理：失败记入 problems（不吞、不阻断后续步骤）。 */
  async function cleanupStep(problems: string[], label: string, work: () => Promise<void> | void): Promise<void> {
    try {
      await work();
    } catch (e) {
      problems.push(label + ": " + (e instanceof Error ? e.message : String(e)));
    }
  }

  function cleanTrash805(): void {
    if (!LIVE) return;
    const trash = join(WS_PATH, ".celestea-trash");
    if (!existsSync(trash)) return;
    for (const name of readdirSync(trash)) {
      if (/^w805-/.test(name)) rmSync(join(trash, name), { recursive: true, force: true });
    }
  }

  afterAll(async () => {
    const problems: string[] = [];
    await cleanupStep(problems, "restore active", () => restoreActive());
    await cleanupStep(problems, "delete temp sessions", () => (LIVE ? deleteCreated() : Promise.resolve()));
    await cleanupStep(problems, "clean w805 trash", () => cleanTrash805());
    vi.unstubAllGlobals();
    if (problems.length > 0) throw new Error("[W805] real-backend cleanup failed: " + problems.join(" | "));
  });

  it("真发小图（走前端 api.turn）：请求被接受、消息里出现附件、日志只存引用", { timeout: 360000 }, async () => {
    const id = await createSession("glm-5.3-flash", "vision");
    // 先建流、后发 turn：本会话自己的帧一帧不漏，且不会被别的会话污染。
    const stream = openSessionStream(id);
    try {
      const res = await api.turn("看这张图", id, undefined, [{ data: PNG.toString("base64"), name: "w805.png" }]);
      expect(res.turn).toBe(1);
      expect(seen).toContain("/api/turn"); // 确实是前端 api 层发的
      const row = await waitAttachment(id, 60000);
      expect(row, "消息里必须出现附件引用").not.toBeNull();
      expect(row?.content).toBe("看这张图");
      expect(row?.attachments?.[0]).toMatchObject({
        attachment_id: SHA,
        media_type: "image/png",
        width: 32,
        height: 32,
        name: "w805.png",
      });
      // 本用例的回合必须真正结束，绝不把在飞回合留给下一个用例（turn 锚定）。
      // W1: the real vision turn can take >120s when the whole suite runs beside it
      // (alone it is ~30s); give the SSE turn_end room without weakening the assertion.
      const end = await stream.waitFor((f) => f.event === "turn_end" && f.turn === res.turn, 240000);
      expect(end, "视觉回合必须自行结束（turn_end，会话 " + id + "）").not.toBeNull();
      await waitSettled(id, 30000);
      // 红线（机械断言）：会话日志里没有 base64 / data:，只有引用。
      const dir = join(WS_PATH, id.slice(id.indexOf("/") + 1));
      const log = readFileSync(join(dir, "cli-main.jsonl"), "utf8");
      expect(log).not.toContain("base64");
      expect(log).not.toContain("data:");
      expect(log).not.toContain(PNG.toString("base64"));
      expect(log).toContain(SHA);
      // 字节真的落在会话目录的 attachments/（内容寻址），且与上传逐字节一致。
      const bytes = readFileSync(join(dir, "attachments", SHA + ".png"));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(SHA);
    } finally {
      stream.close();
      await settleAndCancel(id);
    }
  });

  it("无视觉模型：降级为占位 + 可执行建议（IMAGE_UNSUPPORTED 状态帧）", { timeout: 240000 }, async () => {
    const id = await createSession("deepseek-v4-flash-0731", "downgrade");
    const stream = openSessionStream(id);
    try {
      const res = await api.turn("看这张图", id, undefined, [{ data: PNG.toString("base64"), name: "w805.png" }]);
      expect(res.turn).toBe(1);
      // 只认**本会话**的降级帧；本回合的终态也一并盯着：若回合以别的结果先结束，
      // 立刻带着真实终态失败，而不是空等到超时。
      const isDowngrade = (f: SseFrame): boolean =>
        f.event === "status" && f.payload["reason"] === "IMAGE_UNSUPPORTED";
      const terminal = await stream.waitFor(
        (f) => isDowngrade(f) || (f.event === "turn_end" && f.turn === res.turn),
        180000,
      );
      const payload = terminal !== null && isDowngrade(terminal) ? terminal.payload : null;
      const detail =
        terminal === null
          ? "180s 内既无降级帧也无本回合终态"
          : JSON.stringify({ event: terminal.event, turn: terminal.turn, payload: terminal.payload }).slice(0, 700);
      expect(
        payload,
        "必须收到 IMAGE_UNSUPPORTED 状态帧（会话 " + id + "，已收 " + stream.frames.length + " 帧；本回合终态：" + detail + "）",
      ).not.toBeNull();
      expect(payload?.["reason"]).toBe("IMAGE_UNSUPPORTED");
      // W855: this ONE frame now covers two upstream outcomes for this model.
      // The upstream may reject fast (upstream_rejected, sub-second) OR be slow
      // to reject and hit the client response-header timeout (timeout, ~60s).
      // Both MUST surface as IMAGE_UNSUPPORTED with an honest, cause-specific
      // message. Matching the message AGAINST the cause is stricter, not looser.
      const cause = String(payload?.["cause"] ?? "upstream_rejected");
      const message = String(payload?.["message"] ?? "");
      if (cause === "timeout") {
        expect(message, "timeout 降级文案必须如实说未在超时时间内响应图像输入").toContain("未在超时时间内响应图像输入");
      } else if (cause === "configured_text_only") {
        expect(message, "配置纯文本降级文案必须如实说已按配置声明为纯文本").toContain("已按配置声明为纯文本");
      } else {
        expect(cause).toBe("upstream_rejected");
        expect(message, "上游 400 降级文案必须说拒绝了图像输入").toContain("拒绝了图像输入");
      }
      expect(String(payload?.["hint"] ?? "")).toContain("input_modalities");
      expect(String(payload?.["placeholder"] ?? "")).toContain("图片已省略");
    } finally {
      stream.close();
      await settleAndCancel(id);
    }
  });
});
