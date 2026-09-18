/**
 * W863 — 图像降级提示「叠加成很多块」的后端半边：同一会话同一 (model, cause)
 * 只上报一次。
 *
 * 根因（本文件就是它的可执行复现）：
 *   packages/llm/src/image-fallback.ts:132 的 onDowngrade 在**每一次带图请求**上
 *   触发；会话历史里的图片附件会保留，于是一个多步回合里每一步重发图片都会再被
 *   上游 400 → 再次 onDowngrade → 再次 reportImageDowngrade → 再次 bus.emit
 *   （apps/studio/src/runtime/real-runtime-adapter.ts:235）。N 步 = N 条 status 帧。
 *
 * 两层证据：
 *   ① 适配器级（真引擎 / 真总线）：带图 + 一次工具调用的回合，两步都带图 →
 *      修复前 2 条降级帧 + 2 行审计，修复后各 1；
 *   ② 单元级：去重签名的语义边界（换 model / 换 cause / 多会话 / 缺省 cause）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageUnsupportedError, type ImageDowngradeCause, type ImageDowngradeInfo } from "@celestea/llm";
import type { ModelRequest } from "@celestea/core";
import { jsonRequest, type StudioHarness } from "../harness.test-util.js";
import { asPayload, makeEngineHarness, waitIdle, type FrameRecord } from "./test-util.js";
import type { BusFrame, BusSubscription, StudioBus } from "../sse.js";
import { createImageDowngradeReporter } from "./image-downgrade.js";
import type { OfflineStep } from "./offline-llm.js";

/** 真 1x1 PNG（与 multimodal-turn.test.ts 同一枚，附件链路走真字节）。 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const TERMINAL_PHASES = ["completed", "cancelled", "error", "step_limit", "interrupted"];

const harnesses: StudioHarness[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const h of harnesses.splice(0)) h.cleanup();
});

/**
 * 收集帧直到**该回合自己的**终态帧。降级帧虽然 phase="error"，但 envelope.turn=0
 * （进程级提示，W805 设计 §7.6），不是回合终态 —— 若把它当终态，收集会在降级处
 * 提前收尾（本文件首版就是这么被它骗过一次）。
 */
async function collectTurn(sub: BusSubscription, frames: FrameRecord[], timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("turn frames did not terminate: " + frames.map((f) => f.event).join(","));
    const frame: BusFrame | null = await Promise.race([sub.next(), new Promise<null>((r) => setTimeout(() => r(null), left))]);
    if (frame === null) throw new Error("no frame before the deadline");
    frames.push({ event: frame.event, turn: frame.envelope.turn, seq: frame.envelope.seq, payload: asPayload(frame.envelope.payload) });
    const phase = String(frames[frames.length - 1]?.payload["phase"]);
    if (frame.event === "status" && frame.envelope.turn !== 0 && TERMINAL_PHASES.includes(phase)) return;
  }
}

export interface TurnObservation {
  frames: FrameRecord[];
  downgradeFrames: FrameRecord[];
  auditLines: string[];
  rejections: number;
}

/**
 * 跑一次「带图 + 一次工具调用」的回合。步 1 与步 2 的请求都带同一张图，
 * 上游对两者都以 image-unsupported 400 拒绝（rejections 应为 2）。
 */
async function runImageTurn(): Promise<TurnObservation> {
  const script: OfflineStep[] = [];
  const audit = vi.spyOn(console, "warn").mockImplementation(() => {});
  const state = { rejections: 0 };
  let h!: StudioHarness;
  h = makeEngineHarness({
    sessions: { att: [] },
    llm: {
      script,
      onRequest: (req: ModelRequest) => {
        if (!req.messages.some((m) => m.content.some((c) => c.type === "image"))) return;
        state.rejections += 1;
        throw new ImageUnsupportedError(400, "400 Bad Request", "multimodal input is not supported");
      },
    },
  });
  harnesses.push(h);
  script.push({ tool_calls: [{ id: "c1", name: "list_dir", args: { path: h.workspace } }] });
  await h.app.request("/api/sessions/sample-ws%2Fatt/activate", jsonRequest("POST"));
  const sub = h.studio.services.bus.subscribe();
  const frames: FrameRecord[] = [];
  const res = await h.app.request(
    "/api/turn",
    jsonRequest("POST", { input: "看这张图", attachments: [{ data: PNG.toString("base64"), name: "dot.png" }] }),
  );
  expect(res.status).toBe(202);
  await collectTurn(sub, frames);
  sub.close();
  await waitIdle(h);
  return {
    frames,
    downgradeFrames: frames.filter((f) => f.event === "status" && f.payload["reason"] === "IMAGE_UNSUPPORTED"),
    auditLines: audit.mock.calls.map((c) => String(c[0])).filter((line) => line.includes("image downgrade")),
    rejections: state.rejections,
  };
}

describe("W863 A: 同一回合的多次降级只上报一次", () => {
  it("两步都带图（上游两次 400）→ 降级帧与审计各一条", async () => {
    const observed = await runImageTurn();
    // 前提：装饰器确实两次撞上「图像不支持」——去重去掉的是第 2 条**上报**，
    // 不是第 2 次降级（占位重试照旧发生，回合照旧跑完）。
    expect(observed.rejections).toBe(2);
    expect(observed.downgradeFrames).toHaveLength(1);
    expect(observed.auditLines).toHaveLength(1);
    expect(observed.downgradeFrames[0]?.payload["cause"]).toBe("upstream_rejected");
    expect(observed.frames.some((f) => f.event === "status" && f.payload["phase"] === "completed")).toBe(true);
  });
});

interface RecFrame {
  event: string;
  turn: number;
  session: string | null;
  payload: Record<string, unknown>;
}

/** 记录型总线（只实现 reporter 用到的 emit 端口）。 */
function makeReporter(): { frames: RecFrame[]; lines: string[]; report: (sessionId: string | null, info: ImageDowngradeInfo) => boolean } {
  const frames: RecFrame[] = [];
  const lines: string[] = [];
  const bus = {
    emit: (event: string, turn: number, payload: Record<string, unknown>, session?: string | null): BusFrame => {
      frames.push({ event, turn, session: session ?? null, payload });
      return {} as BusFrame;
    },
  } as unknown as StudioBus;
  const reporter = createImageDowngradeReporter({ bus: () => bus, warn: (line) => lines.push(line) });
  return { frames, lines, report: (sessionId, info) => reporter.report(sessionId, info) };
}

function gradeInfo(model: string, cause?: ImageDowngradeCause): ImageDowngradeInfo {
  return {
    model,
    reason: "IMAGE_UNSUPPORTED",
    ...(cause === undefined ? {} : { cause }),
    httpStatus: 400,
    message: "upstream said no",
    placeholder: "p",
  };
}

describe("W863 A: 去重签名的语义边界", () => {
  it("同一会话同 (model, cause) 只上报一次；换 model / 换 cause 是新闻", () => {
    const { frames, lines, report } = makeReporter();
    expect(report("ws/a", gradeInfo("m1", "upstream_rejected"))).toBe(true);
    expect(report("ws/a", gradeInfo("m1", "upstream_rejected"))).toBe(false);
    expect(report("ws/a", gradeInfo("m1", "upstream_rejected"))).toBe(false);
    expect(frames).toHaveLength(1);
    expect(lines).toHaveLength(1); // 不 emit 就不打审计：日志与界面一致
    expect(report("ws/a", gradeInfo("m1", "timeout"))).toBe(true); // cause 变
    expect(report("ws/a", gradeInfo("m2", "timeout"))).toBe(true); // model 变
    expect(report("ws/a", gradeInfo("m2", "timeout"))).toBe(false);
    expect(frames).toHaveLength(3);
    expect(lines).toHaveLength(3);
    expect(frames.map((f) => f.payload["cause"])).toEqual(["upstream_rejected", "timeout", "timeout"]);
  });

  it("多会话各自独立；缺省 cause 归一到 upstream_rejected", () => {
    const { frames, lines, report } = makeReporter();
    expect(report("ws/a", gradeInfo("m1"))).toBe(true);
    expect(report("ws/b", gradeInfo("m1"))).toBe(true); // 另一个会话不被 a 的签名吞掉
    expect(report("ws/b", gradeInfo("m1", "upstream_rejected"))).toBe(false); // 缺省 cause = 同一签名
    expect(report(null, gradeInfo("m1"))).toBe(true); // detached 会话也是独立分区
    expect(report("ws/a", gradeInfo("m1"))).toBe(false);
    expect(frames.map((f) => f.session)).toEqual(["ws/a", "ws/b", null]);
    expect(frames.every((f) => f.event === "status" && f.turn === 0)).toBe(true);
    expect(lines).toHaveLength(3);
  });
});
