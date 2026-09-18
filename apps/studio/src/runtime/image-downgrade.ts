/**
 * W804 (multimodal P0 section 7.6): the host-visible report of ONE image
 * downgrade. Extracted from the runtime adapter so that file stays inside its
 * line budget.
 *
 * Three channels: a `status` frame (the statusline and the info block share it)
 * and an audit line on the process log. The turn itself is NOT failed.
 *
 * W863: the report is DEDUPLICATED per session. The decorator fires on EVERY
 * image-bearing request (`packages/llm/src/image-fallback.ts`), and a multi-step
 * turn re-sends the same history image at every step — so one turn used to emit
 * N identical frames and the UI stacked N identical blocks. The memo below
 * lives in a per-adapter reporter (never module state): one entry per session,
 * keyed by the (model, cause) signature that defines "this is NEWS".
 */

import type { ImageDowngradeCause, ImageDowngradeInfo } from "@celestea/llm";
import type { StudioBus } from "../sse.js";

/** W855: the user-facing message + executable hint of one downgrade cause. */
function copyOf(info: ImageDowngradeInfo, cause: ImageDowngradeCause): { message: string; hint: string } {
  if (cause === "timeout") {
    return {
      message:
        '模型 "' + info.model + '" 未在超时时间内响应图像输入，本轮已自动降级为「仅文本 + 图片占位」并重试；图片内容未送达模型（超时原文：' + info.message + '）。',
      hint:
        '下一步：切换到支持图像输入的模型，或确认该模型 input_modalities 含 "image"；若上游持续超时，请检查网络/网关后重试。',
    };
  }
  if (cause === "configured_text_only") {
    return {
      message:
        '模型 "' + info.model + '" 已按配置声明为纯文本（input_modalities 不含 "image"），本轮已自动降级为「仅文本 + 图片占位」，未向上游发送图像。',
      hint:
        '下一步：确认该模型 input_modalities 含 "image" 才能接收图片；否则请切换到支持图像输入的模型。',
    };
  }
  return {
    message:
      '模型 "' + info.model + '" 拒绝了图像输入（上游 ' + String(info.httpStatus ?? 400) + '），本轮已自动降级为「仅文本 + 图片占位」继续，图片内容未送达模型。',
    hint:
      '下一步：切换到支持图像输入的模型，或确认该模型 input_modalities 含 "image"；若确实不支持请设为 ["text"]。',
  };
}

/**
 * W863: the dedupe signature of one downgrade — exactly the (model, cause) pair
 * the requirement fixes. `cause` is normalized the same way `copyOf` does, so a
 * pre-W855 producer (cause absent) and an explicit `upstream_rejected` are the
 * SAME signature. Deliberately NOT keyed on httpStatus/message/placeholder: for
 * one (model, cause) the visible copy is identical in shape, and the verbatim
 * upstream body is not what the user acts on.
 */
export function downgradeSignature(info: ImageDowngradeInfo): string {
  return info.model + "\u0000" + (info.cause ?? "upstream_rejected");
}

/** One reporter per host adapter: the per-session memo + the two channels. */
export interface ImageDowngradeReporter {
  /** Returns true when this report was NEW (emitted + audited), false when deduped. */
  report(sessionId: string | null, info: ImageDowngradeInfo): boolean;
}

/**
 * W863 (§A): make the host report ONE downgrade per session per (model, cause).
 *   - every later frame with the same signature is swallowed ENTIRELY (no emit
 *     AND no audit line: the process log must never claim what the UI did not
 *     show);
 *   - a new model or a new cause is news again (the user must see that the
 *     situation changed);
 *   - `sessionId` is the partition key (`null` = the detached session), so two
 *     sessions never silence each other. State is per reporter instance and JS
 *     is single-threaded, so there is no cross-session race to guard.
 * Scope is the SESSION (not the turn): see the W863 report for the boundary.
 */
export function createImageDowngradeReporter(deps: {
  bus: () => StudioBus | null;
  /** Audit sink (defaults to console.warn); injected so tests can count lines. */
  warn?: (line: string) => void;
}): ImageDowngradeReporter {
  const lastBySession = new Map<string, string>();
  const warn = deps.warn ?? ((line: string): void => console.warn(line));
  return {
    report(sessionId: string | null, info: ImageDowngradeInfo): boolean {
      const key = sessionId ?? "";
      const signature = downgradeSignature(info);
      if (lastBySession.get(key) === signature) return false;
      lastBySession.set(key, signature);
      reportImageDowngrade(deps.bus(), sessionId, info, warn);
      return true;
    },
  };
}

export function reportImageDowngrade(
  bus: StudioBus | null,
  sessionId: string | null,
  info: ImageDowngradeInfo,
  warn: (line: string) => void = (line) => console.warn(line),
): void {
  // W855: an absent cause = a pre-W855 producer -> the historical 400 wording.
  const cause: ImageDowngradeCause = info.cause ?? "upstream_rejected";
  const { message, hint } = copyOf(info, cause);
  bus?.emit("status", 0, {
    phase: "error",
    model: info.model,
    reason: info.reason,
    cause,
    http_status: info.httpStatus,
    message,
    hint,
    placeholder: info.placeholder,
  }, sessionId);
  // Audit: the process log (the session log keeps its frozen event vocabulary).
  warn(
    "[W804/W855] image downgrade session=" + (sessionId ?? "-") +
      " model=" + info.model + " cause=" + cause + " status=" + String(info.httpStatus),
  );
}
