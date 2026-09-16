/**
 * W804 (multimodal P0 section 7.6): the host-visible report of ONE image
 * downgrade. Extracted from the runtime adapter so that file stays inside its
 * line budget.
 *
 * Three channels: a `status` frame (the statusline and the info block share it)
 * and an audit line on the process log. The turn itself is NOT failed.
 */

import type { ImageDowngradeInfo } from "@celestea/llm";
import type { StudioBus } from "../sse.js";

export function reportImageDowngrade(bus: StudioBus | null, sessionId: string | null, info: ImageDowngradeInfo): void {
  const message =
    `模型 "${info.model}" 拒绝了图像输入（上游 400），本轮已自动降级为「仅文本 + 图片占位」继续，图片内容未送达模型。`;
  const hint =
    '下一步：切换到支持图像输入的模型，或确认该模型 input_modalities 含 "image"；若确实不支持请设为 ["text"]。';
  bus?.emit("status", 0, {
    phase: "error",
    model: info.model,
    reason: info.reason,
    http_status: info.httpStatus,
    message,
    hint,
    placeholder: info.placeholder,
  }, sessionId);
  // Audit: the process log (the session log keeps its frozen event vocabulary).
  console.warn(`[W804] image downgrade session=${sessionId ?? "-"} model=${info.model} status=${String(info.httpStatus)}`);
}
