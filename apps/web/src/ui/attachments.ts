// ============================================================================
// ui/attachments.ts — W805 多模态附件前端半边（P0，零新端点）：
//   三入口 / 按会话隔离的待发状态 / 能力位 / 历史只渲染元数据（§7.4）；渲染零件见 ./attachment-view。
// ============================================================================
import { api } from '../api';
import { t } from '../i18n';
import { activePane, onPaneChange } from './viewctx';
import { fmtBytes, type AttachmentView } from './attachment-view';
import type { AttachmentRef, ImageMediaType, TurnAttachmentInput } from '../types/attachment';
import { TEXT_ACCEPT, notifyTextSettled, settleTextItem, textPendingItem, textRejectReason } from './text-attach';

export { renderAttachmentGrid, renderTray } from './attachment-view';
export type { AttachmentView } from './attachment-view';
// W869：文本附件的公开面（判定 / 上限 / 注入 / 落定通知）从本模块统一再导出，
// 入口（inputbar）与发送编排（send）只需认这一处。
export { MAX_TEXT_FILE_BYTES, TEXT_BLOCK_DELIMITER, isAttachmentCandidate, onTextSettled } from './text-attach';

/** P0 自限（设计 §5.3；前端先拦必然失败的请求）。 */
export const MAX_ATTACHMENTS = 20;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** W805 的四个图片项**原样保留**，W869 只在其后追加常见文本（选择框提示；判定仍逐文件走）。 */
export const ATTACHMENT_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,' + TEXT_ACCEPT;
const MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const DOWNGRADE_REASON = 'IMAGE_UNSUPPORTED';

/** 一条待发附件（含本地预览 URL；error 非空 = 选择时就被拒绝，不会发出）。 */
export interface PendingAttachment {
  file: File;
  name: string;
  url: string;
  bytes: number;
  /** sha256(原始字节) 的十六进制；P0 不做规范化，故与 attachment_id 一致。 */
  id: string;
  error: string;
  /**
   * W869：'text' = 文本文件项（发送时读成正文、注入消息文本，不进 attachments 数组）；
   * 缺省 'image' = 既有图片项（逐字节语义不变）。
   */
  kind?: 'image' | 'text';
  /** 文本项读出的 UTF-8 正文（异步落定；undefined = 尚未读完或读取失败）。 */
  text?: string;
}

// ---- 能力位（部署级 + 逐模型） --------------------------------------------------

let deployMultimodal = false;
let configModel = '';
let allModels: string[] = [];
const modalities = new Map<string, string[]>();
let capsLoaded = false;
let inflight: Promise<void> | null = null;

/** R3 W838-F4：配置/模型已变 → 作废缓存，让下一次 loadAttachmentCapabilities 真重拉。 */
export function invalidateAttachmentCapabilities(): void {
  capsLoaded = false;
  inflight = null;
}

/** 拉一次能力位（health / config / providers）；失败一律按「不可用 + 乐观放行」降级。 */
export function loadAttachmentCapabilities(): Promise<void> {
  if (capsLoaded) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const h = await api.health();
      deployMultimodal = h.capabilities?.multimodal === true;
    } catch {
      deployMultimodal = false;
    }
    try {
      const c = await api.config();
      configModel = c.model ?? '';
    } catch {
      /* 旧服务：当前模型未知 */
    }
    try {
      const p = await api.providers();
      const ids: string[] = [];
      // W862：同一个 id 会在多个 provider 下重复出现（Celestea 网关 / 基元各一条
      // deepseek-flash），降级提示的「可切换到」清单因此出现过重复项。清单按 id
      // **去重并保留首次出现顺序**；能力位写入仍发生在每一次出现上，后出现的同 id
      // provider 照旧覆盖 modalities（既有语义不变，不引入能力位回退）。
      const seen = new Set<string>();
      for (const prov of p.providers ?? []) {
        for (const m of prov.models ?? []) {
          if (!seen.has(m.id)) {
            seen.add(m.id);
            ids.push(m.id);
          }
          if (m.input_modalities) modalities.set(m.id, m.input_modalities);
        }
      }
      allModels = ids;
    } catch {
      /* 旧服务：清单缺失 → 全乐观 */
    }
    capsLoaded = true;
  })();
  return inflight;
}

export function attachmentsEnabled(): boolean {
  return deployMultimodal;
}

/** 当前模型：优先会话级覆盖，其次全局配置。 */
export function currentModel(): string {
  const m = activePane()?.model;
  return typeof m === 'string' && m !== '' ? m : configModel;
}

/** 逐模型能力位：缺省 = 乐观支持；只有显式配置的列表才参与判定。 */
export function modelAllowsImages(model: string): boolean {
  if (model === '') return true;
  const list = modalities.get(model);
  return list === undefined ? true : list.includes('image');
}

/** 入口被禁用的可执行原因（'' = 可用）。 */
export function imageEntryDisabledReason(): string {
  if (!deployMultimodal) return t('chat.attach.imageEntryDisabled');
  const model = currentModel();
  if (model !== '' && !modelAllowsImages(model)) {
    return t('chat.attach.modelNoImages', { model });
  }
  return '';
}

/** 可作为降级建议的模型清单（未显式排除图像的前几个）。 */
export function imageCapableModels(): string[] {
  return allModels.filter((id) => modelAllowsImages(id)).slice(0, 6);
}

// ---- 上游「图像不支持」降级提示（设计 §7.6） ------------------------------------

export function isImageDowngrade(p: { reason?: unknown; message?: unknown }): boolean {
  if (p.reason === DOWNGRADE_REASON) return true;
  // 匹配**服务端原文**的防御性回退（旧服务），不是 UI 文案：
  return typeof p.message === 'string' && p.message.indexOf('拒绝了图像输入') >= 0; // copy-gate-allow
}

/** 信息块文案：服务端定稿 message + hint，再补一条可切换模型清单。 */
export function downgradeNotice(p: { message?: unknown; hint?: unknown; model?: unknown }): string {
  const msg = typeof p.message === 'string' && p.message !== '' ? p.message : t('chat.attach.downgradeDefault');
  const hint = typeof p.hint === 'string' ? p.hint : '';
  // D2：排除本次肇事模型 —— 能力位是乐观默认，刚被上游 400 拒绝的模型本会出现在清单里。
  const debris = typeof p.model === 'string' ? p.model : '';
  const models = imageCapableModels().filter((id) => id !== debris);
  const suggest = models.length > 0 ? t('chat.attach.suggestSwitch', { models: models.join(t('chat.question.answerSep')) }) : '';
  return [msg, hint, suggest].filter((s) => s !== '').join('\n');
}

// ---- 待发状态（按会话隔离） ----------------------------------------------------

const drafts = new Map<string, PendingAttachment[]>();
/** 本会话内 attachment_id → objectURL（刷新后丢失 = P0 已知限制）。 */
interface PreviewEntry {
  url: string;
  /** 登记时的会话：切走该会话即回收（R3 W838-F1）。 */
  session: string;
}
const previews = new Map<string, PreviewEntry>();
/** 预览 URL 的硬上限：超出即回收最旧的一条，长会话不再只增不减（R3 W838-F1）。 */
const MAX_PREVIEWS = 64;

function sessionKey(): string {
  return activePane()?.id ?? '';
}

function revokeUrl(url: string): void {
  try {
    if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
  } catch {
    /* 旧环境没有 revokeObjectURL：忽略 */
  }
}

function releasePreview(id: string): void {
  const e = previews.get(id);
  if (!e) return;
  previews.delete(id);
  revokeUrl(e.url);
}

/** 仅当登记的 URL 就是这一条待发项的 URL 时才回收（同 id 不同 URL 的边界）。 */
function releasePreviewIf(id: string, url: string): void {
  const e = previews.get(id);
  if (e && e.url === url) releasePreview(id);
}

function rememberPreview(id: string, url: string, session: string): void {
  if (id === '' || url === '') return;
  previews.delete(id); // 重新插入：刷新回收顺序
  previews.set(id, { url, session });
  while (previews.size > MAX_PREVIEWS) {
    const oldest = previews.keys().next().value;
    if (oldest === undefined) break;
    releasePreview(oldest);
  }
}

/** 切走某会话 → 回收它的全部预览 URL（R3 W838-F1）。 */
function releasePreviewsOf(session: string): void {
  for (const [id, e] of Array.from(previews)) if (e.session === session) releasePreview(id);
}

// 会话切换即回收上一会话的预览（不用等 GC，也不把 blob 留在长会话里）。
onPaneChange((pane, prev) => {
  if (prev && prev.id !== pane.id) releasePreviewsOf(prev.id);
});

function objectUrl(file: File): string {
  try {
    return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : '';
  } catch {
    return '';
  }
}

function looksImage(file: File): boolean {
  if (MEDIA_TYPES.indexOf(file.type) >= 0) return true;
  if (file.type === '' || file.type.indexOf('image/') === 0) return IMAGE_EXT.test(file.name);
  return false;
}

function rejectReason(file: File, validCount: number, batch: number): string {
  if (validCount + batch > MAX_ATTACHMENTS) return t('chat.attach.maxCount', { n: MAX_ATTACHMENTS });
  if (!looksImage(file)) return textRejectReason(file);
  if (file.size > MAX_ATTACHMENT_BYTES) return t('chat.attach.maxBytes', { size: fmtBytes(MAX_ATTACHMENT_BYTES) });
  return '';
}

async function attachId(item: PendingAttachment, session: string): Promise<void> {
  try {
    const subtle = globalThis.crypto ? globalThis.crypto.subtle : undefined;
    if (!subtle) return;
    const digest = await subtle.digest('SHA-256', await item.file.arrayBuffer());
    item.id = hex(new Uint8Array(digest));
    // 登记本会话预览：历史恢复（同一次会话内）据此显示缩略图而非仅元数据。
    rememberPreview(item.id, item.url, session);
  } catch {
    /* id 缺失只影响本会话历史缩略图，不影响发送 */
  }
}

/**
 * 三入口公共落点：先校验、再**当帧**入列（异步摘要 / 文本读取都不阻塞渲染）。返回被拒条数。
 * W869：图片走既有校验、文本走新校验，**同一批上限共用**；
 *   图片项、图片项的 url/id 与异步摘要路径逐字节不变；
 *   文本项 url 留空、正文读到之前 text 为 undefined（发送前若仍读不出即中止发送）。
 */
export function addFiles(files: ArrayLike<File>): number {
  const key = sessionKey();
  const list = drafts.get(key) ?? [];
  let accepted = list.filter((p) => p.error === '').length;
  const batch = files.length;
  let rejected = 0;
  for (let i = 0; i < batch; i++) {
    const file = files[i];
    if (!file) continue;
    // R3 W838-F8：按**已接受数**逐条递推，超上限的溢出项才拒（不再整批全拒）。
    const error = rejectReason(file, accepted, 1);
    if (error !== '') rejected += 1;
    else accepted += 1;
    const text = error === '' && !looksImage(file);
    const item = text
      ? textPendingItem(file, error)
      : { file, name: file.name || t('chat.attach.imageName'), url: objectUrl(file), bytes: file.size, id: '', error };
    list.push(item);
    if (text) {
      if (error === '') void settleTextItem(item).then(notifyTextSettled);
    } else {
      void attachId(item, key);
    }
  }
  drafts.set(key, list);
  return rejected;
}

export function pendingList(): PendingAttachment[] {
  return (drafts.get(sessionKey()) ?? []).slice();
}

/** 可发送条数（被拒的红色项不计）。 */
export function pendingCount(): number {
  return (drafts.get(sessionKey()) ?? []).filter((p) => p.error === '').length;
}

export function removePending(item: PendingAttachment): void {
  const key = sessionKey();
  const list = drafts.get(key) ?? [];
  const i = list.indexOf(item);
  if (i >= 0) {
    list.splice(i, 1);
    revokeUrl(item.url); // R3 W838-F1：移除即吊销，不等 GC
    releasePreviewIf(item.id, item.url);
  }
  drafts.set(key, list);
}

/** 发送时取走本会话全部待发项（被拒项一并清掉），并登记本会话内预览。 */
export function takePending(key: string = sessionKey()): PendingAttachment[] {
  const list = drafts.get(key) ?? [];
  const sendable = list.filter((p) => p.error === '');
  drafts.set(key, []);
  for (const p of sendable) rememberPreview(p.id, p.url, key);
  return sendable;
}

/** 发送失败：把附件放回待发区（不丢文件，可直接重试）。 */
export function restorePending(key: string, items: readonly PendingAttachment[]): void {
  drafts.set(key, items.concat(drafts.get(key) ?? []));
}

export function clearPending(): void {
  const key = sessionKey();
  for (const p of drafts.get(key) ?? []) {
    revokeUrl(p.url); // R3 W838-F1：清空即吊销
    releasePreviewIf(p.id, p.url);
  }
  drafts.set(key, []);
  releasePreviewsOf(key);
}

/**
 * W869：只清图片项（旧服务未声明多模态时的入口回收）—— 文本文件不需要多模态能力位，
 * 不再跟着被清掉。返回值 = 被清掉的项数（0 = 本次没有图片可清）。
 */
export function clearPendingImages(): number {
  const key = sessionKey();
  const list = drafts.get(key) ?? [];
  const kept: PendingAttachment[] = [];
  let dropped = 0;
  for (const p of list) {
    if (p.kind === 'text') {
      kept.push(p);
      continue;
    }
    dropped += 1;
    revokeUrl(p.url);
    releasePreviewIf(p.id, p.url);
  }
  drafts.set(key, kept);
  return dropped;
}

/** R3 W838-F2：有附件根本没读出来 —— 抛错中止发送，绝不发一个缺内容的请求。 */
export class AttachmentReadError extends Error {
  readonly names: readonly string[];
  constructor(names: readonly string[]) {
    super(t('chat.attach.readFailed', { names: names.join(t('chat.question.answerSep')) || t('chat.attach.unknownFile') }));
    this.name = 'AttachmentReadError';
    this.names = names;
  }
}

/**
 * 待发 → 连线格式（内联 base64；与 POST /api/turn 的 attachments 同形）。
 * W869：**只收图片项**（kind 缺省即图片）；文本项不进 attachments 数组，
 * 其正文由 injectTextAttachments 注入消息文本 —— 图片路径因此逐字节不变。
 * 文本项若到发送时仍没有正文（读取失败），与读图失败同一条路径中止发送。
 */
export async function toWire(items: readonly PendingAttachment[]): Promise<TurnAttachmentInput[]> {
  const out: TurnAttachmentInput[] = [];
  const failed: string[] = [];
  for (const item of items) {
    if (item.kind === 'text') {
      if (item.text === undefined) failed.push(item.name);
      continue;
    }
    const data = await readBase64(item.file);
    if (data === '') failed.push(item.name);
    else out.push({ data, name: item.name });
  }
  if (failed.length > 0) throw new AttachmentReadError(failed);
  return out;
}


function readBase64(file: File): Promise<string> {
  return new Promise((resolve) => {
    try {
      const r = new FileReader();
      r.onload = () => {
        const s = typeof r.result === 'string' ? r.result : '';
        const i = s.indexOf(',');
        resolve(i >= 0 ? s.slice(i + 1) : '');
      };
      r.onerror = () => resolve('');
      r.readAsDataURL(file);
    } catch {
      resolve('');
    }
  });
}

export function pendingViews(items: readonly PendingAttachment[]): AttachmentView[] {
  return items.map((it) => ({ name: it.name, url: it.url, bytes: it.bytes, kind: it.kind }));
}

// ---- 引用 ↔ 视图 ---------------------------------------------------------------

export function attachmentViewsOf(refs: readonly AttachmentRef[] | undefined): AttachmentView[] {
  if (!refs) return [];
  return refs.map((ref) => ({ ref, name: ref.name, url: previews.get(ref.attachment_id)?.url }));
}

/** 工具结果 value 里的 attachments（read_image 的图片通道，设计 §6.3）。 */
export function refsOfValue(value: unknown): AttachmentRef[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const raw = (value as Record<string, unknown>)['attachments'];
  if (!Array.isArray(raw)) return [];
  const out: AttachmentRef[] = [];
  for (const v of raw) {
    const ref = asRef(v);
    if (ref) out.push(ref);
  }
  return out;
}

function asRef(v: unknown): AttachmentRef | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const id = r['attachment_id'];
  const media = r['media_type'];
  const w = r['width'];
  const h = r['height'];
  if (typeof id !== 'string' || typeof media !== 'string') return null;
  if (MEDIA_TYPES.indexOf(media) < 0) return null;
  if (typeof w !== 'number' || typeof h !== 'number') return null;
  const out: AttachmentRef = { attachment_id: id, media_type: media as ImageMediaType, width: w, height: h };
  if (typeof r['name'] === 'string') out.name = r['name'];
  return out;
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += (b < 16 ? '0' : '') + b.toString(16);
  return s;
}
