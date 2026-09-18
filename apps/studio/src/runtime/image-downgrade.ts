/**
 * W804 (multimodal P0 section 7.6): the host-visible report of ONE image
 * downgrade. Extracted from the runtime adapter so that file stays inside its
 * line budget.
 *
 * Three channels: a `status` frame (the statusline and the info block share it)
 * and an audit line on the process log. The turn itself is NOT failed.
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

export function reportImageDowngrade(bus: StudioBus | null, sessionId: string | null, info: ImageDowngradeInfo): void {
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
  console.warn(
    "[W804/W855] image downgrade session=" + (sessionId ?? "-") +
      " model=" + info.model + " cause=" + cause + " status=" + String(info.httpStatus),
  );
}
