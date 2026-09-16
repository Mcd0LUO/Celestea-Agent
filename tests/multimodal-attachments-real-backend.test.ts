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
 * 自建会话一律 w805- 前缀（celestea_harness 工作区），收尾连回收目录条目一并清理。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const BASE = process.env["CELESTEA_E2E_BASE"] ?? "http://127.0.0.1:3777";
const WS = "celestea_harness";
const STAMP = String(Date.now()).slice(-7);
/** 真实 32x32 PNG（左上红圆 + 右下蓝方块）；sha256 = attachment_id。 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAh0lEQVR4nGP8//8/Ay0BE01NHxYWsOCSuCsqisxVfv2aPAuw+wDNdKwi5FuAyyzy7EC3AL8pZNiBYgEx+km1Y+gn02FmATG5idQch+4D/PrJyM9YggiXKeSVFtjjANMssssiRlpXODhLU/xAVPMufgWvrytDGMMsH4xaMGrBCLWA5mXR0A8iAL61JzklqscKAAAAAElFTkSuQmCC",
  "base64",
);
const SHA = createHash("sha256").update(PNG).digest("hex");

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
  createSession(r: unknown): Promise<{ id?: string }>;
  activateSession(id: string): Promise<unknown>;
  messages(id: string): Promise<{ messages?: UserRow[] }>;
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

let LIVE = false;
try {
  LIVE = (await realFetch(BASE + "/api/health")).ok;
} catch {
  LIVE = false;
}
// W839 (R3 B9 / W818-P2-5): LIVE=required (or CELESTEA_E2E_REQUIRED=1) turns an
// unreachable real service into a hard failure; locally it stays a VISIBLE skip
// (this banner + vitest's skipped count).
const LIVE_REQUIRED = process.env["LIVE"] === "required" || process.env["CELESTEA_E2E_REQUIRED"] === "1";
if (!LIVE) {
  const banner = "[W805] 真实服务不可达，端到端用例整体 SKIPPED（不是通过）：" + BASE;
  if (LIVE_REQUIRED) throw new Error(banner);
  console.warn(banner);
}

const live = LIVE ? describe : describe.skip;
const created: string[] = [];
let WS_PATH = "";

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

/** 边发 turn 边读 SSE，直到出现 IMAGE_UNSUPPORTED 或超时；返回原始帧文本。 */
async function watchSse(action: () => Promise<unknown>, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController();
  const res = await realFetch(BASE + "/api/events", { signal: ctrl.signal, headers: { accept: "text/event-stream" } });
  const reader = res.body?.getReader();
  if (!reader) return "";
  const dec = new TextDecoder();
  let buf = "";
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  await action();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      if (buf.includes("IMAGE_UNSUPPORTED")) break;
    }
  } catch {
    /* aborted / stream closed */
  }
  clearTimeout(timer);
  ctrl.abort();
  return buf;
}

function parseDowngrade(buf: string): Record<string, unknown> | null {
  for (const line of buf.split(String.fromCharCode(10))) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    try {
      const payload = JSON.parse(t.slice(5).trim()) as { payload?: Record<string, unknown> };
      if (payload.payload && payload.payload["reason"] === "IMAGE_UNSUPPORTED") return payload.payload;
    } catch {
      /* 非 JSON 行（事件名等）：跳过 */
    }
  }
  return null;
}

live("W805 · 多模态附件对真实 3777 的端到端", () => {
  beforeAll(async () => {
    const list = (await api.workspaces()).workspaces ?? [];
    WS_PATH = list.find((w) => w.name === WS)?.path ?? "";
  });

  afterAll(async () => {
    try {
      if (created.length > 0) await api.batchDeleteSessions(created);
    } catch {
      /* 清理尽力而为 */
    }
    vi.unstubAllGlobals();
    const trash = join(WS_PATH, ".celestea-trash");
    if (!existsSync(trash)) return;
    for (const name of readdirSync(trash)) {
      if (/^w805-/.test(name)) rmSync(join(trash, name), { recursive: true, force: true });
    }
  });

  it("真发小图（走前端 api.turn）：请求被接受、消息里出现附件、日志只存引用", { timeout: 90000 }, async () => {
    const id = await createSession("glm-5.3-flash", "vision");
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
  });

  it("无视觉模型：降级为占位 + 可执行建议（IMAGE_UNSUPPORTED 状态帧）", { timeout: 90000 }, async () => {
    const id = await createSession("deepseek-v4-flash-0731", "downgrade");
    const buf = await watchSse(
      () => api.turn("看这张图", id, undefined, [{ data: PNG.toString("base64"), name: "w805.png" }]),
      60000,
    );
    const payload = parseDowngrade(buf);
    expect(payload, "必须收到 IMAGE_UNSUPPORTED 状态帧（SSE 长度 " + buf.length + "）").not.toBeNull();
    expect(payload?.["reason"]).toBe("IMAGE_UNSUPPORTED");
    expect(String(payload?.["message"] ?? "")).toContain("拒绝了图像输入");
    expect(String(payload?.["hint"] ?? "")).toContain("input_modalities");
    expect(String(payload?.["placeholder"] ?? "")).toContain("图片已省略");
  });
});
