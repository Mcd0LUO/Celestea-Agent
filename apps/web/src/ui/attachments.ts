// ============================================================================
// ui/attachments.ts — W805 多模态附件前端半边（P0，零新端点）：
//   三入口落点 / 按会话隔离的待发状态 / 能力位（部署级 + 逐模型乐观默认）/
//   历史只渲染元数据（设计 §7.4）。乐观发送与回滚的编排在 ui/send.ts。
//   渲染零件（气泡网格 / 待发条 / 放大浮层）见 ./attachment-view。
// ============================================================================
import { api } from '../api';
import { activePane, onPaneChange } from './viewctx';
import { fmtBytes, type AttachmentView } from './attachment-view';
import type { AttachmentRef, ImageMediaType, TurnAttachmentInput } from '../types/attachment';

export { renderAttachmentGrid, renderTray } from './attachment-view';
export type { AttachmentView } from './attachment-view';

/** P0 自限（设计 §5.3；前端先拦必然失败的请求）。 */
export const MAX_ATTACHMENTS = 20;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
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
  if (!deployMultimodal) return '当前服务未启用图片附件';
  const model = currentModel();
  if (model !== '' && !modelAllowsImages(model)) {
    return '当前模型 "' + model + '" 的输入能力不含图像，图片入口已禁用；可在模型设置里加入 "image"，或切换到支持图像的模型。';
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
  return typeof p.message === 'string' && p.message.indexOf('拒绝了图像输入') >= 0;
}

/** 信息块文案：服务端定稿 message + hint，再补一条可切换模型清单。 */
export function downgradeNotice(p: { message?: unknown; hint?: unknown; model?: unknown }): string {
  const msg = typeof p.message === 'string' && p.message !== '' ? p.message : '模型拒绝了图像输入，本轮已自动降级为仅文本继续，图片未送达模型。';
  const hint = typeof p.hint === 'string' ? p.hint : '';
  // D2：排除本次肇事模型 —— 能力位是乐观默认，刚被上游 400 拒绝的模型本会出现在清单里。
  const debris = typeof p.model === 'string' ? p.model : '';
  const models = imageCapableModels().filter((id) => id !== debris);
  const suggest = models.length > 0 ? '可切换到：' + models.join('、') : '';
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
  if (validCount + batch > MAX_ATTACHMENTS) return '最多 ' + MAX_ATTACHMENTS + ' 张图片';
  if (!looksImage(file)) return '仅支持 PNG / JPEG / WebP / GIF';
  if (file.size > MAX_ATTACHMENT_BYTES) return '单张不超过 ' + fmtBytes(MAX_ATTACHMENT_BYTES);
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

/** 三入口公共落点：先校验、再**当帧**入列（异步摘要不阻塞渲染）。返回被拒条数。 */
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
    list.push({ file, name: file.name || '图片', url: objectUrl(file), bytes: file.size, id: '', error });
    void attachId(list[list.length - 1] as PendingAttachment, key);
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

/** R3 W838-F2：有附件根本没读出来 —— 抛错中止发送，绝不发一个缺图的请求。 */
export class AttachmentReadError extends Error {
  readonly names: readonly string[];
  constructor(names: readonly string[]) {
    super('图片读取失败（' + (names.join('、') || '未知文件') + '），已中止本轮发送');
    this.name = 'AttachmentReadError';
    this.names = names;
  }
}

/** 待发 → 连线格式（内联 base64；与 POST /api/turn 的 attachments 同形）。 */
export async function toWire(items: readonly PendingAttachment[]): Promise<TurnAttachmentInput[]> {
  const out: TurnAttachmentInput[] = [];
  const failed: string[] = [];
  for (const item of items) {
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
  return items.map((it) => ({ name: it.name, url: it.url, bytes: it.bytes }));
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
