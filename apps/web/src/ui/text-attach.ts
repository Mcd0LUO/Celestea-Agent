// ============================================================================
// ui/text-attach.ts — W869 文本文件附件（.md/.txt/… 走「前端读文本 + 发送时注入」）。
//   为什么文本不进 attachments/ 存储：后端附件全链是图片专用（put() 按魔数嗅探 +
//   读像素尺寸，ImageRef 只有 attachment_id/media_type/width/height），为文本新增
//   一种 content variant 要动 core 类型、会话日志编解码与线契约；而文本本来就能
//   作为消息文本被模型看到。取舍如实记录在 W869 报告：**文本内容进会话日志、计入
//   上下文长度**（图片只进引用）。
//   本模块零 DOM、零网络：判定 / 解码 / 拒绝原因 / 注入块拼接，外加文本项异步落定
//   后的重绘通知（图片摘要不改外观，不需要重绘）。
// ============================================================================
import { fmtBytes, type AttachmentView } from './attachment-view';
import type { PendingAttachment } from './attachments';

/** 文本文件字节上限（256 KiB）：文本会整段进上下文，一次发送不能任其膨胀。 */
export const MAX_TEXT_FILE_BYTES = 256 * 1024;

/** 常见文本扩展名（启发式：只决定「值不值得读」与 accept 清单；最终以 UTF-8 解码为准）。 */
export const TEXT_FILE_EXTS = [
  '.md', '.markdown', '.mdx', '.txt', '.text', '.json', '.jsonl', '.yaml', '.yml',
  '.csv', '.tsv', '.log', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py',
  '.rb', '.go', '.rs', '.java', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php',
  '.sh', '.bash', '.zsh', '.sql', '.html', '.htm', '.css', '.scss', '.less', '.xml',
  '.toml', '.ini', '.cfg', '.conf', '.env', '.diff', '.patch', '.tex', '.rst',
];

/** file input 的可选文本项（既有图片项由 ui/attachments.ts 原样保留在前面）。 */
export const TEXT_ACCEPT = 'text/markdown,text/plain,' + TEXT_FILE_EXTS.join(',');

/** 文本候选（启发式）：MIME 以 text/ 开头（含 text/markdown、text/plain）或扩展名在清单内。 */
export function looksTextFile(file: { name: string; type: string }): boolean {
  if (file.type !== '' && file.type.indexOf('text/') === 0) return true;
  const name = file.name.toLowerCase();
  return TEXT_FILE_EXTS.some((e) => name.endsWith(e));
}

/** 三入口的快速判定：值不值得进待发区（图片，或文本候选；未知扩展名照收，由内容定夺）。 */
export function isAttachmentCandidate(file: { name: string; type: string }): boolean {
  return file.type.indexOf('image/') === 0 || looksTextFile(file);
}

/** 文本项的同步拒绝原因（'' = 过初筛；内容判定在读完之后异步做，见 settleTextItem）。 */
export function textRejectReason(file: { name: string; type: string; size: number }): string {
  if (file.size > MAX_TEXT_FILE_BYTES) {
    return looksTextFile(file)
      ? '文本文件不超过 ' + fmtBytes(MAX_TEXT_FILE_BYTES) + '（当前 ' + fmtBytes(file.size) + '）'
      : '仅支持图片与文本文件（.md / .txt / .json 等），单个文本不超过 ' + fmtBytes(MAX_TEXT_FILE_BYTES);
  }
  if (file.size === 0) return '空文件没有内容可发送';
  return '';
}

/** 新建一条文本待发项：url 留空（文本没有缩略图，也不占预览 URL 名额）。 */
export function textPendingItem(file: File, error: string): PendingAttachment {
  return { file, name: file.name || '文本文件', url: '', bytes: file.size, id: '', error, kind: 'text' };
}

/** 文本里允许出现的控制字符：制表 / 换行 / 回车 / 换页 / ESC（ANSI 着色的日志不误伤）。 */
function allowedControl(b: number): boolean {
  return b === 9 || b === 10 || b === 13 || b === 12 || b === 27;
}

/**
 * 读成文本：**含 NUL 或其它 C0 控制字符**、或解不出 UTF-8 → 一律按二进制处理
 * （返回 null；不猜编码、不做替换解码）。.zip/.png 等伪装成 .txt 的文件在此被识破。
 */
export async function readTextFile(file: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<string | null> {
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    for (const b of buf) if (b < 32 && !allowedControl(b)) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/** 文本项异步落定：读出正文；读不出就地标红（入口据此重绘成红项 + 可见提示）。 */
export async function settleTextItem(item: PendingAttachment): Promise<void> {
  const text = await readTextFile(item.file);
  if (text === null) item.error = '不是可读的 UTF-8 文本（二进制文件不支持）';
  else item.text = text;
}

let settledHook: (() => void) | null = null;

/** 注册落定回调（入口据此刷新待发条与标红提示）；重复注册覆盖前者。 */
export function onTextSettled(cb: () => void): void {
  settledHook = cb;
}

/** 文本项落定后通知入口重绘（图片走摘要，不改外观，无需重绘）。 */
export function notifyTextSettled(): void {
  if (settledHook) settledHook();
}

/**
 * W869：文本附件的发送前落定 —— 还没读出正文的项在这里**同步读完**（按下去重键去重，
 * 图片的重复项各发各的，语义不变）。绝不静默丢弃：读不出的项把 error 写在原地，
 * 由调用方走既有的「读失败 → 中止发送 + 可见提示」路径。
 */
export async function settleTextItems(items: readonly PendingAttachment[]): Promise<void> {
  const seen = new Set<PendingAttachment>();
  for (const it of items) {
    if (it.kind !== 'text' || it.text !== undefined || seen.has(it)) continue;
    seen.add(it);
    await settleTextItem(it);
  }
}

/** W869：把文本附件拼进消息文本；无文本项时**原样返回**（保证既有发送零变化）。 */
export function withTextAttachments(text: string, items: readonly PendingAttachment[]): string {
  return injectTextAttachments(text, items);
}

/** 文本项的展示视图（气泡里只给文件名 chip + 大小，全文只进发给模型的内容）。 */
export function textViewOf(item: PendingAttachment): AttachmentView | null {
  if (item.kind !== 'text') return null;
  return { name: item.name, url: item.url, bytes: item.bytes, kind: 'text' };
}

/** 注入块的定界行：全仓唯一字面量（ASCII，无引号/反引号），普通正文不会自然出现。 */
export const TEXT_BLOCK_DELIMITER = '===== W869 附件 =====';

/** 正文里与定界行同形的行加后缀 —— 定界行因此只可能出自发送端（正文无法伪造边界）。 */
function escapeDelimiterLines(text: string): string {
  return text
    .split('\n')
    .map((l) => (l.indexOf(TEXT_BLOCK_DELIMITER) >= 0 ? l + ' [此行由发送端转义]' : l))
    .join('\n');
}

/**
 * 把文本附件拼成**清晰可辨**的文本块，附在本条用户消息的文本之后：
 * 每条 = 一行「[文件 <名>（<类型>，<字节> 字节）]」+ 正文 + 上下各一行定界。
 * 图片附件数组不受影响（仍走 POST /api/turn 的 attachments）。
 */
export function injectTextAttachments(text: string, items: readonly PendingAttachment[]): string {
  const blocks: string[] = [];
  for (const it of items) {
    if (it.kind !== 'text' || it.text === undefined) continue;
    const mime = it.file.type !== '' ? it.file.type : '未知类型';
    const head = '[文件 ' + it.name + '（' + mime + '，' + it.bytes + ' 字节）]';
    blocks.push(TEXT_BLOCK_DELIMITER + '\n' + head + '\n' + escapeDelimiterLines(it.text) + '\n' + TEXT_BLOCK_DELIMITER);
  }
  if (blocks.length === 0) return text;
  return (text.trim() === '' ? '' : text + '\n\n') + blocks.join('\n\n');
}
