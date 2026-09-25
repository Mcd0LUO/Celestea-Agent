// ============================================================================
// ui/inputbar.ts — 输入栏（单一职责）：textarea 自动增高、Enter 发送、
// 发送/取消按钮状态。业务逻辑通过回调交给 chat.ts。
//
// W514 多会话 / 插话契约：
//   - 运行中**不再禁用发送**：Enter/发送 = 注入运行中的轮次（不新开轮）；
//   - worker 模式（W866）：worker 会话视图**可输入可发送** —— 用户的话走
//     POST /api/turn {session:'worker:<sid>'} 投进该 worker 自己的收件箱
//     （与模型 send_message 同一条投递），worker 正常继续；
//   - 发送/取消/停止按钮的显隐真源仍是 setBusy（当前聚焦会话的运行态）。
//
// W515 提交两态（对齐 DSH Agent Inbox 的两条车道）：
//   - Enter / 发送按钮 = 当前车道（默认 steer=插话，next-step 最近 step 边界送达）；
//   - Ctrl/Cmd+Enter = 另一条车道（queue=排队，next-turn 本轮结束后独立投递）；
//   - 输入栏右侧「插话/排队」小切换：只用鼠标也能选车道，文案与占位符随之变化。
// ============================================================================
import { el, need } from '../utils/dom';
import {
  addFiles,
  attachmentsEnabled,
  ATTACHMENT_ACCEPT,
  clearPendingImages,
  imageEntryDisabledReason,
  invalidateAttachmentCapabilities,
  isAttachmentCandidate,
  loadAttachmentCapabilities,
  // W869：文本项读成正文后重绘待发条。pendingList/removePending/renderTray 的消费方
  // 在 W867 拆出的 ./attach-tray.ts（本文件不再直接用）。
  onTextSettled,
} from './attachments';
// W867（追加）：展示夹的落位 / 尺寸 / 渲染接线整段在 ./attach-tray.ts，本文件只调用。
import { createAttachTray, refreshAttachmentTray } from './attach-tray';
import { initQuoteTray } from './quote/tray'; // F1：选段提及的待发引用 chip 收纳区
import { mountCaretMirror, type CaretMirror } from './inputbar/caret-mirror'; // W1525 VSCode 风格光标
import { t } from '../i18n';
import { paintModeButton, paintSendButton } from './inputbar/button-labels';
import { interceptKey as interceptCommandKey } from './commands'; // A3：命令补全框按键拦截
export { refreshAttachmentTray }; // 既有调用方（chat.ts / send.ts / 测试）不变

/**
 * 提交车道：
 *   steer —— next-step：注入运行中轮次的最近 step 边界（插话）
 *   queue —— next-turn：本轮结束后作为下一回合独立投递（排队）
 */
export type SubmitMode = 'steer' | 'queue';

export interface InputBarHandlers {
  /** 发送；text 为原始输入内容（trim/校验由调用方负责），mode = 提交车道。 */
  send(text: string, mode: SubmitMode): void;
  cancel(): void;
}

export type InputMode = 'idle' | 'interject' | 'worker';

const MAX_HEIGHT = 240;
/** 占位符（函数：语言切换后必须跟着变；W846 只说明输入行为，不重复状态词）。 */
function placeholderIdle(): string {
  return t('chat.input.placeholderIdle');
}
function placeholderSteer(): string {
  return t('chat.input.placeholderSteer');
}
function placeholderQueue(): string {
  return t('chat.input.placeholderQueue');
}
/** W866：worker 会话可输入，占位符说明**会送到哪里**。 */
function placeholderWorker(): string {
  return t('chat.input.placeholderWorker');
}

let bar: HTMLElement | null = null;
let inputEl: HTMLTextAreaElement | null = null;
let sendBtn: HTMLButtonElement | null = null;
// W1512：#btnSend 是**发送/终止两态**的同一控件（照 DSH）。终止不再是 statusline 上
// 的独立 #slStop —— 那个位置在窄屏会被挤出视口（用户报障），且与 statusline 抢宽度。
let modeBtn: HTMLButtonElement | null = null;
/** 当前聚焦会话是否运行中（两态按钮的显隐真源）。 */
let busy = false;

/** 当前提交车道（运行中生效；空闲发送一律开新轮）。默认插话（= W514 行为）。 */
let submitMode: SubmitMode = 'steer';
/** 当前输入栏模式（文案/按钮重绘用）。 */
let inputMode: InputMode = 'idle';
/** W1525 假光标（镜像层）。null = 未挂载 / 挂载失败 ⇒ 原生插入符（回落）。 */
let caret: CaretMirror | null = null;

export function getSubmitMode(): SubmitMode {
  return submitMode;
}

export function setSubmitMode(mode: SubmitMode): void {
  submitMode = mode;
  renderSubmitUi();
}

/** 两条车道互切（小切换按钮 / Ctrl+Enter 之外的入口）。 */
export function toggleSubmitMode(): void {
  setSubmitMode(submitMode === 'steer' ? 'queue' : 'steer');
}

/** 车道相关 UI 重绘（切换按钮 / 占位符 / 发送按钮文案）——只改文案与 class。 */
function renderSubmitUi(): void {
  if (modeBtn) paintModeButton(modeBtn, submitMode);
  if (inputEl && inputMode === 'interject') {
    inputEl.placeholder = submitMode === 'steer' ? placeholderSteer() : placeholderQueue();
  }
  // W1512：发送/终止是同一控件的两态，渲染统一走 paintSendButton（W866 的
  // 「按钮不禁用」语义包含在里面）。
  if (sendBtn) paintSendButton(sendBtn, busy, inputMode, submitMode);
}

export function initInputBar(h: InputBarHandlers): void {
  const input = need<HTMLTextAreaElement>('#input');
  inputEl = input;
  bar = need<HTMLElement>('#inputbar');
  sendBtn = need<HTMLButtonElement>('#btnSend');
  modeBtn = document.getElementById('btnMode') as HTMLButtonElement | null;

  const autoGrow = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, MAX_HEIGHT) + 'px';
  };

  // W1512：一个按钮，两个动作。运行中点 = 终止（沿用 #slStop 的单点语义与
  // 「点一次即禁用、防重复取消」的纪律）；空闲点 = 发送。共用 chat.ts requestCancel。
  sendBtn.addEventListener('click', () => {
    if (busy) {
      sendBtn!.disabled = true;
      h.cancel();
      return;
    }
    h.send(input.value, submitMode);
  });
  modeBtn?.addEventListener('click', () => toggleSubmitMode());
  input.addEventListener('keydown', (e) => {
    if (interceptCommandKey(e)) return; // A3：补全框先消费 ↑↓/Enter/Tab/Esc
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    // Ctrl/Cmd+Enter = 另一条车道（两态都要可直达，不必先切按钮）
    const lane: SubmitMode = e.ctrlKey || e.metaKey
      ? submitMode === 'steer'
        ? 'queue'
        : 'steer'
      : submitMode;
    h.send(input.value, lane);
  });
  input.addEventListener('input', autoGrow);
  // W1525：假光标挂 .input-box（它已是 position:relative）。注册在 autoGrow 之后 ——
  // 高度先定，镜像层的裁剪区才对。光标是装饰：任何异常都不许影响输入栏本身。
  try {
    caret = mountCaretMirror(input, bar.querySelector<HTMLElement>('.input-box'));
  } catch {
    caret = null;
  }
  initAttachmentEntries(input, bar);
  renderSubmitUi();
  window.setTimeout(autoGrow, 0);
  window.setTimeout(() => caret?.sync(), 0);
}

/** 发送成功后清空输入框并复位高度。 */
export function clearInput(): void {
  const input = inputEl ?? need<HTMLTextAreaElement>('#input');
  input.value = '';
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, MAX_HEIGHT) + 'px';
  caret?.sync(); // W1525：程序化改值不发 input 事件，显式重绘假光标
}

/** 当前输入框内容（切换会话时保存草稿用）。 */
export function inputValue(): string {
  return inputEl ? inputEl.value : '';
}

/** 写回输入框内容（切换会话恢复草稿 / 插话失败还原）。 */
export function setInputValue(v: string): void {
  const input = inputEl ?? need<HTMLTextAreaElement>('#input');
  input.value = v;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, MAX_HEIGHT) + 'px';
  caret?.sync(); // W1525：同上（恢复草稿 / 插话失败还原）
}

/**
 * 切换「停止」按钮状态（= 当前聚焦会话是否运行中）。
 * W514：**发送按钮不随 busy 禁用**（运行中发送走插话/排队路径）。
 * W846：取消按钮只剩 statusline 的 #slStop（#btnCancel 已移除）。
 */
export function setBusy(next: boolean): void {
  busy = next;
  renderSubmitUi();
}

/** 输入栏模式（空闲 / 插话·排队 / worker）——只切 class 与文案，不重建 DOM。 */
export function setInputMode(mode: InputMode): void {
  inputMode = mode;
  const input = inputEl;
  if (bar) {
    bar.classList.toggle('interject', mode === 'interject');
    bar.classList.toggle('worker', mode === 'worker');
    // W866：#inputbar 上不再有 .readonly —— 任何会话（含 worker）都可输入。
    bar.classList.remove('readonly');
  }
  if (modeBtn) modeBtn.classList.toggle('hidden', mode !== 'interject');
  if (input) {
    input.placeholder =
      mode === 'worker'
        ? placeholderWorker()
        : mode === 'interject'
          ? submitMode === 'steer'
            ? placeholderSteer()
            : placeholderQueue()
          : placeholderIdle();
    input.readOnly = false; // 三种模式都可打字（草稿保活）
  }
  renderSubmitUi();
}

// ---- W805/W869：附件三入口（粘贴 / 拖拽 / 文件选择；图片 + 文本文件） ----------
//   W869：逐文件判定从「image/*」放宽到「图片或文本」，图片仍按图像能力位拦截。

let noteEl: HTMLElement | null = null;
let attachBtn: HTMLButtonElement | null = null;
let fileInput: HTMLInputElement | null = null;

/** W847：内联回形针（常量字面量、无依赖、无 emoji；沿用仓库既有内联 SVG 做法）。 */
const ATTACH_CLIP_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">' +
  '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>';

function barEl(): HTMLElement | null {
  return bar ?? document.getElementById('inputbar');
}

/** 附件入口显隐/禁用文案（能力位就绪、切会话、切模型后重绘）。 */
export function refreshAttachmentEntry(): void {
  const allowed = attachmentsEnabled();
  const reason = imageEntryDisabledReason();
  if (attachBtn) {
    // W869：入口对「文本文件」始终可用（理由见文件头注释），图像能力位降级为按钮提示。
    attachBtn.classList.toggle('hidden', false);
    attachBtn.disabled = false;
    attachBtn.title = reason === '' ? t('chat.input.attachTitle') : reason;
  }
  // 旧服务未声明多模态：只清图片，不清本就可用的文本项（W869）。
  if (!allowed) clearPendingImages();
  refreshAttachmentTray();
}

// R3 W838-F4：保存配置 / 切换模型后能力位可能已变（input_modalities 改动、换模型）——
// 作废缓存并真重拉，再按新模型重绘入口按钮的禁用态与文案。事件由 statusline/config 派发。
window.addEventListener('studio:config-saved', () => {
  invalidateAttachmentCapabilities();
  void loadAttachmentCapabilities().then(refreshAttachmentEntry);
});

function noteAttachment(text: string): void {
  if (!noteEl) return;
  noteEl.textContent = text;
  noteEl.classList.toggle('hidden', text === '');
}

/**
 * W869：图片仍按**图像能力位**在入口拦截（W805 语义不变：不制造必然失败的请求）；
 * 文本文件与能力位无关 —— 任何模型都能读文本，同一批里文本照收、图片给出可执行原因。
 */
function acceptFiles(files: ArrayLike<File>): void {
  const reason = imageEntryDisabledReason();
  const kept: File[] = [];
  let droppedImages = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!f) continue;
    if (reason !== '' && f.type.indexOf('image/') === 0) droppedImages += 1;
    else kept.push(f);
  }
  const rejected = addFiles(kept);
  refreshAttachmentTray();
  if (droppedImages > 0) noteAttachment(reason);
  else if (rejected > 0) noteAttachment(t('chat.input.rejectedCount', { n: rejected }));
}

/** 入口是否收下这个文件：文本文件不看能力位；图片仍要图像能力位可用（W805）。 */
function entryAllows(file: { name: string; type: string }): boolean {
  if (!isAttachmentCandidate(file)) return false;
  return file.type.indexOf('image/') !== 0 || imageEntryDisabledReason() === '';
}

/** 剪贴板里的附件文件（W869：图片或文本文件；MIME 缺失时看扩展名，最终以读出内容为准）。 */
function clipboardFiles(e: Event): File[] {
  const cd = (e as unknown as { clipboardData?: DataTransfer | null }).clipboardData;
  if (!cd) return [];
  const out: File[] = [];
  const items = cd.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it && it.kind === 'file' && entryAllows({ name: '', type: it.type })) {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  if (out.length === 0 && cd.files) {
    for (let i = 0; i < cd.files.length; i++) {
      const f = cd.files[i];
      if (f && entryAllows(f)) out.push(f);
    }
  }
  return out;
}

function dragHasFiles(e: DragEvent): boolean {
  const dt = e.dataTransfer;
  if (!dt) return false;
  if (dt.types && Array.prototype.indexOf.call(dt.types, 'Files') >= 0) return true;
  return !!dt.files && dt.files.length > 0;
}

function acceptFileDialog(): void {
  // W869：选择框始终可点开（文本文件与图像能力位无关）；是否收下由逐文件校验决定。
  const reason = imageEntryDisabledReason();
  if (reason !== '') noteAttachment(reason);
  fileInput?.click();
}

function initAttachmentEntries(input: HTMLTextAreaElement, host: HTMLElement): void {
  noteEl = el('div', 'attach-note hidden');
  const box = host.querySelector<HTMLElement>('.input-box');
  const side = host.querySelector<HTMLElement>('.input-side');
  // W867（追加）：展示夹的建立/挂载/贴位订阅整段在 ui/attach-tray.ts（出流，见该文件顶注）。
  createAttachTray(host, box);
  initQuoteTray(host, box);
  attachBtn = document.createElement('button');
  attachBtn.id = 'btnAttach';
  attachBtn.type = 'button';
  attachBtn.className = 'btn btn-soft btn-icon attach-inline';
  attachBtn.innerHTML = ATTACH_CLIP_SVG; // 内联回形针（常量字面量，无注入面）
  attachBtn.title = t('chat.input.attachTitle');
  attachBtn.setAttribute('aria-label', t('chat.input.attachAria')); // 图标按钮的无障碍名（W869：不再只收图片）
  attachBtn.addEventListener('click', () => acceptFileDialog());
  // W847：优先注入 .input-box（框内左下角、绝对定位）；旧夹具无 .input-box → 回退 .input-side。
  if (box) box.appendChild(attachBtn);
  else if (side && side.firstChild) side.insertBefore(attachBtn, side.firstChild);
  else (side ?? host).appendChild(attachBtn);

  fileInput = document.createElement('input');
  fileInput.id = 'attachInput';
  fileInput.type = 'file';
  fileInput.accept = ATTACHMENT_ACCEPT;
  fileInput.multiple = true;
  fileInput.className = 'attach-file hidden';
  fileInput.addEventListener('change', () => {
    // W869：选择框里的文件逐项判定（文本不看图像能力位，图片由 acceptFiles 按能力位拦截并说明）。
    if (fileInput && fileInput.files) {
      const picked: File[] = [];
      for (let i = 0; i < fileInput.files.length; i++) {
        const f = fileInput.files[i];
        if (f && isAttachmentCandidate(f)) picked.push(f);
      }
      if (picked.length > 0) acceptFiles(picked);
    }
    if (fileInput) fileInput.value = '';
  });

  host.insertBefore(noteEl, host.firstChild);
  host.appendChild(fileInput);

  // 粘贴：有附件文件（图片 / 文本）就收；**不** preventDefault —— 同一次粘贴里的文字照常落进输入框。
  input.addEventListener('paste', (e) => {
    const files = clipboardFiles(e);
    if (files.length > 0) acceptFiles(files);
  });

  document.addEventListener('dragover', (e) => {
    // W869：拖拽入口不再按图像能力位整体关闭（文本文件照收）；逐文件校验在 addFiles。
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    barEl()?.classList.add('drop-active');
  });
  document.addEventListener('dragleave', (e) => {
    if (dragHasFiles(e)) barEl()?.classList.remove('drop-active');
  });
  document.addEventListener('drop', (e) => {
    barEl()?.classList.remove('drop-active');
    const dt = e.dataTransfer;
    if (!dt) return;
    if (!dt.files || dt.files.length === 0) return;
    e.preventDefault();
    acceptFiles(dt.files);
  });

  // W869：文本项读成正文（或判为二进制）后重绘待发条 —— 二进制伪装成 .txt 的那一项
  // 就地标红并给出可见原因，不静默丢弃；图片摘要不改外观，无需重绘。
  onTextSettled(refreshAttachmentTray);

  refreshAttachmentEntry();
  void loadAttachmentCapabilities().then(refreshAttachmentEntry);
}
