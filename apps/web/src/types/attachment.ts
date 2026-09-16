// ============================================================================
// types/attachment.ts — W805 多模态附件线格式（P0，零新端点）。
//   入参：POST /api/turn 的 attachments[]（内联 base64，设计 §7.4）
//   出参：GET messages 的 attachments[]（只有引用，字节永不落日志）
//         与 read_image 的 tool_value.attachments
//   按先例从 types.ts 拆出（守模块体积棘轮）；types.ts 原样再导出。
// ============================================================================

/** 四种可接受的媒体类型（服务端按魔数嗅探，不认扩展名，见设计 §5.4）。 */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/**
 * 一条附件引用（ImageRef）：只有元数据与内容寻址 id，**没有字节**。
 * attachment_id = sha256(原始字节) 的十六进制；P0 不做规范化，客户端可用
 * WebCrypto 预先算出同一个 id（本会话内的历史缩略图靠它找回 objectURL）。
 */
export interface AttachmentRef {
  attachment_id: string;
  media_type: ImageMediaType;
  width: number;
  height: number;
  /** 原始上传文件名，只用于展示，不参与寻址。 */
  name?: string;
  /** 被下采样/改码时记录原始尺寸；P0 不写。 */
  original?: { width: number; height: number; bytes: number; media_type: string };
}

/** POST /api/turn 的一条内联附件：base64 是原始字节（不含 data: 前缀）。 */
export interface TurnAttachmentInput {
  data: string;
  name?: string;
}
